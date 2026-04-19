# AXI6 Cinema Robotics - Camera Slider

AXI6 is an open-source, highly precise 2-axis camera slider built by
student videographers. Commercial robotic sliders cost thousands of
dollars, acting as a massive barrier to entry for creators. AXI6
brings that cost down to **under $200** by combining readily available
electronics, 3D-printed mechanics, and a custom web application for
timeline-based motion control.

---

## 🎬 Features

* **Timeline-Based Waypoint Animation:** Set specific keyframes for
both the slide and pan axes. The system automatically interpolates the
path and executes the move over a user-defined timeframe.
* **Remote Manual Control:** A custom web app allows for precise,
remote jogging and adjustment of the camera position.
* **Algorithmic Axis Synchronization:** The slide and pan axes are
mechanically linked by design. To counteract parasitic motion, the
software actively calculates and executes counter-rotations on the pan
axis, ensuring perfect target tracking while sliding.
* **Zero-Backlash Mechanics:** Custom-designed, 3D-printed gears and
tension-adjustable pulleys eliminate mechanical play, bridging the gap
between discrete digital code and smooth, organic real-world motion.

---

## 🛠 Hardware Architecture

The physical rig is designed around lightweight rigidity and
accessible components.

* **Rails:** Sleek carbon fiber tubes
* **Microcontroller:** Raspberry Pi
* **Motors:** NEMA 17 Stepper Motors
* **Drivers:** TMC2209 Stepper Motor Drivers (for whisper-quiet,
ultra-precise stepping)
* **Power:** 12V DC Power Supply with a buck converter for logic-level step-down
* **Mechanics:** Custom 3D-printed gears, tensioning slots, pulleys, and shafts

---

## 💻 Software Stack

*(Note: Add or adjust your specific languages/frameworks here!)*
* **Frontend:** React / Web App for remote control and waypoint
timeline mapping.
* **Backend:** Python-driven hardware control, handling precise timing
between software clock ticks, frame rates, and electrical pulses.
* **Motion Logic:** Custom mathematical models to convert visual
timelines into synchronized step-and-dir motor pulses.

---

## 🚀 Getting Started

### Prerequisites
* Raspberry Pi running Raspberry Pi OS
* Python 3.x
* Node.js & npm (for the web app)

### Installation
1. Clone the repo
   ```sh
   git clone [https://github.com/adamzhang06/AXI6-Camera-Slider.git](https://github.com/adamzhang06/AXI6-Camera-Slider.git)
