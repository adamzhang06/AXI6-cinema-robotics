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

── Calibration guide ────────────────────────────────────────────────────────

STEP 1 — find MIN_DUTY (stiction threshold):
  Run: python raspi/tests/test_pwm.py --ramp --duty 60 --axis slide
  Watch for the duty % at which the motor FIRST starts to move.
  Set SLIDE_MIN_DUTY to that value (typically 15–35%).

STEP 2 — find SLIDE_DUTY_PER_IPS:
  Run the slide at MAX_DUTY for exactly 2 seconds:
    python raspi/tests/test_pwm.py --axis slide --duty 100 --duration 2
  Measure the distance traveled (inches).
  Set SLIDE_DUTY_PER_IPS = 100.0 / (distance / 2.0)
  Example: motor travels 20 in in 2 s → max speed = 10 ips
           SLIDE_DUTY_PER_IPS = 100 / 10 = 10.0

STEP 3 — sanity check with a trajectory:
  Program a move of known distance at a moderate speed.
  If motor arrives early  → increase SLIDE_DUTY_PER_IPS
  If motor arrives late   → decrease SLIDE_DUTY_PER_IPS

The math:  duty(%) = velocity(in/s) × SLIDE_DUTY_PER_IPS
  At calibrated max speed the result is exactly MAX_DUTY.
  Faster requests are clamped to MAX_DUTY.
  Slower requests get proportionally less duty (but at least MIN_DUTY).
