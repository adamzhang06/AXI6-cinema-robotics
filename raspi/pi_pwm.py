"""
raspi/pi_pwm.py
---------------
PWM-based trajectory follower + live tracking.

Drop-in structural replacement for pi_follower.py that drives motors via
GPIO.PWM duty-cycle instead of step/dir pulse trains.  All WebSocket
commands, motor_locks semantics, and Viam jog support are preserved.

Modes:
  Trajectory  — velocity profile derived from JSON executed in a background
                thread; sets PWM duty cycle per interpolated segment.
  Tracking    — async loop drives pan PWM duty cycle from pan_speed floats.
  Orbit       — slide runs a trajectory while pan tracks freely.
  Jog         — slide motor via Viam cloud SDK (set_power / stop).

TODO (tuning):
  - Set PWM_FREQUENCY to match your motor driver's preferred frequency.
  - Set MAX_DUTY to the maximum safe duty cycle (often < 100 if driver needs headroom).
  - Calibrate SLIDE_STEPS_PER_INCH / PAN_STEPS_PER_REV if you re-add position tracking.
  - Decide on H-bridge wiring: separate DIR pin per axis, or dual PWM (FWD/REV pins).
"""

import asyncio
import json
import os
import sys
import time

import RPi.GPIO as GPIO
import websockets
from dotenv import load_dotenv
from viam.robot.client import RobotClient
from viam.components.motor import Motor

# ── Viam Cloud ────────────────────────────────────────────────────────────────
VIAM_API_KEY = "rrlkbr70e4rmzm1p91eeyum9tzq559qr"
VIAM_API_KEY_ID = "4d649e48-b9b9-4551-9890-d3bcfe640d4a"
VIAM_ADDRESS = "axi6-main.40ro1hz53b.viam.cloud"
SLIDE_MOTOR_NAME = "slide_motor"


async def connect_viam():
    opts = RobotClient.Options.with_api_key(
        api_key=VIAM_API_KEY,
        api_key_id=VIAM_API_KEY_ID,
    )
    print("Connecting to Viam cloud...")
    machine = await RobotClient.at_address(VIAM_ADDRESS, opts)
    print("✅  Viam connected.\n")
    return machine


# ── Slide Pins (BCM) ──────────────────────────────────────────────────────────
SLIDE_EN = 14  # enable (active LOW)
SLIDE_PWM = 18  # PWM speed signal  TODO: rewire to your H-bridge PWM input
SLIDE_DIR = 15  # direction

# ── Pan Pins (BCM) ────────────────────────────────────────────────────────────
PAN_EN = 8  # enable (active LOW)
PAN_PWM = 12  # PWM speed signal   TODO: rewire to your H-bridge PWM input
PAN_DIR = 7  # direction

# ── PWM Config ────────────────────────────────────────────────────────────────
PWM_FREQUENCY = 1000  # Hz — TODO: tune for your driver (1 kHz is a safe start)
MAX_DUTY = 100.0  # % — TODO: lower if driver/motor needs a ceiling

# ── Trajectory Config ─────────────────────────────────────────────────────────
SLIDE_STEPS_PER_INCH = 1270  # kept for velocity calculation (units/s → duty %)
PAN_STEPS_PER_REV = 8000
PAN_STEPS_PER_SLIDE_STEP = 0.4  # parasitic compensation

# ── Tracking Config ───────────────────────────────────────────────────────────
TRACK_UPDATE_INTERVAL = 0.01  # s between duty-cycle writes in tracking_loop
TRACK_TIMEOUT = 0.5  # s — zero speed if no "track" command received
TRACK_DEADBAND = 0.01  # speeds below this treated as zero

JOG_POWER = 1.0  # Viam slide jog power (0.0–1.0)
JOG_STEP_DELAY = 200  # µs passed to Viam motor extra param


# ── GPIO + PWM Objects ────────────────────────────────────────────────────────
slide_pwm: GPIO.PWM | None = None
pan_pwm: GPIO.PWM | None = None


