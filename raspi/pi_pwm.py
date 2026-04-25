"""
raspi/pi_pwm.py
---------------
Frequency-based trajectory follower + live tracking.

Speed is controlled by varying PWM frequency at a fixed 50% duty cycle.
Direction is controlled by a separate DIR pin.
Stopping is done by setting duty to 0% (zero output regardless of frequency).

This is equivalent to step/dir control: each rising edge at the driver is
one microstep, so frequency = step rate = physical speed.

Modes:
  Trajectory  — physical velocity profile executed in a background thread.
  Tracking    — async loop drives pan frequency from pan_speed floats.
  Orbit       — slide runs a trajectory while pan tracks freely.
  Jog         — slide motor via Viam cloud SDK (set_power / stop).

── Calibration ───────────────────────────────────────────────────────────────

SLIDE_FREQ_PER_IPS = steps/inch (SLIDE_STEPS_PER_INCH) if using a stepper driver.
  For a stepper with 1270 steps/inch: 1 in/s = 1270 Hz  →  SLIDE_FREQ_PER_IPS = 1270
  For a brushed DC motor: run at a known frequency, measure speed, then
    SLIDE_FREQ_PER_IPS = test_frequency_hz / measured_speed_ips

PAN_FREQ_PER_DPS = steps/rev / 360  if using a stepper driver.
  For 8000 steps/rev: 1 deg/s = 22.22 Hz  →  PAN_FREQ_PER_DPS = 22.22

TRACK_PAN_MAX_FREQ — frequency applied at full tracking speed (pan_speed = 1.0).
  Increase to make tracking faster / more aggressive.
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
SLIDE_PWM = 18  # PWM step signal
SLIDE_DIR = 15  # direction (LOW = forward/positive)

# ── Pan Pins (BCM) ────────────────────────────────────────────────────────────
PAN_EN = 8  # enable (active LOW)
PAN_PWM = 12  # PWM step signal
PAN_DIR = 7  # direction (HIGH = forward/positive)

# ── PWM fixed duty ────────────────────────────────────────────────────────────
FIXED_DUTY = 50.0  # % — held constant; frequency encodes speed
INIT_FREQ_HZ = 1.0  # startup frequency (any valid value; duty starts at 0%)

# ── Calibration ───────────────────────────────────────────────────────────────
SLIDE_FREQ_PER_IPS = 2400  # Hz per inch/sec — doubled from SLIDE_STEPS_PER_INCH
# because slider travelled ~half expected distance at 1270;
# tune by comparing programmed vs actual distance:
#   too short → increase, too long → decrease
PAN_FREQ_PER_DPS = 44.44  # Hz per deg/sec  — doubled proportionally (was 22.22)
MIN_FREQ_HZ = 1.0  # floor — avoids 0 Hz which is invalid for GPIO.PWM

# Tracking: pan_speed ∈ [-1, 1] → frequency in [0, TRACK_PAN_MAX_FREQ]
TRACK_PAN_MAX_FREQ = 16000.0  # Hz at pan_speed = 1.0 — tune for tracking speed

# ── Speed deadbands ───────────────────────────────────────────────────────────
SLIDE_SPEED_DEADBAND = 0.0005  # ips — below this the slide stops completely
PAN_SPEED_DEADBAND = 0.05  # dps — below this the pan stops completely

# ── Parasitic compensation ────────────────────────────────────────────────────
SLIDE_STEPS_PER_INCH = 1270
PAN_STEPS_PER_REV = 8000
PAN_STEPS_PER_SLIDE_STEP = 0.4

# Pan degrees that shift per inch of slide travel due to mechanical coupling.
PARASITIC_DEG_PER_IN = (
    SLIDE_STEPS_PER_INCH * PAN_STEPS_PER_SLIDE_STEP / PAN_STEPS_PER_REV
) * 360.0  # ≈ 22.86 deg/in

# ── Trajectory interpolation ──────────────────────────────────────────────────
SUB_STEP_S = 0.002  # 2 ms between frequency updates inside execute_move

# ── Tracking config ───────────────────────────────────────────────────────────
TRACK_UPDATE_INTERVAL = 0.01  # s between frequency writes in tracking_loop
TRACK_TIMEOUT = 0.5  # s — zero pan if no "track" command in this window
TRACK_DEADBAND = 0.01  # pan_speed below this → stop pan

JOG_POWER = 1.0
JOG_STEP_DELAY = 200


# ── GPIO + PWM Objects ────────────────────────────────────────────────────────
slide_pwm: GPIO.PWM | None = None
pan_pwm: GPIO.PWM | None = None


def setup():
    GPIO.setwarnings(False)
    GPIO.setmode(GPIO.BCM)

    GPIO.setup(
        [SLIDE_EN, SLIDE_PWM, SLIDE_DIR, PAN_EN, PAN_PWM, PAN_DIR],
        GPIO.OUT,
    )

    GPIO.output(SLIDE_EN, GPIO.HIGH)  # start disabled — motors free
    GPIO.output(PAN_EN, GPIO.HIGH)
    GPIO.output(SLIDE_DIR, GPIO.LOW)
    GPIO.output(PAN_DIR, GPIO.LOW)

    global slide_pwm, pan_pwm
    slide_pwm = GPIO.PWM(SLIDE_PWM, INIT_FREQ_HZ)
    pan_pwm = GPIO.PWM(PAN_PWM, INIT_FREQ_HZ)
    slide_pwm.start(0)  # duty=0 → no output until we command motion
    pan_pwm.start(0)


def teardown():
    if slide_pwm:
        slide_pwm.ChangeDutyCycle(0)
        slide_pwm.stop()
    if pan_pwm:
        pan_pwm.ChangeDutyCycle(0)
        pan_pwm.stop()
    GPIO.output(SLIDE_EN, GPIO.HIGH)
    GPIO.output(PAN_EN, GPIO.HIGH)
    GPIO.cleanup()


# ── Motor helpers ─────────────────────────────────────────────────────────────
def _set_slide(speed_ips: float):
    """
    Set slide speed in inches/sec (signed).
    Positive = forward (SLIDE_DIR LOW).  Negative = reverse (SLIDE_DIR HIGH).
    Speed = 0 (within deadband) → duty 0%, motor coasts.
    """
    if abs(speed_ips) < SLIDE_SPEED_DEADBAND:
        slide_pwm.ChangeDutyCycle(0)
        return
    freq = max(abs(speed_ips) * SLIDE_FREQ_PER_IPS, MIN_FREQ_HZ)
    GPIO.output(SLIDE_DIR, GPIO.LOW if speed_ips >= 0 else GPIO.HIGH)
    slide_pwm.ChangeFrequency(freq)
    slide_pwm.ChangeDutyCycle(FIXED_DUTY)


def _set_pan(speed_dps: float):
    """
    Set pan speed in degrees/sec (signed).
    Positive = forward (PAN_DIR HIGH).  Negative = reverse (PAN_DIR LOW).
    Speed = 0 (within deadband) → duty 0%, motor coasts.
    """
    if abs(speed_dps) < PAN_SPEED_DEADBAND:
        pan_pwm.ChangeDutyCycle(0)
        return
    freq = max(abs(speed_dps) * PAN_FREQ_PER_DPS, MIN_FREQ_HZ)
    GPIO.output(PAN_DIR, GPIO.HIGH if speed_dps >= 0 else GPIO.LOW)
    pan_pwm.ChangeFrequency(freq)
    pan_pwm.ChangeDutyCycle(FIXED_DUTY)


def _set_pan_tracking(speed_norm: float):
    """
    Set pan speed from a normalised tracking value ∈ [-1, 1].
    Maps linearly to [0, TRACK_PAN_MAX_FREQ].
    """
    if abs(speed_norm) < TRACK_DEADBAND:
        pan_pwm.ChangeDutyCycle(0)
        return
    freq = max(abs(speed_norm) * TRACK_PAN_MAX_FREQ, MIN_FREQ_HZ)
    GPIO.output(PAN_DIR, GPIO.HIGH if speed_norm >= 0 else GPIO.LOW)
    pan_pwm.ChangeFrequency(freq)
    pan_pwm.ChangeDutyCycle(FIXED_DUTY)


# ── Trajectory Compiler ───────────────────────────────────────────────────────
def compile_trajectory(json_data: dict) -> list[dict]:
    """
    Convert a pre-baked JSON trajectory into physical velocity waypoints.

    Each waypoint:
        {
          "t":         float,   # wall-clock time from move start (s)
          "slide_ips": float,   # slide velocity (inches/sec, signed)
          "pan_dps":   float,   # pan velocity after parasitic comp (deg/sec, signed)
        }

    Velocities are computed via central difference (smoother than frame deltas).
    execute_move linearly interpolates between waypoints at SUB_STEP_S intervals
    and calls _set_slide / _set_pan which convert physical speed → frequency.

    Parasitic compensation: slide motion physically rotates the pan axis by
    PARASITIC_DEG_PER_IN deg/in — subtracted from the commanded pan velocity.
    """
    fps = json_data["fps"]
    frame_dur = 1.0 / fps
    tracks = json_data["tracks"]
    slide_pos = tracks["slide"]  # absolute inches per frame
    pan_pos = tracks["pan"]  # absolute degrees per frame
    N = len(slide_pos)

    waypoints = []

    for i in range(N):
        t = i * frame_dur

        # Slide velocity (in/s) — central difference
        if i == 0:
            slide_ips = (slide_pos[1] - slide_pos[0]) / frame_dur
        elif i == N - 1:
            slide_ips = (slide_pos[N - 1] - slide_pos[N - 2]) / frame_dur
        else:
            slide_ips = (slide_pos[i + 1] - slide_pos[i - 1]) / (2.0 * frame_dur)

        # Pan velocity (deg/s) — central difference
        if i == 0:
            pan_dps_raw = (pan_pos[1] - pan_pos[0]) / frame_dur
        elif i == N - 1:
            pan_dps_raw = (pan_pos[N - 1] - pan_pos[N - 2]) / frame_dur
        else:
            pan_dps_raw = (pan_pos[i + 1] - pan_pos[i - 1]) / (2.0 * frame_dur)

        # Subtract parasitic pan rotation due to slide translation
        pan_dps = pan_dps_raw - slide_ips * PARASITIC_DEG_PER_IN

        waypoints.append({"t": t, "slide_ips": slide_ips, "pan_dps": pan_dps})

    return waypoints


# ── Trajectory Execution ──────────────────────────────────────────────────────
def execute_move(waypoints: list[dict], locks: dict):
    """
    Stream through velocity waypoints, linearly interpolating physical speed at
    SUB_STEP_S (2 ms) intervals and updating PWM frequency each step.
    Blocks the calling thread for the full duration of the move.

    Only enables motors for axes present in `locks`.
    Checks `estop` on every sub-step and aborts cleanly if triggered.
    """
    global estop

    if locks.get("slide"):
        GPIO.output(SLIDE_EN, GPIO.LOW)
    if locks.get("pan"):
        GPIO.output(PAN_EN, GPIO.LOW)

    start = time.perf_counter()

    for i in range(len(waypoints) - 1):
        if estop:
            break

        wp0 = waypoints[i]
        wp1 = waypoints[i + 1]
        t0 = wp0["t"]
        t1 = wp1["t"]
        dur = t1 - t0

        t_sub = t0
        while t_sub < t1:
            if estop:
                break

            # Busy-wait until this sub-step's fire time
            while time.perf_counter() - start < t_sub:
                if estop:
                    break

            if estop:
                break

            # Linearly interpolate physical velocity between the two waypoints
            alpha = (t_sub - t0) / dur if dur > 0 else 0.0
            slide_ips = wp0["slide_ips"] + alpha * (wp1["slide_ips"] - wp0["slide_ips"])
            pan_dps = wp0["pan_dps"] + alpha * (wp1["pan_dps"] - wp0["pan_dps"])

            if locks.get("slide"):
                _set_slide(slide_ips)
            if locks.get("pan"):
                _set_pan(pan_dps)

            t_sub += SUB_STEP_S

    # Always stop and disable on exit
    slide_pwm.ChangeDutyCycle(0)
    pan_pwm.ChangeDutyCycle(0)
    GPIO.output(SLIDE_EN, GPIO.HIGH)
    GPIO.output(PAN_EN, GPIO.HIGH)
    estop = False


# ── Global State ──────────────────────────────────────────────────────────────
trajectory_waypoints = []
motor_locks = {"slide": False, "pan": False, "tilt": False}
current_pan_speed = 0.0  # normalised [-1, 1] from hub
last_track_time = 0.0
estop = False


# ── Async Tracking Loop ───────────────────────────────────────────────────────
async def tracking_loop():
    """
    Background task: drives pan frequency from current_pan_speed ∈ [-1, 1].
    Yields on every iteration to keep the WebSocket listener responsive.
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
        _set_pan_tracking(speed)
        await asyncio.sleep(TRACK_UPDATE_INTERVAL)


