"""
raspi/tests/diag_pins.py
------------------------
Pin-by-pin diagnostic for the slide/pan motor driver.
Run this INSTEAD of test_pwm.py when the motor doesn't respond.

Each test is interactive — press Enter to advance.
Watch your driver's indicator LEDs or probe the output pins with a multimeter.

Usage:
    python raspi/tests/diag_pins.py [--axis slide|pan] [--freq 1000]
"""

import argparse
import sys
import time

try:
    import RPi.GPIO as GPIO
except ImportError:
    print("ERROR: RPi.GPIO not found — run this on the Raspberry Pi.")
    sys.exit(1)

# ── Pins — must match pi_pwm.py ──────────────────────────────────────────────
SLIDE_EN  = 14
SLIDE_PWM = 18
SLIDE_DIR = 15

PAN_EN  = 8
PAN_PWM = 12
PAN_DIR = 7


def pause(msg=""):
    input(f"  {msg}  [press Enter to continue] ")


def test_enable(en_pin: int, label: str):
    print(f"\n{'='*60}")
    print(f"TEST 1 — ENABLE PIN  ({label} EN = BCM {en_pin})")
    print("  The code drives EN LOW to enable the driver (active-LOW).")
    print("  If your driver is active-HIGH, flip to GPIO.HIGH below.\n")

    print(f"  Setting BCM {en_pin} → HIGH (disabled)")
    GPIO.output(en_pin, GPIO.HIGH)
    pause("Is the driver disabled / fault LED off?")

    print(f"  Setting BCM {en_pin} → LOW  (enabled)")
    GPIO.output(en_pin, GPIO.LOW)
    pause("Is the driver enabled / status LED on?  (motor should hold torque if powered)")

    GPIO.output(en_pin, GPIO.HIGH)   # disable again
    print("  EN pin back HIGH (disabled).")


def test_direction(dir_pin: int, label: str):
    print(f"\n{'='*60}")
    print(f"TEST 2 — DIRECTION PIN  ({label} DIR = BCM {dir_pin})")

    for level, name in [(GPIO.LOW, "LOW"), (GPIO.HIGH, "HIGH")]:
        print(f"  DIR → {name}")
        GPIO.output(dir_pin, level)
        pause(f"Direction LED / logic level shows {name}?")

    GPIO.output(dir_pin, GPIO.LOW)


def test_pwm_manual(pwm_pin: int, label: str, freq: int):
    print(f"\n{'='*60}")
    print(f"TEST 3 — PWM SIGNAL  ({label} PWM = BCM {pwm_pin})")
    print(f"  Using software PWM at {freq} Hz.")
    print("  Motor should spin — if still nothing, PWM pin may be wrong or driver needs both EN+PWM.\n")

    pwm = GPIO.PWM(pwm_pin, freq)
    pwm.start(0)

    for duty in [25, 50, 75, 100]:
        print(f"  Duty → {duty}%  (EN still HIGH = disabled)")
        pwm.ChangeDutyCycle(duty)
        pause("Any signal on the PWM output pin? (motor should NOT move — EN still disabled)")

    # Now enable the driver
    en_pin = SLIDE_EN if label == "slide" else PAN_EN
    dir_pin = SLIDE_DIR if label == "slide" else PAN_DIR

    print("\n  Enabling driver (EN → LOW) and setting DIR → LOW (forward)")
    GPIO.output(en_pin, GPIO.LOW)
    GPIO.output(dir_pin, GPIO.LOW)

    for duty in [25, 50, 75, 100]:
        print(f"  Duty → {duty}%   (driver enabled)")
        pwm.ChangeDutyCycle(duty)
        time.sleep(1.5)
        print("    stopping briefly...")
        pwm.ChangeDutyCycle(0)
        time.sleep(0.3)

    GPIO.output(en_pin, GPIO.HIGH)
    pwm.ChangeDutyCycle(0)
    pwm.stop()
    print("  Driver disabled, PWM stopped.")


def test_en_polarity(en_pin: int, pwm_pin: int, dir_pin: int, label: str, freq: int):
    """If the motor still doesn't move, try EN=HIGH (active-HIGH driver)."""
    print(f"\n{'='*60}")
    print(f"TEST 4 — ACTIVE-HIGH EN POLARITY CHECK  ({label})")
    print("  Some drivers (e.g. DRV8833 nSLEEP, L298N ENA) are active-HIGH.")
    print("  This test drives EN HIGH while PWM runs.\n")

    pwm = GPIO.PWM(pwm_pin, freq)
    pwm.start(0)
    GPIO.output(dir_pin, GPIO.LOW)

    print("  Setting EN → HIGH + 50% duty ...")
    GPIO.output(en_pin, GPIO.HIGH)
    pwm.ChangeDutyCycle(50)
    pause("Did the motor move? If YES, your driver is active-HIGH — invert EN logic in pi_pwm.py.")

    pwm.ChangeDutyCycle(0)
    pwm.stop()
    GPIO.output(en_pin, GPIO.HIGH)


def main():
    parser = argparse.ArgumentParser(description="GPIO pin diagnostic")
    parser.add_argument("--axis", choices=["slide", "pan"], default="slide")
    parser.add_argument("--freq", type=int, default=1000, help="PWM frequency Hz")
    args = parser.parse_args()

    label   = args.axis
    en_pin  = SLIDE_EN  if label == "slide" else PAN_EN
    pwm_pin = SLIDE_PWM if label == "slide" else PAN_PWM
    dir_pin = SLIDE_DIR if label == "slide" else PAN_DIR

    print(f"\nDIAGNOSTIC — {label.upper()} motor")
    print(f"  EN  = BCM {en_pin}")
    print(f"  PWM = BCM {pwm_pin}")
    print(f"  DIR = BCM {dir_pin}")
    print(f"  Frequency = {args.freq} Hz\n")

    GPIO.setwarnings(False)
    GPIO.setmode(GPIO.BCM)
    GPIO.setup([en_pin, pwm_pin, dir_pin], GPIO.OUT)
    GPIO.output([en_pin], GPIO.HIGH)
    GPIO.output([dir_pin, pwm_pin], GPIO.LOW)

    try:
        test_enable(en_pin, label)
        test_direction(dir_pin, label)
        test_pwm_manual(pwm_pin, label, args.freq)
        test_en_polarity(en_pin, pwm_pin, dir_pin, label, args.freq)
        print("\nDone. Check notes above for which test first showed motion.")
    except KeyboardInterrupt:
        print("\nAborted.")
    finally:
        GPIO.output(en_pin, GPIO.HIGH)
        GPIO.cleanup()
        print("GPIO cleaned up.")


if __name__ == "__main__":
    main()
