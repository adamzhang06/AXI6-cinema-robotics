// Preset waypoints are expressed in physical units (inches / degrees).
// Handles use { dFrame, dPhysical } — dPhysical is in the same units as value.
// CurveEditor.loadPreset converts these to pixel-space before storing.
//
// Handle validity rules (enforced by clampHandles inside CurveEditor):
//   handleIn.dFrame  ∈ [prev.frame - wp.frame,  0]
//   handleOut.dFrame ∈ [0,  next.frame - wp.frame]

const h = (dFrame, dPhysical) => ({ dFrame, dPhysical });

export const CINEMATIC_PRESETS = [
  // ─── 1. Parallax Tracking ────────────────────────────────────────────────────
  {
    id: "parallax",
    name: "Parallax Tracking",
    durationS: 15,
    tracks: {
      slide: [
        { frame: 0, value: 0, handleIn: null, handleOut: h(120, 0) },
        { frame: 360, value: 24, handleIn: h(-120, 0), handleOut: null },
      ],
      pan: [
        { frame: 0, value: -30, handleIn: null, handleOut: h(90, 0) },
        { frame: 180, value: 0, handleIn: h(-60, -10), handleOut: h(60, 10) },
        { frame: 360, value: 30, handleIn: h(-90, 0), handleOut: null },
      ],
      tilt: [
        { frame: 0, value: 0, handleIn: null, handleOut: null },
        { frame: 360, value: 0, handleIn: null, handleOut: null },
      ],
    },
  },

  // ─── 2. Whip Pan ─────────────────────────────────────────────────────────────
  {
    id: "whip_pan",
    name: "Whip Pan",
    durationS: 10,
    tracks: {
      slide: [
        { frame: 0, value: 0, handleIn: null, handleOut: null },
        { frame: 240, value: 5, handleIn: null, handleOut: null },
      ],
      pan: [
        // Hold at 0 until frame 96, then whip to 90 over 12 frames
        { frame: 0, value: 0, handleIn: null, handleOut: null },
        { frame: 96, value: 0, handleIn: h(-20, 0), handleOut: h(4, 45) },
        { frame: 108, value: 90, handleIn: h(-4, -45), handleOut: h(20, 0) },
        { frame: 240, value: 90, handleIn: null, handleOut: null },
      ],
      tilt: [
        { frame: 0, value: 0, handleIn: null, handleOut: null },
        { frame: 240, value: 0, handleIn: null, handleOut: null },
      ],
    },
  },

  // ─── 3. Product Reveal ───────────────────────────────────────────────────────
  {
    id: "product_reveal",
    name: "Product Reveal",
    durationS: 20,
    tracks: {
      slide: [
        { frame: 0, value: 0, handleIn: null, handleOut: h(160, 0) },
        { frame: 480, value: 15, handleIn: h(-160, 0), handleOut: null },
      ],
      pan: [
        { frame: 0, value: 0, handleIn: null, handleOut: null },
        { frame: 480, value: 0, handleIn: null, handleOut: null },
      ],
      tilt: [
        // Heavy ease-out at the end (large handleIn pulls the curve in slowly)
        { frame: 0, value: -45, handleIn: null, handleOut: h(100, 0) },
        { frame: 480, value: 0, handleIn: h(-320, 0), handleOut: null },
      ],
    },
  },

  // ─── 4. Micro-Macro ──────────────────────────────────────────────────────────
  {
    id: "micro_macro",
    name: "Micro-Macro",
    durationS: 30,
    tracks: {
      slide: [
        { frame: 0, value: 0, handleIn: null, handleOut: h(240, 0) },
        { frame: 720, value: 10, handleIn: h(-240, 0), handleOut: null },
      ],
      pan: [
        // Slow sine wave: flat handles at peaks/troughs create natural looking oscillation
        { frame: 0, value: 0, handleIn: null, handleOut: h(80, 0) },
        { frame: 240, value: 5, handleIn: h(-80, 0), handleOut: h(80, 0) },
        { frame: 480, value: -5, handleIn: h(-80, 0), handleOut: h(80, 0) },
        { frame: 720, value: 0, handleIn: h(-80, 0), handleOut: null },
      ],
      tilt: [
        { frame: 0, value: 0, handleIn: null, handleOut: h(120, 0) },
        { frame: 360, value: 2, handleIn: h(-120, 0), handleOut: h(120, 0) },
        { frame: 720, value: 0, handleIn: h(-120, 0), handleOut: null },
      ],
    },
  },

  // ─── 5. Boomerang Sweep ──────────────────────────────────────────────────────
  {
    id: "boomerang",
    name: "Boomerang Sweep",
    durationS: 20,
    tracks: {
      slide: [
        { frame: 0, value: 0, handleIn: null, handleOut: h(80, 0) },
        { frame: 240, value: 20, handleIn: h(-80, 0), handleOut: h(80, 0) },
        { frame: 480, value: 0, handleIn: h(-80, 0), handleOut: null },
      ],
      pan: [
        { frame: 0, value: 0, handleIn: null, handleOut: h(40, 0) },
        { frame: 120, value: 45, handleIn: h(-40, 0), handleOut: h(40, 0) },
        { frame: 360, value: -45, handleIn: h(-40, 0), handleOut: h(40, 0) },
        { frame: 480, value: 0, handleIn: h(-40, 0), handleOut: null },
      ],
      tilt: [
        { frame: 0, value: 0, handleIn: null, handleOut: h(80, 0) },
        { frame: 240, value: 15, handleIn: h(-80, 0), handleOut: h(80, 0) },
        { frame: 480, value: 0, handleIn: h(-80, 0), handleOut: null },
      ],
    },
  },

  // ─── 6. The Perfect Orbit ────────────────────────────────────────────────────
  // Slide traverses the full rail at constant velocity while pan continuously
  // tracks a stationary target at the midpoint, sweeping 45° → 0° → -45°.
  {
    id: "perfect_orbit",
    name: "The Perfect Orbit",
    durationS: 20,
    tracks: {
      // Linear traverse: handles set to 1/3 span with proportional dPhysical
      // gives a mathematically exact linear Bezier segment.
      slide: [
        { frame: 0, value: 0, handleIn: null, handleOut: h(160, 8) },
        { frame: 480, value: 28, handleIn: h(-160, -8), handleOut: null },
      ],
      pan: [
        // Long handleOut at extremes holds the angle nearly still at the start/end.
        // Short handleIn/Out at center makes the curve arrive and depart steeply,
        // creating the slow-then-ramp acceleration profile through the midpoint.
        { frame: 0, value: 0, handleIn: null, handleOut: h(140, 0) },
        { frame: 240, value: 30, handleIn: h(-20, 0), handleOut: h(20, 0) },
        { frame: 480, value: 0, handleIn: h(-140, 0), handleOut: null },
      ],
      tilt: [
        { frame: 0, value: 0, handleIn: null, handleOut: null },
        { frame: 480, value: 0, handleIn: null, handleOut: null },
      ],
    },
  },

  // ─── 7. The Typewriter ───────────────────────────────────────────────────────
  // Slide → stop → sweep → slide → stop → sweep. Perfect for a row of objects.
  // 24 s total (576 frames). Slide stops hold at 4–8 s and 12–16 s.
  {
    id: "typewriter",
    name: "The Typewriter",
    durationS: 24,
    tracks: {
      slide: [
        { frame: 0, value: 0, handleIn: null, handleOut: h(32, 0) },
        { frame: 96, value: 8, handleIn: h(-32, 0), handleOut: h(32, 0) }, // arrive 4 s
        { frame: 192, value: 8, handleIn: h(-32, 0), handleOut: h(32, 0) }, // depart 8 s
        { frame: 288, value: 16, handleIn: h(-32, 0), handleOut: h(32, 0) }, // arrive 12 s
        { frame: 384, value: 16, handleIn: h(-32, 0), handleOut: h(32, 0) }, // depart 16 s
        { frame: 480, value: 24, handleIn: h(-32, 0), handleOut: h(32, 0) }, // arrive 20 s
        { frame: 576, value: 24, handleIn: h(-32, 0), handleOut: null }, // hold to end
      ],
      pan: [
        { frame: 0, value: 0, handleIn: null, handleOut: h(32, 0) },
        { frame: 96, value: 0, handleIn: h(-32, 0), handleOut: h(8, 15) }, // sweep starts
        { frame: 120, value: 30, handleIn: h(-8, 0), handleOut: h(8, 0) }, // peak 5 s
        { frame: 168, value: -30, handleIn: h(-8, 0), handleOut: h(8, 0) }, // trough 7 s
        { frame: 192, value: 0, handleIn: h(-8, -15), handleOut: h(32, 0) }, // center 8 s
        { frame: 288, value: 0, handleIn: h(-32, 0), handleOut: h(8, 15) }, // sweep starts
        { frame: 312, value: 30, handleIn: h(-8, 0), handleOut: h(8, 0) }, // peak 13 s
        { frame: 360, value: -30, handleIn: h(-8, 0), handleOut: h(8, 0) }, // trough 15 s
        { frame: 384, value: 0, handleIn: h(-8, -15), handleOut: h(32, 0) }, // center 16 s
        { frame: 480, value: 0, handleIn: h(-32, 0), handleOut: h(32, 0) },
        { frame: 576, value: 0, handleIn: h(-32, 0), handleOut: null },
      ],
      tilt: [
        { frame: 0, value: 0, handleIn: null, handleOut: null },
        { frame: 576, value: 0, handleIn: null, handleOut: null },
      ],
    },
  },

  // ─── 8. The Sentry ───────────────────────────────────────────────────────────
  // Slider locked at center, pan sweeps back and forth like a security camera.
  {
    id: "sentry",
    name: "The Sentry",
    durationS: 15,
    tracks: {
      slide: [
        { frame: 0, value: 12, handleIn: null, handleOut: null },
        { frame: 360, value: 12, handleIn: null, handleOut: null },
      ],
      pan: [
        // Flat handles at extremes give smooth ease-in/ease-out at each end.
        { frame: 0, value: -60, handleIn: null, handleOut: h(80, 0) },
        { frame: 180, value: 60, handleIn: h(-80, 0), handleOut: h(80, 0) },
        { frame: 360, value: -60, handleIn: h(-80, 0), handleOut: null },
      ],
      tilt: [
        { frame: 0, value: 0, handleIn: null, handleOut: null },
        { frame: 360, value: 0, handleIn: null, handleOut: null },
      ],
    },
  },

  // ─── 9. The Rubberband ───────────────────────────────────────────────────────
  // Slow dramatic reveal over 10 s, then a violent 1-second snap back to start.
  // 12 s total (288 frames).
  {
    id: "rubberband",
    name: "The Rubberband",
    durationS: 12,
    tracks: {
      slide: [
        // Very long flat handleOut creates strong ease-in (starts almost still).
        { frame: 0, value: 0, handleIn: null, handleOut: h(160, 0) },
        // Short, aggressive handleOut fires the snap instantly.
        { frame: 240, value: 20, handleIn: h(-120, 0), handleOut: h(4, -10) },
        // Matching short handleIn on the landing — hits 0 hard then flat.
        { frame: 264, value: 0, handleIn: h(-4, 10), handleOut: h(8, 0) },
        { frame: 288, value: 0, handleIn: h(-8, 0), handleOut: null },
      ],
      pan: [
        { frame: 0, value: 0, handleIn: null, handleOut: h(160, 0) },
        { frame: 240, value: 45, handleIn: h(-120, 0), handleOut: h(4, -22) },
        { frame: 264, value: 0, handleIn: h(-4, 22), handleOut: h(8, 0) },
        { frame: 288, value: 0, handleIn: h(-8, 0), handleOut: null },
      ],
      tilt: [
        { frame: 0, value: 0, handleIn: null, handleOut: null },
        { frame: 288, value: 0, handleIn: null, handleOut: null },
      ],
    },
  },
];
