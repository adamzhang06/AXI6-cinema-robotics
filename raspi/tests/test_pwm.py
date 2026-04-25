"""
raspi/tests/test_pwm.py
-----------------------
Standalone frequency-sweep smoke-test for slide and pan motors.

Speed is controlled by frequency at a fixed 50% duty cycle.
Stopping is done by setting duty to 0%.

Pins match pi_pwm.py exactly — edit here if you rewire.

Usage:
    python raspi/tests/test_pwm.py [--axis slide|pan|both] [--freq 500] [--duration 2]
    python raspi/tests/test_pwm.py --ramp [--axis slide|pan|both] [--freq 2000]

Defaults: both axes, 500 Hz, 2 s per direction.
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

FIXED_DUTY   = 50.0   # always 50% when moving
INIT_FREQ_HZ = 1.0    # startup frequency for GPIO.PWM (cannot be 0)


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
def test_motor(name, en_pin, pwm_obj, dir_pin, freq: float, duration: float):
    print(f"\n── {name.upper()} ──────────────────────────────────────")

    GPIO.output(en_pin, GPIO.LOW)   # enable driver

    for label, direction in [("FORWARD", GPIO.LOW), ("REVERSE", GPIO.HIGH)]:
        if name == "pan":
            direction = GPIO.HIGH if label == "FORWARD" else GPIO.LOW

        print(f"  {label}  freq={freq:.0f} Hz  duty=50%  for {duration} s ... ",
              end="", flush=True)
        GPIO.output(dir_pin, direction)
        pwm_obj.ChangeFrequency(freq)
        pwm_obj.ChangeDutyCycle(FIXED_DUTY)
        time.sleep(duration)
        pwm_obj.ChangeDutyCycle(0)   # stop — duty to 0
        print("done")
        time.sleep(0.3)

    GPIO.output(en_pin, GPIO.HIGH)  # disable driver


def test_ramp(name, en_pin, pwm_obj, dir_pin, max_freq: float, steps: int = 10):
    """Ramp from MIN_FREQ → max_freq → MIN_FREQ in `steps` increments, forward only."""
    print(f"\n── {name.upper()} RAMP ─────────────────────────────────")

    GPIO.output(en_pin, GPIO.LOW)
    direction = GPIO.LOW if name == "slide" else GPIO.HIGH
    GPIO.output(dir_pin, direction)

    step_size  = max_freq / steps
    step_dur   = 0.15

    print("  Ramp up  ", end="", flush=True)
    for i in range(1, steps + 1):
        freq = max(i * step_size, INIT_FREQ_HZ)
        pwm_obj.ChangeFrequency(freq)
        pwm_obj.ChangeDutyCycle(FIXED_DUTY)
        print(f"{freq:.0f} ", end="", flush=True)
        time.sleep(step_dur)

    print()
    print("  Ramp dn  ", end="", flush=True)
    for i in range(steps - 1, -1, -1):
        freq = max(i * step_size, INIT_FREQ_HZ)
        if i == 0:
            pwm_obj.ChangeDutyCycle(0)
            print("0 (stop)", end="", flush=True)
        else:
            pwm_obj.ChangeFrequency(freq)
            pwm_obj.ChangeDutyCycle(FIXED_DUTY)
            print(f"{freq:.0f} ", end="", flush=True)
        time.sleep(step_dur)

    print()
    pwm_obj.ChangeDutyCycle(0)
    GPIO.output(en_pin, GPIO.HIGH)


# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Frequency-based PWM motor smoke-test")
    parser.add_argument(
        "--axis",
        choices=["slide", "pan", "both"],
        default="both",
        help="Which axis to test (default: both)",
    )
    parser.add_argument(
        "--freq",
        type=float,
        default=500.0,
        help="PWM frequency in Hz (default: 500)",
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
        help="Ramp frequency from 0 → --freq → 0 instead of constant-speed test",
    )
    args = parser.parse_args()

    print("Setting up GPIO...")
    setup()

    slide_pwm = GPIO.PWM(SLIDE_PWM, INIT_FREQ_HZ)
    pan_pwm   = GPIO.PWM(PAN_PWM,   INIT_FREQ_HZ)
    slide_pwm.start(0)
    pan_pwm.start(0)

    print(f"Pins  slide EN={SLIDE_EN} PWM={SLIDE_PWM} DIR={SLIDE_DIR}")
    print(f"      pan   EN={PAN_EN}   PWM={PAN_PWM}   DIR={PAN_DIR}")
    print(f"Fixed duty: {FIXED_DUTY}%  |  Test freq: {args.freq:.0f} Hz")

    try:
        if args.ramp:
            if args.axis in ("slide", "both"):
                test_ramp("slide", SLIDE_EN, slide_pwm, SLIDE_DIR, args.freq)
            if args.axis in ("pan", "both"):
                test_ramp("pan", PAN_EN, pan_pwm, PAN_DIR, args.freq)
        else:
            if args.axis in ("slide", "both"):
                test_motor("slide", SLIDE_EN, slide_pwm, SLIDE_DIR, args.freq, args.duration)
            if args.axis in ("pan", "both"):
                test_motor("pan", PAN_EN, pan_pwm, PAN_DIR, args.freq, args.duration)

        print("\nAll tests passed.")

    except KeyboardInterrupt:
        print("\nInterrupted.")

    finally:
        teardown(slide_pwm, pan_pwm)


if __name__ == "__main__":
    main()