# ── WebSocket Bridge ──────────────────────────────────────────────────────────
async def listen_to_hub(uri: str, machine):
    global trajectory_waypoints, current_pan_speed, last_track_time, estop

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

                    if command == "save_trajectory":
                        print("📥  Trajectory received — compiling...")
                        trajectory_waypoints = compile_trajectory(data)
                        total_s = trajectory_waypoints[-1]["t"]
                        print(
                            f"    Compiled: {len(trajectory_waypoints):,} waypoints  "
                            f"duration={total_s:.2f}s\n"
                        )

                    elif command == "execute_move":
                        if not trajectory_waypoints:
                            print(
                                "WARN: execute_move — no trajectory loaded, ignoring.\n"
                            )
                            continue

                        orbit = data.get("orbit", False)

                        if orbit:
                            waypoints = [
                                {**wp, "pan_dps": 0.0} for wp in trajectory_waypoints
                            ]
                            exec_locks = {"slide": True, "pan": False, "tilt": False}
                        else:
                            waypoints = trajectory_waypoints
                            exec_locks = {"slide": True, "pan": True, "tilt": False}

                        estop = False
                        motor_locks.update(exec_locks)
                        print(
                            f"🚀  Executing move  orbit={orbit}  locks={exec_locks}\n"
                        )

                        async def _run_trajectory(
                            _wps=waypoints, _locks=exec_locks, _ws=ws
                        ):
                            await asyncio.to_thread(execute_move, _wps, _locks)
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

                    elif command == "lock_slide":
                        estop = False
                        print("🔒  Slide locked (tracking / orbit mode)")
                        GPIO.output(SLIDE_EN, GPIO.LOW)

                    elif command == "unlock_slide":
                        print("🔓  Slide unlocked")
                        GPIO.output(SLIDE_EN, GPIO.HIGH)

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