"""

import asyncio
import json
import math
import os
import sys
import time

import RPi.GPIO as GPIO
import websockets
from dotenv import load_dotenv
from viam.robot.client import RobotClient
from viam.components.motor import Motor

# ── Viam Cloud ────────────────────────────────────────────────────────────────
VIAM_API_KEY    = "rrlkbr70e4rmzm1p91eeyum9tzq559qr"
VIAM_API_KEY_ID = "4d649e48-b9b9-4551-9890-d3bcfe640d4a"
VIAM_ADDRESS    = "axi6-main.40ro1hz53b.viam.cloud"
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
SLIDE_EN  = 14   # enable (active LOW)
SLIDE_PWM = 18   # PWM speed signal
SLIDE_DIR = 15   # direction (LOW = forward/positive)

# ── Pan Pins (BCM) ────────────────────────────────────────────────────────────
PAN_EN  = 8    # enable (active LOW)
PAN_PWM = 12   # PWM speed signal
PAN_DIR = 7    # direction (HIGH = forward/positive)

# ── PWM Config ────────────────────────────────────────────────────────────────
PWM_FREQUENCY = 1000   # Hz — tune for your driver
MAX_DUTY      = 100.0  # % — lower if driver needs headroom

# ── Motor calibration ────────────────────────────────────────────────────────
# These are the ONLY two numbers you need to measure (see guide in docstring).
#
# SLIDE_DUTY_PER_IPS  = MAX_DUTY / (max_speed_inches_per_sec)
#   e.g. motor does 10 in/s at 100%  →  100/10 = 10.0
#        motor does 40 in/s at 100%  →  100/40 = 2.5
#
# PAN_DUTY_PER_DPS  = MAX_DUTY / (max_speed_degrees_per_sec)
#
# Tuning shortcut: run a known trajectory and watch the result.
#   motor arrives TOO EARLY (moves faster than commanded) → DECREASE the constant
#   motor arrives TOO LATE  (moves slower than commanded) → INCREASE the constant
SLIDE_DUTY_PER_IPS = 10.0   # TODO: set to MAX_DUTY / measured_max_speed_ips
PAN_DUTY_PER_DPS   = 1.0    # TODO: set to MAX_DUTY / measured_max_speed_dps

# ── Stiction / minimum duty ───────────────────────────────────────────────────
# DC motors don't respond below a minimum duty due to static friction.
# Any non-zero commanded duty below MIN_DUTY is floored to MIN_DUTY so the
# motor actually starts.  Measure via the ramp test (see calibration guide).
SLIDE_MIN_DUTY = 20.0   # TODO: find empirically — typical range 15–35%
PAN_MIN_DUTY   = 20.0
DUTY_DEADBAND  = 0.5    # duties below this are treated as zero (motor stopped)

# ── Parasitic compensation (same physical constants as pi_follower.py) ────────
SLIDE_STEPS_PER_INCH     = 1270
PAN_STEPS_PER_REV        = 8000
PAN_STEPS_PER_SLIDE_STEP = 0.4

# Derived: pan degrees that shift per inch of slide travel due to coupling.
# = (slide_steps/in × pan_steps/slide_step / pan_steps/rev) × 360 deg/rev
PARASITIC_DEG_PER_IN = (
    SLIDE_STEPS_PER_INCH * PAN_STEPS_PER_SLIDE_STEP / PAN_STEPS_PER_REV
) * 360.0   # ≈ 22.86 deg/in

# ── Trajectory execution ──────────────────────────────────────────────────────
SUB_STEP_S = 0.002   # 2 ms — interpolation interval inside execute_move
                     # gives 500 duty-cycle updates/sec vs 24 updates/sec raw

# ── Tracking Config ───────────────────────────────────────────────────────────
TRACK_UPDATE_INTERVAL = 0.01   # s between duty-cycle writes in tracking_loop
TRACK_TIMEOUT         = 0.5    # s — zero speed if no "track" command received
TRACK_DEADBAND        = 0.01   # speeds below this treated as zero

JOG_POWER    = 1.0   # Viam slide jog power (0.0–1.0)
JOG_STEP_DELAY = 200  # µs passed to Viam motor extra param


# ── GPIO + PWM Objects ────────────────────────────────────────────────────────
slide_pwm: GPIO.PWM | None = None
pan_pwm:   GPIO.PWM | None = None


def setup():
    GPIO.setwarnings(False)
    GPIO.setmode(GPIO.BCM)

    GPIO.setup(
        [SLIDE_EN, SLIDE_PWM, SLIDE_DIR, PAN_EN, PAN_PWM, PAN_DIR],
        GPIO.OUT,
    )

    GPIO.output(SLIDE_EN,  GPIO.HIGH)   # start disabled — motors free
    GPIO.output(PAN_EN,    GPIO.HIGH)
    GPIO.output(SLIDE_DIR, GPIO.LOW)
    GPIO.output(PAN_DIR,   GPIO.LOW)

    global slide_pwm, pan_pwm
    slide_pwm = GPIO.PWM(SLIDE_PWM, PWM_FREQUENCY)
    pan_pwm   = GPIO.PWM(PAN_PWM,   PWM_FREQUENCY)
    slide_pwm.start(0)
    pan_pwm.start(0)


def teardown():
    if slide_pwm:
        slide_pwm.stop()
    if pan_pwm:
        pan_pwm.stop()
    GPIO.output(SLIDE_EN, GPIO.HIGH)
    GPIO.output(PAN_EN,   GPIO.HIGH)
    GPIO.cleanup()


# ── Motor helpers ─────────────────────────────────────────────────────────────
def _apply_stiction(magnitude: float, min_duty: float) -> float:
    """
    Given a raw duty magnitude (already ≥ 0), apply the stiction floor:
      - below DUTY_DEADBAND  → 0   (motor fully stopped)
      - between deadband and min_duty → min_duty  (floor to overcome friction)
      - above min_duty       → clamped to MAX_DUTY
    """
    if magnitude < DUTY_DEADBAND:
        return 0.0
    return min(max(magnitude, min_duty), MAX_DUTY)


def _set_slide(duty: float):
    """
    duty in [-MAX_DUTY, MAX_DUTY].
    Positive = forward (SLIDE_DIR LOW).  Negative = reverse (SLIDE_DIR HIGH).
    Direction pin is set before duty so the H-bridge never sees wrong-direction power.
    Applies stiction floor: any non-zero request gets at least SLIDE_MIN_DUTY.
    """
    magnitude = _apply_stiction(abs(duty), SLIDE_MIN_DUTY)
    GPIO.output(SLIDE_DIR, GPIO.LOW if duty >= 0 else GPIO.HIGH)
    slide_pwm.ChangeDutyCycle(magnitude)


def _set_pan(duty: float):
    """
    duty in [-MAX_DUTY, MAX_DUTY].
    Positive = forward (PAN_DIR HIGH).  Negative = reverse (PAN_DIR LOW).
    Applies stiction floor: any non-zero request gets at least PAN_MIN_DUTY.
    """
    magnitude = _apply_stiction(abs(duty), PAN_MIN_DUTY)
    GPIO.output(PAN_DIR, GPIO.HIGH if duty >= 0 else GPIO.LOW)
    pan_pwm.ChangeDutyCycle(magnitude)


def _speed_to_pan_duty(speed: float) -> float:
    """Normalised tracking speed [-1, 1] → signed duty [-MAX_DUTY, MAX_DUTY]."""
    return math.copysign(min(abs(speed) * MAX_DUTY, MAX_DUTY), speed)


# ── Trajectory Compiler ───────────────────────────────────────────────────────
def compile_trajectory(json_data: dict) -> list[dict]:
    """
    Convert a pre-baked JSON trajectory into a list of velocity waypoints.

    Each waypoint:
        {
          "t":           float,   # wall-clock time from move start (s)
          "slide_duty":  float,   # signed duty in [-MAX_DUTY, MAX_DUTY]
          "pan_duty":    float,   # signed duty in [-MAX_DUTY, MAX_DUTY]
        }

    Velocity is estimated using central differences (smoother than frame-to-frame
    deltas), converted to physical units, then scaled to duty % via the calibration
    constants.  execute_move linearly interpolates between consecutive waypoints at
    SUB_STEP_S (2 ms) intervals for smooth motion.

    Parasitic compensation mirrors pi_follower.py: a slide translation physically
    rotates the pan axis by PARASITIC_DEG_PER_IN degrees per inch — we subtract
    that from the commanded pan velocity.
    """
    fps       = json_data["fps"]
    frame_dur = 1.0 / fps
    tracks    = json_data["tracks"]
    slide_pos = tracks["slide"]   # absolute inches, one value per frame
    pan_pos   = tracks["pan"]     # absolute degrees, one value per frame
    N         = len(slide_pos)

    waypoints = []

    for i in range(N):
        t = i * frame_dur

        # ── Slide velocity (inches/sec) via central difference ─────────────
        if i == 0:
            slide_v_ips = (slide_pos[1] - slide_pos[0]) / frame_dur
        elif i == N - 1:
            slide_v_ips = (slide_pos[N - 1] - slide_pos[N - 2]) / frame_dur
        else:
            slide_v_ips = (slide_pos[i + 1] - slide_pos[i - 1]) / (2.0 * frame_dur)

        # ── Pan velocity (degrees/sec) via central difference ─────────────
        if i == 0:
            pan_v_dps_raw = (pan_pos[1] - pan_pos[0]) / frame_dur
        elif i == N - 1:
            pan_v_dps_raw = (pan_pos[N - 1] - pan_pos[N - 2]) / frame_dur
        else:
            pan_v_dps_raw = (pan_pos[i + 1] - pan_pos[i - 1]) / (2.0 * frame_dur)

        # ── Subtract parasitic pan rotation caused by slide translation ───
        pan_v_dps = pan_v_dps_raw - slide_v_ips * PARASITIC_DEG_PER_IN

        # ── Convert physical velocities → duty % via calibration ──────────
        slide_duty = math.copysign(
            min(abs(slide_v_ips) * SLIDE_DUTY_PER_IPS, MAX_DUTY), slide_v_ips
        )
        pan_duty = math.copysign(
            min(abs(pan_v_dps) * PAN_DUTY_PER_DPS, MAX_DUTY), pan_v_dps
        )

        waypoints.append({"t": t, "slide_duty": slide_duty, "pan_duty": pan_duty})

    return waypoints


# ── Trajectory Execution ──────────────────────────────────────────────────────
def execute_move(waypoints: list[dict], locks: dict):
    """
    Stream through velocity waypoints, linearly interpolating duty cycle at
    SUB_STEP_S (2 ms) intervals.  Blocks the calling thread for the full
    duration of the move.

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
        t0  = wp0["t"]
        t1  = wp1["t"]
        dur = t1 - t0

        # Walk through this inter-waypoint segment at SUB_STEP_S resolution
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

            # Linear interpolation between the two waypoint duty values
            alpha       = (t_sub - t0) / dur if dur > 0 else 0.0
            slide_duty  = wp0["slide_duty"] + alpha * (wp1["slide_duty"] - wp0["slide_duty"])
            pan_duty    = wp0["pan_duty"]   + alpha * (wp1["pan_duty"]   - wp0["pan_duty"])

            if locks.get("slide"):
                _set_slide(slide_duty)
            if locks.get("pan"):
                _set_pan(pan_duty)

            t_sub += SUB_STEP_S

    # Always stop and disable on exit
    slide_pwm.ChangeDutyCycle(0)
    pan_pwm.ChangeDutyCycle(0)
    GPIO.output(SLIDE_EN, GPIO.HIGH)
    GPIO.output(PAN_EN,   GPIO.HIGH)
    estop = False


