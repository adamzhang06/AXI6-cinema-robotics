"""
raspi/tests/diag_pins.py
------------------------
Pin-by-pin diagnostic for the slide/pan motor driver.
Uses fixed 50% duty, variable frequency — same model as pi_pwm.py.

Each test is interactive — press Enter to advance.
Watch your driver's indicator LEDs or probe with a multimeter/oscilloscope.

Usage:
    python raspi/tests/diag_pins.py [--axis slide|pan] [--freq 500]
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

FIXED_DUTY   = 50.0
INIT_FREQ_HZ = 1.0


def pause(msg=""):
    input(f"  {msg}  [press Enter to continue] ")


def test_enable(en_pin: int, label: str):
    print(f"\n{'='*60}")
    print(f"TEST 1 — ENABLE PIN  ({label} EN = BCM {en_pin})")
    print("  Code drives EN LOW to enable the driver (active-LOW).")
    print("  If your driver is active-HIGH, that will be caught in Test 4.\n")

    print(f"  Setting BCM {en_pin} → HIGH (disabled)")
    GPIO.output(en_pin, GPIO.HIGH)
    pause("Driver disabled — status LED off?")

    print(f"  Setting BCM {en_pin} → LOW  (enabled)")
    GPIO.output(en_pin, GPIO.LOW)
    pause("Driver enabled — status LED on? Motor holding torque if powered?")

    GPIO.output(en_pin, GPIO.HIGH)
    print("  EN back HIGH (disabled).")


def test_direction(dir_pin: int, label: str):
    print(f"\n{'='*60}")
    print(f"TEST 2 — DIRECTION PIN  ({label} DIR = BCM {dir_pin})")

    for level, name in [(GPIO.LOW, "LOW"), (GPIO.HIGH, "HIGH")]:
        print(f"  DIR → {name}")
        GPIO.output(dir_pin, level)
        pause(f"Direction LED / logic level shows {name}?")

    GPIO.output(dir_pin, GPIO.LOW)


def test_freq_sweep(en_pin: int, pwm_pin: int, dir_pin: int, label: str, max_freq: float):
    print(f"\n{'='*60}")
    print(f"TEST 3 — FREQUENCY SWEEP  ({label} PWM = BCM {pwm_pin})")
    print(f"  Fixed duty={FIXED_DUTY}%, ramping 0 → {max_freq:.0f} Hz → 0")
    print("  EN will be enabled — motor should spin and change speed.\n")

    pwm = GPIO.PWM(pwm_pin, INIT_FREQ_HZ)
    pwm.start(0)
    GPIO.output(dir_pin, GPIO.LOW)
    GPIO.output(en_pin, GPIO.LOW)

    freqs = [10, 50, 100, 250, 500, max_freq]
    print("  Ramp up: ", end="", flush=True)
    for f in freqs:
        pwm.ChangeFrequency(f)
        pwm.ChangeDutyCycle(FIXED_DUTY)
        print(f"{f:.0f}Hz ", end="", flush=True)
        time.sleep(0.8)

    print("\n  Ramp dn: ", end="", flush=True)
    for f in reversed(freqs[:-1]):
        pwm.ChangeFrequency(f)
        pwm.ChangeDutyCycle(FIXED_DUTY)
        print(f"{f:.0f}Hz ", end="", flush=True)
        time.sleep(0.8)

    pwm.ChangeDutyCycle(0)
    print("0 (stop)")
    pause("Did the motor move and change speed with frequency?")

    GPIO.output(en_pin, GPIO.HIGH)
    pwm.stop()


def test_en_polarity(en_pin: int, pwm_pin: int, dir_pin: int, label: str, freq: float):
    """Try EN=HIGH (active-HIGH drivers like DRV8833 nSLEEP, L298N ENA)."""
    print(f"\n{'='*60}")
    print(f"TEST 4 — ACTIVE-HIGH EN CHECK  ({label})")
    print("  If Test 3 produced no motion, your driver may be active-HIGH.")
    print("  This test drives EN HIGH with PWM running.\n")

    pwm = GPIO.PWM(pwm_pin, freq)
    pwm.start(0)
    GPIO.output(dir_pin, GPIO.LOW)

    print(f"  EN → HIGH + {freq:.0f} Hz + {FIXED_DUTY}% duty ...")
    GPIO.output(en_pin, GPIO.HIGH)
    pwm.ChangeFrequency(freq)
    pwm.ChangeDutyCycle(FIXED_DUTY)
    pause("Motor move? If YES → driver is active-HIGH. Invert EN logic in pi_pwm.py.")

    pwm.ChangeDutyCycle(0)
    pwm.stop()
    GPIO.output(en_pin, GPIO.HIGH)


def main():
    parser = argparse.ArgumentParser(description="GPIO pin diagnostic (frequency-based)")
    parser.add_argument("--axis", choices=["slide", "pan"], default="slide")
    parser.add_argument("--freq", type=float, default=8000.0, help="Max test frequency Hz")
    args = parser.parse_args()

    label   = args.axis
    en_pin  = SLIDE_EN  if label == "slide" else PAN_EN
    pwm_pin = SLIDE_PWM if label == "slide" else PAN_PWM
    dir_pin = SLIDE_DIR if label == "slide" else PAN_DIR

    print(f"\nDIAGNOSTIC — {label.upper()} motor")
    print(f"  EN  = BCM {en_pin}")
    print(f"  PWM = BCM {pwm_pin}")
    print(f"  DIR = BCM {dir_pin}")
    print(f"  Max test freq: {args.freq:.0f} Hz  |  Duty when moving: {FIXED_DUTY}%\n")

    GPIO.setwarnings(False)
    GPIO.setmode(GPIO.BCM)
    GPIO.setup([en_pin, pwm_pin, dir_pin], GPIO.OUT)
    GPIO.output(en_pin, GPIO.HIGH)
    GPIO.output(dir_pin, GPIO.LOW)
    GPIO.output(pwm_pin, GPIO.LOW)

    try:
        test_enable(en_pin, label)
        test_direction(dir_pin, label)
        test_freq_sweep(en_pin, pwm_pin, dir_pin, label, args.freq)
        test_en_polarity(en_pin, pwm_pin, dir_pin, label, args.freq)
        print("\nDone. Note which test first produced motion.")
    except KeyboardInterrupt:
        print("\nAborted.")
    finally:
        GPIO.output(en_pin, GPIO.HIGH)
        GPIO.cleanup()
        print("GPIO cleaned up.")


if __name__ == "__main__":
    main()
