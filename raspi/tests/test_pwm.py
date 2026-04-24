"""
raspi/tests/test_pwm.py
-----------------------
Standalone PWM smoke-test for slide and pan motors.

Pins match pi_pwm.py exactly — edit here if you rewire.

Usage:
    python raspi/tests/test_pwm.py [--axis slide|pan|both] [--duty 50] [--duration 2]

Defaults: both axes, 50% duty, 2 s run per direction.
"""

import argparse
import sys
import time

try:
    import RPi.GPIO as GPIO
except ImportError:
    print("ERROR: RPi.GPIO not found — run this on the Raspberry Pi.")
    sys.exit(1)

# ── Pin assignments (mirror pi_pwm.py) ───────────────────────────────────────
SLIDE_EN  = 14
SLIDE_PWM = 18
SLIDE_DIR = 15

PAN_EN  = 8
PAN_PWM = 12
PAN_DIR = 7

PWM_FREQUENCY = 1000   # Hz


# ── Setup / teardown ──────────────────────────────────────────────────────────
def setup():
    GPIO.setwarnings(False)
    GPIO.setmode(GPIO.BCM)
    GPIO.setup(
        [SLIDE_EN, SLIDE_PWM, SLIDE_DIR, PAN_EN, PAN_PWM, PAN_DIR],
        GPIO.OUT,
    )
    GPIO.output([SLIDE_EN, PAN_EN], GPIO.HIGH)   # disabled — motors free
    GPIO.output([SLIDE_DIR, PAN_DIR], GPIO.LOW)


def teardown(slide_pwm, pan_pwm):
    slide_pwm.ChangeDutyCycle(0)
    pan_pwm.ChangeDutyCycle(0)
    slide_pwm.stop()
    pan_pwm.stop()
    GPIO.output([SLIDE_EN, PAN_EN], GPIO.HIGH)
    GPIO.cleanup()
    print("GPIO cleaned up.")


# ── Individual motor tests ────────────────────────────────────────────────────
def test_motor(name, en_pin, pwm_obj, dir_pin, duty: float, duration: float):
    print(f"\n── {name.upper()} ──────────────────────────────────────")

    GPIO.output(en_pin, GPIO.LOW)     # enable driver

    for label, direction in [("FORWARD", GPIO.HIGH), ("REVERSE", GPIO.LOW)]:
        print(f"  {label}  duty={duty:.0f}%  for {duration} s ... ", end="", flush=True)
        GPIO.output(dir_pin, direction)
        pwm_obj.ChangeDutyCycle(duty)
        time.sleep(duration)
        pwm_obj.ChangeDutyCycle(0)
        print("done")
        time.sleep(0.3)               # brief coast between directions

    GPIO.output(en_pin, GPIO.HIGH)    # disable driver


def test_ramp(name, en_pin, pwm_obj, dir_pin, max_duty: float, steps: int = 10):
    """Ramp from 0 → max_duty → 0 in `steps` increments, forward only."""
    print(f"\n── {name.upper()} RAMP ─────────────────────────────────")
    GPIO.output(en_pin, GPIO.LOW)
    GPIO.output(dir_pin, GPIO.HIGH)

    step_size = max_duty / steps
    step_dur  = 0.15

    print("  Ramping up  ", end="", flush=True)
    for i in range(steps + 1):
        duty = i * step_size
        pwm_obj.ChangeDutyCycle(duty)
        print(f"{duty:.0f}% ", end="", flush=True)
        time.sleep(step_dur)

    print()
    print("  Ramping down", end="", flush=True)
    for i in range(steps, -1, -1):
        duty = i * step_size
        pwm_obj.ChangeDutyCycle(duty)
        print(f"{duty:.0f}% ", end="", flush=True)
        time.sleep(step_dur)

    print()
    pwm_obj.ChangeDutyCycle(0)
    GPIO.output(en_pin, GPIO.HIGH)


# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="PWM motor smoke-test")
    parser.add_argument(
        "--axis",
        choices=["slide", "pan", "both"],
        default="both",
        help="Which axis to test (default: both)",
    )
    parser.add_argument(
        "--duty",
        type=float,
        default=50.0,
        help="Duty cycle %% for constant-speed test (default: 50)",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=2.0,
        help="Seconds to run each direction (default: 2)",
    )
    parser.add_argument(
        "--ramp",
        action="store_true",
        help="Run ramp test instead of constant-speed test",
    )
    args = parser.parse_args()

    print("Setting up GPIO...")
    setup()

    slide_pwm = GPIO.PWM(SLIDE_PWM, PWM_FREQUENCY)
    pan_pwm   = GPIO.PWM(PAN_PWM,   PWM_FREQUENCY)
    slide_pwm.start(0)
    pan_pwm.start(0)

    print(f"Pins  slide EN={SLIDE_EN} PWM={SLIDE_PWM} DIR={SLIDE_DIR}")
    print(f"      pan   EN={PAN_EN}   PWM={PAN_PWM}   DIR={PAN_DIR}")
    print(f"PWM frequency: {PWM_FREQUENCY} Hz")

    try:
        if args.ramp:
            if args.axis in ("slide", "both"):
                test_ramp("slide", SLIDE_EN, slide_pwm, SLIDE_DIR, args.duty)
            if args.axis in ("pan", "both"):
                test_ramp("pan", PAN_EN, pan_pwm, PAN_DIR, args.duty)
        else:
            if args.axis in ("slide", "both"):
                test_motor("slide", SLIDE_EN, slide_pwm, SLIDE_DIR, args.duty, args.duration)
            if args.axis in ("pan", "both"):
                test_motor("pan", PAN_EN, pan_pwm, PAN_DIR, args.duty, args.duration)

        print("\nAll tests passed.")

    except KeyboardInterrupt:
        print("\nInterrupted.")

    finally:
        teardown(slide_pwm, pan_pwm)


if __name__ == "__main__":
    main()
