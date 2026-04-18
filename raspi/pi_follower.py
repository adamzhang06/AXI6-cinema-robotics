"""
raspi/pi_follower.py
--------------------
Trajectory follower: reads a pre-baked JSON trajectory produced by the React
UI and drives the slide and pan motors via GPIO busy-wait pulses.

It does NOT plan S-curves. The UI has already done that math. This script only
converts absolute per-frame positions into step counts, applies parasitic pan
compensation, distributes the steps evenly within each frame's time window, and
fires the GPIO pins at the right moments.

Expected JSON format:
    {
        "fps": 24,
        "duration": <seconds>,
        "tracks": {
            "slide": [pos0, pos1, ..., posN],   # absolute inches, index = frame
            "pan":   [pos0, pos1, ..., posN],   # absolute degrees
            "tilt":  [pos0, pos1, ..., posN]    # absolute degrees (not yet wired)
        }
    }
"""

import asyncio
import json
import os
import sys
import time

import RPi.GPIO as GPIO
import websockets
from dotenv import load_dotenv

# ── Slide Pins (BCM) ──────────────────────────────────────────────────────────
SLIDE_EN = 14
SLIDE_STEP = 15
SLIDE_DIR = 18

# ── Pan Pins (BCM) ────────────────────────────────────────────────────────────
PAN_EN = 8
PAN_STEP = 7
PAN_DIR = 1

# ── Config ────────────────────────────────────────────────────────────────────
SLIDE_STEPS_PER_INCH = 1270
PAN_STEPS_PER_REV = 8000
PAN_STEPS_PER_SLIDE_STEP = 0.4  # parasitic pan steps per slide step (tune empirically)

PULSE_WIDTH = 0.000005  # 5 µs HIGH time required by stepper drivers


# ── GPIO ──────────────────────────────────────────────────────────────────────
def setup():
    GPIO.setwarnings(False)
    GPIO.setmode(GPIO.BCM)
    GPIO.setup([SLIDE_EN, SLIDE_STEP, SLIDE_DIR, PAN_EN, PAN_STEP, PAN_DIR], GPIO.OUT)
    GPIO.output(SLIDE_EN, GPIO.LOW)  # active-LOW enable
    GPIO.output(PAN_EN, GPIO.LOW)
    GPIO.output(SLIDE_STEP, GPIO.LOW)
    GPIO.output(PAN_STEP, GPIO.LOW)


def teardown():
    GPIO.output(SLIDE_EN, GPIO.HIGH)  # disable drivers
    GPIO.output(PAN_EN, GPIO.HIGH)
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
    fps = json_data["fps"]
    frame_dur = 1.0 / fps

    tracks = json_data["tracks"]
    slide_pos = tracks["slide"]  # list of absolute inches, one per frame
    pan_pos = tracks["pan"]  # list of absolute degrees, one per frame
    # tilt_pos = tracks["tilt"]   # placeholder — tilt hardware not yet wired

    events = []

    prev_slide_dir = None
    prev_pan_dir = None

    for i in range(1, len(slide_pos)):
        t_start = (i - 1) * frame_dur
        t_end = i * frame_dur

        # ── Slide delta → steps ───────────────────────────────────────────
        slide_delta = slide_pos[i] - slide_pos[i - 1]  # inches
        slide_steps = int(round(slide_delta * SLIDE_STEPS_PER_INCH))

        # ── Pan delta → intended steps ────────────────────────────────────
        pan_delta = pan_pos[i] - pan_pos[i - 1]  # degrees
        intended_pan = int(round((pan_delta / 360.0) * PAN_STEPS_PER_REV))

        # ── Parasitic compensation ────────────────────────────────────────
        # The slide carriage physically rotates the camera as it travels.
        # Subtract that coupled rotation so the pan motor cancels it out.
        parasitic = int(round(slide_steps * PAN_STEPS_PER_SLIDE_STEP))
        net_pan = intended_pan - parasitic

        # ── Direction events (emitted at t_start before any step pulses) ──
        slide_dir = GPIO.LOW if slide_steps >= 0 else GPIO.HIGH
        pan_dir = GPIO.HIGH if net_pan >= 0 else GPIO.LOW

        if slide_steps != 0 and slide_dir != prev_slide_dir:
            events.append(("dir", t_start, SLIDE_DIR, slide_dir))
            prev_slide_dir = slide_dir

        if net_pan != 0 and pan_dir != prev_pan_dir:
            events.append(("dir", t_start, PAN_DIR, pan_dir))
            prev_pan_dir = pan_dir

        # ── Distribute slide steps evenly across the frame window ─────────
        n_slide = abs(slide_steps)
        if n_slide > 0:
            for j in range(n_slide):
                fire = t_start + (j + 0.5) * frame_dur / n_slide
                events.append(("step", fire, SLIDE_STEP))

        # ── Distribute net pan steps evenly across the frame window ───────
        n_pan = abs(net_pan)
        if n_pan > 0:
            for j in range(n_pan):
                fire = t_start + (j + 0.5) * frame_dur / n_pan
                events.append(("step", fire, PAN_STEP))

        # ── Tilt placeholder ──────────────────────────────────────────────
        # tilt_delta = tilt_pos[i] - tilt_pos[i - 1]                   # degrees
        # tilt_steps = int(round(tilt_delta * TILT_STEPS_PER_DEG))
        # tilt_dir   = GPIO.HIGH if tilt_steps >= 0 else GPIO.LOW
        # if tilt_steps != 0 and tilt_dir != prev_tilt_dir:
        #     events.append(('dir', t_start, TILT_DIR, tilt_dir))
        #     prev_tilt_dir = tilt_dir
        # n_tilt = abs(tilt_steps)
        # for j in range(n_tilt):
        #     fire = t_start + (j + 0.5) * frame_dur / n_tilt
        #     events.append(('step', fire, TILT_STEP))

    events.sort(key=lambda e: e[1])
    return events