def setup():
    GPIO.setwarnings(False)
    GPIO.setmode(GPIO.BCM)

    GPIO.setup([SLIDE_EN, SLIDE_PWM, SLIDE_DIR, PAN_EN, PAN_PWM, PAN_DIR], GPIO.OUT)

    # Start disabled — motors free to move by hand
    GPIO.output(SLIDE_EN, GPIO.HIGH)
    GPIO.output(PAN_EN, GPIO.HIGH)
    GPIO.output(SLIDE_DIR, GPIO.LOW)
    GPIO.output(PAN_DIR, GPIO.LOW)

    global slide_pwm, pan_pwm
    slide_pwm = GPIO.PWM(SLIDE_PWM, PWM_FREQUENCY)
    pan_pwm = GPIO.PWM(PAN_PWM, PWM_FREQUENCY)
    slide_pwm.start(0)
    pan_pwm.start(0)


def teardown():
    if slide_pwm:
        slide_pwm.stop()
    if pan_pwm:
        pan_pwm.stop()
    GPIO.output(SLIDE_EN, GPIO.HIGH)
    GPIO.output(PAN_EN, GPIO.HIGH)
    GPIO.cleanup()


# ── Helpers ───────────────────────────────────────────────────────────────────
def _set_slide(speed: float):
    """speed in [-1.0, 1.0]; sets direction pin and duty cycle."""
    GPIO.output(SLIDE_DIR, GPIO.LOW if speed >= 0 else GPIO.HIGH)
    slide_pwm.ChangeDutyCycle(min(abs(speed) * MAX_DUTY, MAX_DUTY))


def _set_pan(speed: float):
    """speed in [-1.0, 1.0]; sets direction pin and duty cycle."""
    GPIO.output(PAN_DIR, GPIO.HIGH if speed >= 0 else GPIO.LOW)
    pan_pwm.ChangeDutyCycle(min(abs(speed) * MAX_DUTY, MAX_DUTY))


# ── Trajectory Compiler ───────────────────────────────────────────────────────
def compile_trajectory(json_data):
    """
    Convert a pre-baked JSON trajectory into a list of velocity segments.

    Each segment:
        {
          't':           float,  # wall-clock start time (s from move start)
          'slide_speed': float,  # normalised [-1, 1] (positive = forward)
          'pan_speed':   float,  # normalised [-1, 1]
          'duration':    float,  # how long to hold this duty cycle (s)
        }

    The executor sets duty cycle at segment start and lets it run for
    `duration` before moving to the next segment.  Sub-frame interpolation
    can be added here by splitting segments further.

    TODO: replace with a proper velocity profile if you have encoder feedback.
    """
    fps = json_data["fps"]
    frame_dur = 1.0 / fps
    tracks = json_data["tracks"]
    slide_pos = tracks["slide"]  # absolute inches per frame
    pan_pos = tracks["pan"]  # absolute degrees per frame

    # Precompute peak velocities so we can normalise duty cycles.
    # TODO: replace with actual motor max-speed calibration.
    slide_velocities = [
        (slide_pos[i] - slide_pos[i - 1]) * SLIDE_STEPS_PER_INCH / frame_dur
        for i in range(1, len(slide_pos))
    ]
    pan_velocities = [
        ((pan_pos[i] - pan_pos[i - 1]) / 360.0) * PAN_STEPS_PER_REV / frame_dur
        for i in range(1, len(pan_pos))
    ]

    max_slide_v = max((abs(v) for v in slide_velocities), default=1.0) or 1.0
    max_pan_v = max((abs(v) for v in pan_velocities), default=1.0) or 1.0

    segments = []
    for i in range(1, len(slide_pos)):
        t_start = (i - 1) * frame_dur

        slide_delta = slide_pos[i] - slide_pos[i - 1]
        pan_delta = pan_pos[i] - pan_pos[i - 1]

        slide_v = slide_delta * SLIDE_STEPS_PER_INCH / frame_dur
        pan_v = (
            pan_delta / 360.0
        ) * PAN_STEPS_PER_REV / frame_dur - slide_v * PAN_STEPS_PER_SLIDE_STEP

        segments.append(
            {
                "t": t_start,
                "slide_speed": slide_v / max_slide_v,
                "pan_speed": pan_v / max_pan_v,
                "duration": frame_dur,
            }
        )

    return segments


