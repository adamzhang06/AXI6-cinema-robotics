"""
raspi/pi_follower.py
--------------------
Trajectory follower + live tracking via raw GPIO pan pulses.

Modes:
  Trajectory  — pre-baked JSON executed in a background thread; busy-wait GPIO loop.
  Tracking    — async pulse loop driven by pan_speed floats from the hub.
  Orbit       — slide runs a trajectory while pan tracks freely (CSRT from hub).
  Jog         — slide motor via Viam cloud SDK (set_power / stop).

motor_locks per-axis mutex:
  Each axis can be independently locked by the trajectory executor.
  tracking_loop only yields when motor_locks["pan"] is True.
  This lets a slide-only trajectory run while the pan stays free for tracking.
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
SLIDE_EN   = 14
SLIDE_STEP = 15
SLIDE_DIR  = 18

# ── Pan Pins (BCM) ────────────────────────────────────────────────────────────
PAN_EN   = 8
PAN_STEP = 7
PAN_DIR  = 1

# ── Config ────────────────────────────────────────────────────────────────────
SLIDE_STEPS_PER_INCH      = 1270
PAN_STEPS_PER_REV         = 8000
PAN_STEPS_PER_SLIDE_STEP  = 0.4   # parasitic compensation (tune empirically)

PULSE_WIDTH = 0.000005  # 5 µs HIGH time for trajectory stepper drivers
JOG_POWER   = 0.25      # Viam slide jog power (0.0–1.0)

# Tracking pulse timing: speed 1.0 → TRACK_MIN_DELAY, speed ~0 → TRACK_MAX_DELAY
TRACK_MIN_DELAY  = 0.0002  # fastest inter-pulse sleep (s) — full speed
TRACK_MAX_DELAY  = 0.003   # slowest inter-pulse sleep (s) — near-stop
TRACK_PULSE_HIGH = 0.0001  # 100 µs HIGH pulse for tracking (async, not busy-wait)
TRACK_TIMEOUT    = 0.5     # zero speed if no "track" command received within this window (s)
TRACK_DEADBAND   = 0.01    # speeds below this are treated as zero


# ── GPIO ──────────────────────────────────────────────────────────────────────
def setup():
    GPIO.setwarnings(False)
    GPIO.setmode(GPIO.BCM)
    GPIO.setup([SLIDE_EN, SLIDE_STEP, SLIDE_DIR, PAN_EN, PAN_STEP, PAN_DIR], GPIO.OUT)
    GPIO.output(SLIDE_EN, GPIO.HIGH)  # start disabled — motors free to move by hand
    GPIO.output(PAN_EN,   GPIO.HIGH)
    GPIO.output(SLIDE_STEP, GPIO.LOW)
    GPIO.output(PAN_STEP,   GPIO.LOW)


def teardown():
    GPIO.output(SLIDE_EN, GPIO.HIGH)  # disable drivers
    GPIO.output(PAN_EN,   GPIO.HIGH)
    GPIO.cleanup()


# ── Trajectory Compiler ───────────────────────────────────────────────────────
def compile_trajectory(json_data):
    """
    Convert a pre-baked JSON trajectory into a flat, sorted master event queue.

    Each event is one of:
        ('dir',  fire_time_s, pin, gpio_value)  — set a direction pin
        ('step', fire_time_s, pin)              — pulse a step pin HIGH→LOW

    Events are sorted ascending by fire_time_s so execute_move can stream
    through them in a single pass.
    """
    fps       = json_data["fps"]
    frame_dur = 1.0 / fps

    tracks    = json_data["tracks"]
    slide_pos = tracks["slide"]   # absolute inches, one per frame
    pan_pos   = tracks["pan"]     # absolute degrees, one per frame

    events = []

    prev_slide_dir = None
    prev_pan_dir   = None

    # Fractional accumulators carry sub-step remainder across frame boundaries.
    slide_acc = 0.0
    pan_acc   = 0.0

    for i in range(1, len(slide_pos)):
        t_start = (i - 1) * frame_dur

        # ── Slide delta → steps ───────────────────────────────────────────
        slide_delta  = slide_pos[i] - slide_pos[i - 1]
        slide_acc   += slide_delta * SLIDE_STEPS_PER_INCH
        slide_steps  = int(slide_acc)
        slide_acc   -= slide_steps

        # ── Pan delta → intended steps (with parasitic compensation) ──────
        pan_delta    = pan_pos[i] - pan_pos[i - 1]
        intended_pan = (pan_delta / 360.0) * PAN_STEPS_PER_REV
        parasitic    = slide_delta * SLIDE_STEPS_PER_INCH * PAN_STEPS_PER_SLIDE_STEP
        pan_acc     += intended_pan - parasitic
        net_pan      = int(pan_acc)
        pan_acc     -= net_pan

        # ── Direction events ──────────────────────────────────────────────
        slide_dir = GPIO.LOW  if slide_steps >= 0 else GPIO.HIGH
        pan_dir   = GPIO.HIGH if net_pan     >= 0 else GPIO.LOW

        if slide_steps != 0 and slide_dir != prev_slide_dir:
            events.append(("dir", t_start, SLIDE_DIR, slide_dir))
            prev_slide_dir = slide_dir

        if net_pan != 0 and pan_dir != prev_pan_dir:
            events.append(("dir", t_start, PAN_DIR, pan_dir))
            prev_pan_dir = pan_dir

        # ── Distribute steps evenly across the frame window ───────────────
        n_slide = abs(slide_steps)
        for j in range(n_slide):
            events.append(("step", t_start + j * frame_dur / n_slide, SLIDE_STEP))

        n_pan = abs(net_pan)
        for j in range(n_pan):
            events.append(("step", t_start + j * frame_dur / n_pan, PAN_STEP))

    events.sort(key=lambda e: e[1])
    return events


# ── Trajectory Execution ──────────────────────────────────────────────────────
def execute_move(event_queue, locks):
    """
    Stream through the sorted event queue using a perf_counter busy-wait loop.
    Blocks the calling thread for the full duration of the move.

    Only enables/disables motors for the axes present in `locks` (True = this
    trajectory owns that axis).  Axes not in locks are left under the control
    of the async tracking_loop.  Checks `estop` on every event; aborts cleanly
    if an emergency stop arrives mid-run.
    """
    global estop

    if locks.get("slide"):
        GPIO.output(SLIDE_EN, GPIO.LOW)
    if locks.get("pan"):
        GPIO.output(PAN_EN, GPIO.LOW)

    start = time.perf_counter()

    for event in event_queue:
        if estop:
            break

        kind      = event[0]
        fire_time = event[1]

        while time.perf_counter() - start < fire_time:
            if estop:
                break
            pass

        if estop:
            break

        if kind == "dir":
            _, _, pin, value = event
            GPIO.output(pin, value)
        elif kind == "step":
            _, _, pin = event
            GPIO.output(pin, GPIO.HIGH)
            end = time.perf_counter() + PULSE_WIDTH
            while time.perf_counter() < end:
                pass
            GPIO.output(pin, GPIO.LOW)

    # Always disable drivers on exit — whether completed or e-stopped
    GPIO.output(SLIDE_EN, GPIO.HIGH)
    GPIO.output(PAN_EN,   GPIO.HIGH)
    estop = False


# ── Global State ──────────────────────────────────────────────────────────────
event_queue       = []                                          # compiled trajectory
motor_locks       = {"slide": False, "pan": False, "tilt": False}  # per-axis execution locks
current_pan_speed = 0.0    # [-1.0, 1.0] written by WebSocket, read by tracking_loop
last_track_time   = 0.0    # monotonic time of last "track" command
estop             = False  # set True to abort execute_move mid-run


# ── Async Tracking Loop ───────────────────────────────────────────────────────
async def tracking_loop():
    """
    Background task: pulses PAN_STEP at a rate proportional to current_pan_speed.

    Yields between pulses so the WebSocket listener can receive new speed values.
    Automatically zeroes speed if no "track" command arrives within TRACK_TIMEOUT.
    Pauses only when motor_locks["pan"] is True (pan axis owned by trajectory).
    When motor_locks["pan"] is False the pan is free — orbit slide runs concurrently.
    """
    global current_pan_speed, last_track_time

    while True:
        # Yield if the trajectory executor owns the pan axis
        if motor_locks["pan"]:
            await asyncio.sleep(0.01)
            continue

        # Timeout safety — kill speed if hub goes quiet
        if time.time() - last_track_time > TRACK_TIMEOUT:
            current_pan_speed = 0.0

        speed = current_pan_speed
        if abs(speed) < TRACK_DEADBAND:
            GPIO.output(PAN_EN, GPIO.HIGH)  # disable driver when idle — motor free
            await asyncio.sleep(0.01)
            continue

        # Enable driver only while actively moving
        GPIO.output(PAN_EN, GPIO.LOW)

        # Set direction
        GPIO.output(PAN_DIR, GPIO.HIGH if speed > 0 else GPIO.LOW)

        # Pulse step pin
        GPIO.output(PAN_STEP, GPIO.HIGH)
        await asyncio.sleep(TRACK_PULSE_HIGH)
        GPIO.output(PAN_STEP, GPIO.LOW)

        # Speed → inter-pulse delay: 1.0 → TRACK_MIN_DELAY, ~0 → TRACK_MAX_DELAY
        delay = TRACK_MAX_DELAY - abs(speed) * (TRACK_MAX_DELAY - TRACK_MIN_DELAY)
        await asyncio.sleep(delay)


# ── WebSocket Bridge ──────────────────────────────────────────────────────────
async def listen_to_hub(uri: str, machine):
    """
    Maintain a persistent WebSocket connection to the FastAPI hub.
    Reconnects automatically on drop.

    Jog commands  → Viam cloud (slide only).
    Track command → updates current_pan_speed for tracking_loop.
    Trajectory    → GPIO busy-wait via execute_move() in a background thread.
    """
    global event_queue, current_pan_speed, last_track_time, estop

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
                        event_queue = compile_trajectory(data)
                        step_count  = sum(1 for e in event_queue if e[0] == "step")
                        print(
                            f"    Compiled: {len(event_queue):,} events, "
                            f"{step_count:,} step pulses\n"
                        )

                    elif command == "execute_move":
                        if not event_queue:
                            print("WARN: execute_move — no trajectory loaded, ignoring.\n")
                            continue

                        orbit = data.get("orbit", False)

                        # In orbit mode the pan is owned by CSRT tracking — strip all
                        # pan step/dir events so the trajectory only drives the slide.
                        queue = (
                            [e for e in event_queue
                             if not (e[0] in ("step", "dir") and e[2] in (PAN_STEP, PAN_DIR))]
                            if orbit else event_queue
                        )

                        step_pins = {e[2] for e in queue if e[0] == "step"}
                        exec_locks = {
                            "slide": SLIDE_STEP in step_pins,
                            "pan":   False,   # pan always free in orbit; only slide locked
                            "tilt":  False,
                        } if orbit else {
                            "slide": SLIDE_STEP in step_pins,
                            "pan":   PAN_STEP   in step_pins,
                            "tilt":  False,
                        }
                        estop = False   # clear any prior E-STOP before starting move
                        motor_locks.update(exec_locks)
                        print(f"🚀  Executing move  orbit={orbit}  locks={exec_locks}\n")

                        # Run in background thread — event loop stays alive for tracking_loop
                        await asyncio.to_thread(execute_move, queue, exec_locks)

                        motor_locks["slide"] = False
                        motor_locks["pan"]   = False
                        motor_locks["tilt"]  = False
                        print("Done.\n")
                        await ws.send(json.dumps({"command": "trajectory_complete"}))
                        print("📡  Sent trajectory_complete to hub.\n")

                    # ── Jog commands (Viam cloud — slide only) ────────────
                    elif command == "start_jog":
                        axis = data.get("axis", "")
                        if motor_locks.get(axis, False):
                            print(f"WARN: jog ignored — {axis} is locked by trajectory.\n")
                            continue
                        direction = float(data.get("direction", 0))
                        print(f"🕹  start_jog  axis={axis}  direction={direction:+.0f}")
                        if axis == "slide":
                            await slide_motor.set_power(-direction * JOG_POWER)
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
                        estop = False   # clear E-STOP block when re-entering tracking
                        print("🔒  Slide locked (tracking / orbit mode)")
                        GPIO.output(SLIDE_EN, GPIO.LOW)   # enable driver = hold torque

                    elif command == "unlock_slide":
                        print("🔓  Slide unlocked")
                        GPIO.output(SLIDE_EN, GPIO.HIGH)  # disable driver = free to move

                    # ── Emergency stop ────────────────────────────────────
                    elif command == "emergency_stop":
                        print("🛑  EMERGENCY STOP")
                        estop             = True   # aborts execute_move thread immediately
                        current_pan_speed = 0.0
                        motor_locks["slide"] = False
                        motor_locks["pan"]   = False
                        motor_locks["tilt"]  = False
                        GPIO.output(SLIDE_EN, GPIO.HIGH)
                        GPIO.output(PAN_EN,   GPIO.HIGH)
                        GPIO.output(SLIDE_STEP, GPIO.LOW)
                        GPIO.output(PAN_STEP,   GPIO.LOW)
                        try:
                            await slide_motor.stop()
                        except Exception:
                            pass
                        print("🛑  All motors stopped and freed.\n")

                    # ── Tracking command (hub → raw GPIO pan) ─────────────
                    elif command == "track":
                        if motor_locks["pan"] or estop:
                            continue
                        current_pan_speed = float(data.get("pan_speed", 0.0))
                        last_track_time   = time.time()

                    else:
                        print(f"WARN: unknown command: {command!r}\n")

        except (OSError, websockets.exceptions.WebSocketException) as exc:
            print(f"Connection lost ({exc}) — retrying in 3 s...\n")
            current_pan_speed = 0.0   # safety: stop pan if hub drops
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