# ── Execution ─────────────────────────────────────────────────────────────────
def execute_move(event_queue):
    """
    Stream through the sorted event queue using a perf_counter busy-wait loop.

    Direction events set a GPIO pin immediately. Step events pulse the pin HIGH
    for PULSE_WIDTH seconds then pull it LOW, as required by the stepper drivers.
    """
    GPIO.output(SLIDE_EN, GPIO.LOW)    # enable drivers before move starts
    GPIO.output(PAN_EN,   GPIO.LOW)

    start = time.perf_counter()

    for event in event_queue:
        kind = event[0]
        fire_time = event[1]

        while time.perf_counter() - start < fire_time:
            pass

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

    GPIO.output(SLIDE_EN, GPIO.HIGH)   # disable drivers (active-LOW)
    GPIO.output(PAN_EN,   GPIO.HIGH)


# ── WebSocket Bridge ──────────────────────────────────────────────────────────

event_queue = []  # compiled trajectory lives here between save and execute


async def listen_to_hub(uri: str):
    """
    Maintain a persistent WebSocket connection to the FastAPI hub and handle
    incoming commands. Reconnects automatically on drop.
    """
    global event_queue

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
                        event_queue = compile_trajectory(data)
                        step_count = sum(1 for e in event_queue if e[0] == "step")
                        print(
                            f"    Trajectory compiled and ready  "
                            f"({len(event_queue):,} events, {step_count:,} step pulses)\n"
                        )

                    elif command == "execute_move":
                        if not event_queue:
                            print(
                                "WARN: execute_move received but no trajectory is loaded — ignoring.\n"
                            )
                            continue
                        print("🚀  Executing move...\n")
                        execute_move(event_queue)  # blocks until motors finish
                        print("Done.\n")

                    else:
                        print(f"WARN: unknown command: {command!r}\n")

        except (OSError, websockets.exceptions.WebSocketException) as exc:
            print(f"Connection lost ({exc}) — retrying in 3 s...\n")
            await asyncio.sleep(3)


# ── Entry Point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

    uri = os.getenv("FASTAPI_WS_URI")
    if not uri:
        print("ERROR: FASTAPI_WS_URI is not set.")
        print("  Create raspi/.env and add:  FASTAPI_WS_URI=ws://<host>:8000/ws/pi")
        sys.exit(1)

    setup()
    try:
        asyncio.run(listen_to_hub(uri))
    except KeyboardInterrupt:
        print("\nAborted.")
    finally:
        teardown()