# ── Trajectory Execution ──────────────────────────────────────────────────────
def execute_move(segments, locks):
    """
    Walk through velocity segments, setting PWM duty cycles in real time.
    Blocks the calling thread for the full duration of the move.

    Only enables/disables motors for axes present in `locks`.
    Checks `estop` before each segment; aborts cleanly if triggered.
    """
    global estop

    if locks.get("slide"):
        GPIO.output(SLIDE_EN, GPIO.LOW)
    if locks.get("pan"):
        GPIO.output(PAN_EN, GPIO.LOW)

    start = time.perf_counter()

    for seg in segments:
        if estop:
            break

        # Busy-wait until segment start time
        while time.perf_counter() - start < seg["t"]:
            if estop:
                break
            pass

        if estop:
            break

        if locks.get("slide"):
            _set_slide(seg["slide_speed"])
        if locks.get("pan"):
            _set_pan(seg["pan_speed"])

        # Hold until segment end (simple open-loop; add encoder PID here)
        seg_end = seg["t"] + seg["duration"]
        while time.perf_counter() - start < seg_end:
            if estop:
                break
            pass

    # Always stop and disable on exit
    slide_pwm.ChangeDutyCycle(0)
    pan_pwm.ChangeDutyCycle(0)
    GPIO.output(SLIDE_EN, GPIO.HIGH)
    GPIO.output(PAN_EN, GPIO.HIGH)
    estop = False


# ── Global State ──────────────────────────────────────────────────────────────
trajectory_segments = []  # compiled velocity segments
motor_locks = {"slide": False, "pan": False, "tilt": False}
current_pan_speed = 0.0  # [-1.0, 1.0] written by WebSocket, read by tracking_loop
last_track_time = 0.0
estop = False


# ── Async Tracking Loop ───────────────────────────────────────────────────────
async def tracking_loop():
    """
    Background task: updates PAN PWM duty cycle from current_pan_speed.

    Yields on every iteration so the WebSocket listener stays responsive.
    Zeros speed automatically if no "track" command arrives within TRACK_TIMEOUT.
    Pauses when motor_locks["pan"] is True (pan owned by trajectory).
    """
    global current_pan_speed, last_track_time

    while True:
        if motor_locks["pan"]:
            await asyncio.sleep(0.01)
            continue

        if time.time() - last_track_time > TRACK_TIMEOUT:
            current_pan_speed = 0.0

        speed = current_pan_speed
        if abs(speed) < TRACK_DEADBAND:
            pan_pwm.ChangeDutyCycle(0)
            GPIO.output(PAN_EN, GPIO.HIGH)  # free motor when idle
            await asyncio.sleep(TRACK_UPDATE_INTERVAL)
            continue

        GPIO.output(PAN_EN, GPIO.LOW)
        _set_pan(speed)
        await asyncio.sleep(TRACK_UPDATE_INTERVAL)


