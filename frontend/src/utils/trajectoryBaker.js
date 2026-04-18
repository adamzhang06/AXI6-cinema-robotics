// ─── Cubic Bezier helpers ────────────────────────────────────────────────────

function cubicBezierX(t, x0, cx1, cx2, x1) {
  const mt = 1 - t;
  return mt * mt * mt * x0 + 3 * mt * mt * t * cx1 + 3 * mt * t * t * cx2 + t * t * t * x1;
}

function cubicBezierY(t, y0, cy1, cy2, y1) {
  const mt = 1 - t;
  return mt * mt * mt * y0 + 3 * mt * mt * t * cy1 + 3 * mt * t * t * cy2 + t * t * t * y1;
}

// Binary search: find t in [0,1] such that cubicBezierX(t) ≈ targetX.
// 64 iterations gives sub-frame precision (error < 2^-64 of segment width).
function solveT(targetX, x0, cx1, cx2, x1) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) * 0.5;
    if (cubicBezierX(mid, x0, cx1, cx2, x1) < targetX) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

// ─── Y-pixel ↔ physical unit ─────────────────────────────────────────────────

function pixelToPhysical(pixelY, laneHeight, track) {
  // Y=0 (top of lane) → track.max  |  Y=laneHeight (bottom) → track.min
  return track.max - (pixelY / laneHeight) * (track.max - track.min);
}

// ─── Baker ───────────────────────────────────────────────────────────────────

/**
 * Bake every track's Bezier curve into a flat array of physical values at each frame.
 *
 * @param {Record<string, Waypoint[]>} trackData   - waypoints keyed by track id
 * @param {number}                     durationS   - timeline length in seconds
 * @param {TrackConfig[]}              tracksConfig - TRACKS array from CurveEditor
 * @param {number}                     fps          - frames per second (default 24)
 * @param {number}                     laneHeight   - pixel height of one track lane
 * @returns {Record<string, number[]>}  physical values [frame 0 … frame N] per track
 */
export function bakeTrajectory(trackData, durationS, tracksConfig, fps = 24, laneHeight, hiddenTracks = new Set()) {
  const totalFrames = Math.round(durationS * fps);
  const result = {};

  for (const track of tracksConfig) {
    if (hiddenTracks.has(track.id)) {
      result[track.id] = Array(totalFrames + 1).fill(0.0);
      continue;
    }

    const waypoints = (trackData[track.id] ?? []).slice().sort((a, b) => a.frame - b.frame);

    if (waypoints.length < 2) {
      // No curve — fill with the physical zero value
      const zeroPhysical = parseFloat(pixelToPhysical(laneHeight * (track.max / (track.max - track.min)), laneHeight, track).toFixed(3));
      result[track.id] = Array(totalFrames + 1).fill(zeroPhysical);
      continue;
    }

    const frames = [];

    for (let f = 0; f <= totalFrames; f++) {
      // Find the segment [p0, p1] that contains frame f.
      // Use the last segment if f is at or past the final waypoint.
      let segIdx = waypoints.length - 2;
      for (let i = 0; i < waypoints.length - 1; i++) {
        if (f <= waypoints[i + 1].frame) { segIdx = i; break; }
      }

      const p0 = waypoints[segIdx];
      const p1 = waypoints[segIdx + 1];

      const x0 = p0.frame, y0 = p0.y;
      const x1 = p1.frame, y1 = p1.y;

      // Short-circuit when frame coincides with an anchor
      if (f === x0) { frames.push(parseFloat(pixelToPhysical(y0, laneHeight, track).toFixed(3))); continue; }
      if (f === x1) { frames.push(parseFloat(pixelToPhysical(y1, laneHeight, track).toFixed(3))); continue; }

      const hasCurve = p0.handleOut !== null || p1.handleIn !== null;

      let pixelY;

      if (!hasCurve) {
        // Linear interpolation
        const tLin = (f - x0) / (x1 - x0);
        pixelY = y0 + tLin * (y1 - y0);
      } else {
        // Cubic Bezier — control points in (frame, pixel) space
        const cx1 = p0.handleOut ? x0 + p0.handleOut.dFrame : x0;
        const cy1 = p0.handleOut ? y0 + p0.handleOut.dY    : y0;
        const cx2 = p1.handleIn  ? x1 + p1.handleIn.dFrame : x1;
        const cy2 = p1.handleIn  ? y1 + p1.handleIn.dY     : y1;

        const t = solveT(f, x0, cx1, cx2, x1);
        pixelY = cubicBezierY(t, y0, cy1, cy2, y1);
      }

      frames.push(parseFloat(pixelToPhysical(pixelY, laneHeight, track).toFixed(3)));
    }

    result[track.id] = frames;
  }

  return result;
}