# ── Global State ──────────────────────────────────────────────────────────────
trajectory_waypoints = []   # compiled velocity waypoints
motor_locks          = {"slide": False, "pan": False, "tilt": False}
current_pan_speed    = 0.0  # [-1.0, 1.0] written by WebSocket, read by tracking_loop
last_track_time      = 0.0
estop                = False


# ── Async Tracking Loop ───────────────────────────────────────────────────────
async def tracking_loop():
    """
    Background task: updates PAN PWM duty cycle from current_pan_speed.

    pan_speed from the hub is already normalised [-1, 1] (proportional
    controller output), so we map it directly to duty % via MAX_DUTY.
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
            GPIO.output(PAN_EN, GPIO.HIGH)   # free motor when idle
            await asyncio.sleep(TRACK_UPDATE_INTERVAL)
            continue

        GPIO.output(PAN_EN, GPIO.LOW)
        _set_pan(_speed_to_pan_duty(speed))
        await asyncio.sleep(TRACK_UPDATE_INTERVAL)


# ── WebSocket Bridge ──────────────────────────────────────────────────────────
async def listen_to_hub(uri: str, machine):
    """
    Persistent WebSocket connection to the FastAPI hub.  Reconnects on drop.

    Jog commands  → Viam cloud (slide only).
    Track command → updates current_pan_speed for tracking_loop.
    Trajectory    → PWM velocity waypoints via execute_move() in a background thread.
    """
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

                    # ── Trajectory commands ───────────────────────────────
                    if command == "save_trajectory":
                        print("📥  Trajectory received — compiling...")
                        trajectory_waypoints = compile_trajectory(data)
                        print(
                            f"    Compiled: {len(trajectory_waypoints):,} waypoints  "
                            f"({len(trajectory_waypoints) - 1} segments × "
                            f"~{int((trajectory_waypoints[1]['t'] - trajectory_waypoints[0]['t']) / SUB_STEP_S)} sub-steps each)\n"
                        )

                    elif command == "execute_move":
                        if not trajectory_waypoints:
                            print("WARN: execute_move — no trajectory loaded, ignoring.\n")
                            continue

                        orbit = data.get("orbit", False)

                        # In orbit mode zero out pan duty so tracking_loop drives it freely.
                        if orbit:
                            waypoints  = [{**wp, "pan_duty": 0.0} for wp in trajectory_waypoints]
                            exec_locks = {"slide": True, "pan": False, "tilt": False}
                        else:
                            waypoints  = trajectory_waypoints
                            exec_locks = {"slide": True, "pan": True, "tilt": False}

                        estop = False
                        motor_locks.update(exec_locks)
                        print(f"🚀  Executing move  orbit={orbit}  locks={exec_locks}\n")

                        async def _run_trajectory(
                            _wps=waypoints, _locks=exec_locks, _ws=ws
                        ):
                            await asyncio.to_thread(execute_move, _wps, _locks)
                            motor_locks["slide"] = False
                            motor_locks["pan"]   = False
                            motor_locks["tilt"]  = False
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
                            print(f"WARN: jog ignored — {axis} is locked by trajectory.\n")
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
                        estop             = True
                        current_pan_speed = 0.0
                        motor_locks["slide"] = False
                        motor_locks["pan"]   = False
                        motor_locks["tilt"]  = False
                        slide_pwm.ChangeDutyCycle(0)
                        pan_pwm.ChangeDutyCycle(0)
                        GPIO.output(SLIDE_EN, GPIO.HIGH)
                        GPIO.output(PAN_EN,   GPIO.HIGH)
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
                        last_track_time   = time.time()

                    else:
                        print(f"WARN: unknown command: {command!r}\n")

        except (OSError, websockets.exceptions.WebSocketException) as exc:
            print(f"Connection lost ({exc}) — retrying in 3 s...\n")
            current_pan_speed = 0.0
            motor_locks["slide"] = False
            motor_locks["pan"]   = False
            motor_locks["tilt"]  = False
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