# ── WebSocket Bridge ──────────────────────────────────────────────────────────
async def listen_to_hub(uri: str, machine):
    """
    Persistent WebSocket connection to the FastAPI hub.  Reconnects on drop.

    Jog commands  → Viam cloud (slide only).
    Track command → updates current_pan_speed for tracking_loop.
    Trajectory    → PWM velocity segments via execute_move() in a background thread.
    """
    global trajectory_segments, current_pan_speed, last_track_time, estop

    slide_motor = Motor.from_robot(machine, SLIDE_MOTOR_NAME)

    while True:
        try:
            print(f"Connecting to hub at {uri} ...")
            async with websockets.connect(uri) as ws:
                print("Connected to hub — waiting for commands.\n")
                async for raw in ws:
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        print(f"WARN: received non-JSON message: {raw!r}")
                        continue

                    command = data.get("command", "")

                    # ── Trajectory commands ───────────────────────────────
                    if command == "save_trajectory":
                        print("📥  Trajectory received — compiling...")
                        trajectory_segments = compile_trajectory(data)
                        print(f"    Compiled: {len(trajectory_segments):,} segments\n")

                    elif command == "execute_move":
                        if not trajectory_segments:
                            print(
                                "WARN: execute_move — no trajectory loaded, ignoring.\n"
                            )
                            continue

                        orbit = data.get("orbit", False)

                        # In orbit mode strip pan from the segment velocities so the
                        # tracking_loop can drive pan freely via CSRT.
                        if orbit:
                            segs = [
                                {**s, "pan_speed": 0.0} for s in trajectory_segments
                            ]
                            exec_locks = {"slide": True, "pan": False, "tilt": False}
                        else:
                            segs = trajectory_segments
                            exec_locks = {"slide": True, "pan": True, "tilt": False}

                        estop = False
                        motor_locks.update(exec_locks)
                        print(
                            f"🚀  Executing move  orbit={orbit}  locks={exec_locks}\n"
                        )

                        async def _run_trajectory(
                            _segs=segs, _locks=exec_locks, _ws=ws
                        ):
                            await asyncio.to_thread(execute_move, _segs, _locks)
                            motor_locks["slide"] = False
                            motor_locks["pan"] = False
                            motor_locks["tilt"] = False
                            print("Done.\n")
                            try:
                                await _ws.send(
                                    json.dumps({"command": "trajectory_complete"})
                                )
                                print("📡  Sent trajectory_complete to hub.\n")
                            except Exception:
                                pass

                        asyncio.create_task(_run_trajectory())

                    # ── Jog commands (Viam cloud — slide only) ────────────
                    elif command == "start_jog":
                        axis = data.get("axis", "")
                        if motor_locks.get(axis, False):
                            print(
                                f"WARN: jog ignored — {axis} is locked by trajectory.\n"
                            )
                            continue
                        direction = float(data.get("direction", 0))
                        print(f"🕹  start_jog  axis={axis}  direction={direction:+.0f}")
                        if axis == "slide":
                            await slide_motor.set_power(
                                -direction * JOG_POWER,
                                extra={"step_delay": JOG_STEP_DELAY},
                            )
                        else:
                            print(f"WARN: unknown jog axis {axis!r}\n")

                    elif command == "stop_jog":
                        axis = data.get("axis", "")
                        if motor_locks.get(axis, False):
                            continue
                        print(f"⏹  stop_jog  axis={axis}")
                        if axis == "slide":
                            await slide_motor.stop()
                        else:
                            print(f"WARN: unknown stop axis {axis!r}\n")

                    # ── Slide lock / unlock (tracking / orbit mode) ───────
                    elif command == "lock_slide":
                        estop = False
                        print("🔒  Slide locked (tracking / orbit mode)")
                        GPIO.output(SLIDE_EN, GPIO.LOW)

                    elif command == "unlock_slide":
                        print("🔓  Slide unlocked")
                        GPIO.output(SLIDE_EN, GPIO.HIGH)

                    # ── Emergency stop ────────────────────────────────────
                    elif command == "emergency_stop":
                        print("🛑  EMERGENCY STOP")
                        estop = True
                        current_pan_speed = 0.0
                        motor_locks["slide"] = False
                        motor_locks["pan"] = False
                        motor_locks["tilt"] = False
                        slide_pwm.ChangeDutyCycle(0)
                        pan_pwm.ChangeDutyCycle(0)
                        GPIO.output(SLIDE_EN, GPIO.HIGH)
                        GPIO.output(PAN_EN, GPIO.HIGH)
                        try:
                            await slide_motor.stop()
                        except Exception:
                            pass
                        print("🛑  All motors stopped and freed.\n")

                    # ── Tracking command (hub → pan PWM) ──────────────────
                    elif command == "track":
                        if motor_locks["pan"] or estop:
                            continue
                        current_pan_speed = float(data.get("pan_speed", 0.0))
                        last_track_time = time.time()

                    else:
                        print(f"WARN: unknown command: {command!r}\n")

        except (OSError, websockets.exceptions.WebSocketException) as exc:
            print(f"Connection lost ({exc}) — retrying in 3 s...\n")
            current_pan_speed = 0.0
            motor_locks["slide"] = False
            motor_locks["pan"] = False
            motor_locks["tilt"] = False
            await asyncio.sleep(3)


# ── Entry Point ───────────────────────────────────────────────────────────────
async def main_async(uri: str):
    machine = await connect_viam()
    try:
        asyncio.create_task(tracking_loop())
        await listen_to_hub(uri, machine)
    finally:
        await machine.close()


if __name__ == "__main__":
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

    uri = os.getenv("FASTAPI_WS_URI")
    if not uri:
        print("ERROR: FASTAPI_WS_URI is not set.")
        print("  Create raspi/.env and add:  FASTAPI_WS_URI=ws://<host>:8000/ws/pi")
        sys.exit(1)

    setup()
    try:
        asyncio.run(main_async(uri))
    except KeyboardInterrupt:
        print("\nAborted.")
    finally:
        teardown()
