import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";

export const CINEMATIC_FPS = 24;
const BASE_CANVAS_W = 6000;
const DIAMOND_R = 5;
const HIT_R = DIAMOND_R + 4;
const HANDLE_R = 4;
const HANDLE_HIT_R = HANDLE_R + 6;
const MARQUEE_THRESHOLD = 4;
const RULER_H = 30;

const TRACKS = [
  { id: "slide", name: "Slide", color: "#3993DD", max: 28,  min: 0,    unit: "in" },
  { id: "pan",   name: "Pan",   color: "#ff4444", max: 360, min: -360, unit: "°"  },
  { id: "tilt",  name: "Tilt",  color: "#44ff44", max: 45,  min: -45,  unit: "°"  },
];

function makeDefaultWaypoints(track, laneHeight, maxFrame) {
  const zeroY = (track.max / (track.max - track.min)) * laneHeight;
  return [
    { frame: 0,        y: zeroY, handleIn: null, handleOut: null },
    { frame: maxFrame, y: zeroY, handleIn: null, handleOut: null },
  ];
}

function buildPathD(waypoints, maxFrame, canvasWidth) {
  if (waypoints.length < 2) return "";
  const ftx = (f) => (f / maxFrame) * canvasWidth;
  const pxPerFrame = canvasWidth / maxFrame;
  const pts = waypoints.map((wp) => ({
    x: ftx(wp.frame), y: wp.y, hi: wp.handleIn, ho: wp.handleOut,
  }));
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const cur = pts[i], nxt = pts[i + 1];
    if (cur.ho || nxt.hi) {
      const cp1x = cur.ho ? cur.x + cur.ho.dFrame * pxPerFrame : cur.x;
      const cp1y = cur.ho ? cur.y + cur.ho.dY : cur.y;
      const cp2x = nxt.hi ? nxt.x + nxt.hi.dFrame * pxPerFrame : nxt.x;
      const cp2y = nxt.hi ? nxt.y + nxt.hi.dY : nxt.y;
      d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${nxt.x} ${nxt.y}`;
    } else {
      d += ` L ${nxt.x} ${nxt.y}`;
    }
  }
  return d;
}

function clampHandles(waypoints) {
  return waypoints.map((wp, i) => {
    let handleIn = wp.handleIn;
    let handleOut = wp.handleOut;
    
    if (handleIn) {
      const prev = waypoints[i - 1];
      if (prev) {
        const minDFrame = prev.frame - wp.frame;
        handleIn = { ...handleIn, dFrame: Math.max(minDFrame, Math.min(0, handleIn.dFrame)) };
      } else {
        handleIn = null;
      }
    }
    
    if (handleOut) {
      const next = waypoints[i + 1];
      if (next) {
        const maxDFrame = next.frame - wp.frame;
        handleOut = { ...handleOut, dFrame: Math.min(maxDFrame, Math.max(0, handleOut.dFrame)) };
      } else {
        handleOut = null;
      }
    }
    
    return { ...wp, handleIn, handleOut };
  });
}

// Apply an easing preset to a subset of waypoints (identified by frame number).
// type: 'linear' | 'ease-in' | 'ease-out' | 'ease-both'
function applyEasingToWaypoints(waypoints, frames, type) {
  const eased = waypoints.map((wp, i) => {
    if (!frames.includes(wp.frame)) return wp;
    if (type === "linear") return { ...wp, handleIn: null, handleOut: null };
    const prev = waypoints[i - 1];
    const next = waypoints[i + 1];
    let handleIn  = wp.handleIn;
    let handleOut = wp.handleOut;
    
    if (type === "ease-in") {
      handleIn  = prev ? { dFrame: -(wp.frame - prev.frame) * 0.33, dY: 0 } : null;
      handleOut = null;
    } else if (type === "ease-out") {
      handleIn  = null;
      handleOut = next ? { dFrame:  (next.frame - wp.frame) * 0.33, dY: 0 } : null;
    } else if (type === "ease-both") {
      handleIn  = prev ? { dFrame: -(wp.frame - prev.frame) * 0.33, dY: 0 } : null;
      handleOut = next ? { dFrame:  (next.frame - wp.frame) * 0.33, dY: 0 } : null;
    }
    
    return { ...wp, handleIn, handleOut };
  });
  return clampHandles(eased);
}

// ─── TimelineRuler ────────────────────────────────────────────────────────────

function computeRulerTicks(canvasWidth, maxFrame) {
  const durationS  = maxFrame / CINEMATIC_FPS;
  const pxPerSec   = canvasWidth / durationS;
  const pxPerFrame = canvasWidth / maxFrame;
  const SEC_STEPS  = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const majorSec   = SEC_STEPS.find((s) => pxPerSec * s >= 60) ?? 600;
  let minorFrameStep = null;
  if      (pxPerFrame >= 30) minorFrameStep = 1;
  else if (pxPerFrame >= 15) minorFrameStep = 2;
  else if (pxPerFrame >= 8)  minorFrameStep = 4;
  else if (pxPerFrame >= 4)  minorFrameStep = 6;
  return { majorSec, minorFrameStep, durationS };
}

function fmtSec(s) {
  if (s === 0) return "0";
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r === 0 ? `${m}m` : `${m}:${String(r).padStart(2, "0")}`;
}

export function TimelineRuler({ canvasWidth, maxFrame, onFrameChange }) {
  const svgRef = useRef(null);
  const { majorSec, minorFrameStep, durationS } = computeRulerTicks(canvasWidth, maxFrame);

  const majorTicks = [];
  for (let s = 0; s <= durationS + 0.001; s += majorSec) {
    const frame = Math.round(s * CINEMATIC_FPS);
    if (frame > maxFrame) break;
    majorTicks.push({ x: (frame / maxFrame) * canvasWidth, label: fmtSec(Math.round(s)) });
  }

  const minorTicks = [];
  if (minorFrameStep) {
    for (let f = 0; f <= maxFrame; f += minorFrameStep) {
      const s = f / CINEMATIC_FPS;
      if (Math.abs(s % majorSec) < 0.001 || Math.abs((s % majorSec) - majorSec) < 0.001) continue;
      minorTicks.push({ x: (f / maxFrame) * canvasWidth });
    }
  }

  const handleClick = (e) => {
    if (!svgRef.current) return;
    const x = e.clientX - svgRef.current.getBoundingClientRect().left;
    onFrameChange?.(Math.max(0, Math.min(maxFrame, Math.round((x / canvasWidth) * maxFrame))));
  };

  return (
    <svg ref={svgRef} width={canvasWidth} height={RULER_H}
      style={{ display: "block", cursor: "ew-resize" }} onClick={handleClick}>
      <line x1={0} y1={RULER_H - 1} x2={canvasWidth} y2={RULER_H - 1}
        stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
      {minorTicks.map(({ x }, i) => (
        <line key={`m${i}`} x1={x} y1={RULER_H - 6} x2={x} y2={RULER_H - 1}
          stroke="rgba(255,255,255,0.18)" strokeWidth={1} style={{ pointerEvents: "none" }} />
      ))}
      {majorTicks.map(({ x, label }, i) => (
        <g key={`M${i}`} style={{ pointerEvents: "none" }}>
          <line x1={x} y1={RULER_H - 14} x2={x} y2={RULER_H - 1}
            stroke="rgba(255,255,255,0.4)" strokeWidth={1} />
          <text x={x + 3} y={RULER_H - 17} fontSize={9} fill="rgba(255,255,255,0.4)"
            fontFamily="monospace" fontWeight="600" style={{ userSelect: "none" }}>
            {label}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ─── TrackSVG ────────────────────────────────────────────────────────────────

const SNAP_DEADZONE = 4; // frames

function TrackSVG({
  track,
  waypoints,
  laneHeight,
  maxFrame,
  canvasWidth,
  isLocked,
  isHidden,
  selectedWaypoints,
  primaryFrame,
  onUpdateWaypoints,
  onToggleWaypoint,
  onMarqueeSelect,
  onClearSelection,
  onSetPrimary,
  onSnapFrame,       // (rawFrame) => snappedFrame — cross-track snap from parent
  onSetActiveTrack,  // () => void — notify parent this track became active
}) {
  const svgRef          = useRef(null);
  const dragRef         = useRef(null);
  const marqueeStartRef = useRef(null);

  const [isDragging, setIsDragging] = useState(false);
  const [marquee,    setMarquee]    = useState(null);

  const { color, max, min, unit } = track;
  const pxPerFrame = canvasWidth / maxFrame;
  const ftx        = (frame) => (frame / maxFrame) * canvasWidth;
  const zeroY      = (max / (max - min)) * laneHeight;
  const pathD      = buildPathD(waypoints, maxFrame, canvasWidth);
  const pathColor  = isHidden ? "rgba(100,100,100,0.3)" : color;
  const wpColor    = isLocked  ? "#888888" : pathColor;

  const isWpSelected = (wp) => selectedWaypoints.some((s) => s.frame === wp.frame);

  const svgCoords = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const hitTest = (svgX, svgY) => {
    for (let i = 0; i < waypoints.length; i++) {
      if (Math.abs(svgX - ftx(waypoints[i].frame)) <= HIT_R &&
          Math.abs(svgY - waypoints[i].y) <= HIT_R) return i;
    }
    return -1;
  };

  const hitTestHandle = (svgX, svgY) => {
    // Check all selected waypoints in reverse (top-most first)
    for (let wpIdx = waypoints.length - 1; wpIdx >= 0; wpIdx--) {
      const wp = waypoints[wpIdx];
      if (!isWpSelected(wp)) continue;
      const wx = ftx(wp.frame);
      if (wp.handleIn) {
        const hx = wx + wp.handleIn.dFrame * pxPerFrame;
        const hy = wp.y + wp.handleIn.dY;
        if (Math.hypot(svgX - hx, svgY - hy) <= HANDLE_HIT_R) return { wpIdx, handle: "in" };
      }
      if (wp.handleOut) {
        const hx = wx + wp.handleOut.dFrame * pxPerFrame;
        const hy = wp.y + wp.handleOut.dY;
        if (Math.hypot(svgX - hx, svgY - hy) <= HANDLE_HIT_R) return { wpIdx, handle: "out" };
      }
    }
    return null;
  };

  // ── Pointer handlers ──────────────────────────────────────────────

  const handlePointerDown = (e) => {
    if (isLocked || e.button !== 0) return;
    try { e.target.setPointerCapture(e.pointerId); } catch { /* noop */ }
    const { x, y } = svgCoords(e);

    // Handle circles have priority over waypoint diamonds
    const handleHit = hitTestHandle(x, y);
    if (handleHit) {
      dragRef.current = {
        type: "handle",
        wpIdx: handleHit.wpIdx,
        handle: handleHit.handle,
        startX: x, startY: y,
        initialWaypoints: [...waypoints],
      };
      setIsDragging(true);
      e.preventDefault();
      return;
    }

    const idx = hitTest(x, y);
    if (idx !== -1) {
      onSetActiveTrack?.();
      if (e.shiftKey) {
        onToggleWaypoint({ trackId: track.id, frame: waypoints[idx].frame });
        onSetPrimary(waypoints[idx].frame);
      } else {
        const wp = waypoints[idx];
        const isSelected = isWpSelected(wp);
        let dragFrames = selectedWaypoints.map((s) => s.frame);
        if (!isSelected) {
          onMarqueeSelect([{ trackId: track.id, frame: wp.frame }], true);
          dragFrames = [wp.frame];
        }
        onSetPrimary(wp.frame);
        dragRef.current = {
          type: "waypoint",
          idx, startX: x, startY: y,
          initialWaypoints: [...waypoints],
          dragFrames, hasDragged: false,
          wasAlreadySelected: isSelected,
        };
        setIsDragging(true);
        e.preventDefault();
      }
    } else {
      if (!e.shiftKey) onClearSelection();
      marqueeStartRef.current = { x, y };
    }
  };

  const handlePointerMove = (e) => {
    if (!dragRef.current && !marqueeStartRef.current) return;
    const { x, y } = svgCoords(e);

    if (dragRef.current?.type === "handle") {
      const { wpIdx, handle, initialWaypoints } = dragRef.current;
      const wp   = initialWaypoints[wpIdx];
      const wx   = ftx(wp.frame);
      const prev = initialWaypoints[wpIdx - 1];
      const next = initialWaypoints[wpIdx + 1];

      const rawDFrame = (x - wx) / pxPerFrame;
      const rawDY     = y - wp.y;

      const newWaypoints = initialWaypoints.map((w, i) => {
        if (i !== wpIdx) return w;
        let hi = w.handleIn, ho = w.handleOut;

        if (handle === "out") {
          const maxDF = next ? (next.frame - w.frame) * 0.999 : 0;
          const dFrame = Math.max(0, Math.min(maxDF, rawDFrame));
          const dY     = Math.max(-w.y, Math.min(laneHeight - w.y, rawDY));
          ho = { dFrame, dY };

          if (hi) {
            const outLen = Math.hypot(dFrame * pxPerFrame, dY);
            if (outLen > 0.5) {
              const inLen   = Math.hypot(hi.dFrame * pxPerFrame, hi.dY);
              const scale   = inLen / outLen;
              const minDF   = prev ? (prev.frame - w.frame) * 0.999 : 0;
              const mDFrame = Math.max(minDF, Math.min(0, (-dFrame * pxPerFrame * scale) / pxPerFrame));
              const mDY     = Math.max(-w.y, Math.min(laneHeight - w.y, -dY * scale));
              hi = { dFrame: mDFrame, dY: mDY };
            }
          }
        } else {
          const minDF  = prev ? (prev.frame - w.frame) * 0.999 : 0;
          const dFrame = Math.max(minDF, Math.min(0, rawDFrame));
          const dY     = Math.max(-w.y, Math.min(laneHeight - w.y, rawDY));
          hi = { dFrame, dY };

          if (ho) {
            const inLen = Math.hypot(dFrame * pxPerFrame, dY);
            if (inLen > 0.5) {
              const outLen  = Math.hypot(ho.dFrame * pxPerFrame, ho.dY);
              const scale   = outLen / inLen;
              const maxDF   = next ? (next.frame - w.frame) * 0.999 : 0;
              const mDFrame = Math.max(0, Math.min(maxDF, (-dFrame * pxPerFrame * scale) / pxPerFrame));
              const mDY     = Math.max(-w.y, Math.min(laneHeight - w.y, -dY * scale));
              ho = { dFrame: mDFrame, dY: mDY };
            }
          }
        }

        return { ...w, handleIn: hi, handleOut: ho };
      });

      onUpdateWaypoints(clampHandles(newWaypoints));

    } else if (dragRef.current?.type === "waypoint") {
      const { idx, startX, startY, initialWaypoints, dragFrames } = dragRef.current;

      if (!dragRef.current.hasDragged) {
        if (Math.abs(x - startX) > 0 || Math.abs(y - startY) > 0)
          dragRef.current.hasDragged = true;
      }
      if (!dragRef.current.hasDragged) return;

      const rawFrame     = Math.round((x / canvasWidth) * maxFrame);
      const targetDFrame = rawFrame - initialWaypoints[idx].frame;
      const targetDY     = y - startY;

      let allowedMinDFrame = -Infinity, allowedMaxDFrame = Infinity;
      let allowedMinDY    = -Infinity, allowedMaxDY    = Infinity;

      initialWaypoints.forEach((wp, i) => {
        if (!dragFrames.includes(wp.frame)) return;
        if (wp.frame === 0 || wp.frame === maxFrame) return;
        allowedMinDY = Math.max(allowedMinDY, 0 - wp.y);
        allowedMaxDY = Math.min(allowedMaxDY, laneHeight - wp.y);
        let leftBound = 0;
        for (let j = i - 1; j >= 0; j--) {
          if (!dragFrames.includes(initialWaypoints[j].frame)) { leftBound = initialWaypoints[j].frame + 1; break; }
        }
        let rightBound = maxFrame;
        for (let j = i + 1; j < initialWaypoints.length; j++) {
          if (!dragFrames.includes(initialWaypoints[j].frame)) { rightBound = initialWaypoints[j].frame - 1; break; }
        }
        allowedMinDFrame = Math.max(allowedMinDFrame, leftBound - wp.frame);
        allowedMaxDFrame = Math.min(allowedMaxDFrame, rightBound - wp.frame);
      });

      let finalDFrame = Math.max(allowedMinDFrame, Math.min(allowedMaxDFrame, targetDFrame));
      const finalDY   = Math.max(allowedMinDY,    Math.min(allowedMaxDY,    targetDY));

      // Snap single movable waypoint to a frame on another track
      if (onSnapFrame) {
        const movers = initialWaypoints.filter(
          (wp) => dragFrames.includes(wp.frame) && wp.frame !== 0 && wp.frame !== maxFrame
        );
        if (movers.length === 1) {
          const proposed = movers[0].frame + finalDFrame;
          const snapped  = onSnapFrame(proposed);
          if (snapped !== proposed) {
            finalDFrame = Math.max(allowedMinDFrame, Math.min(allowedMaxDFrame, snapped - movers[0].frame));
          }
        }
      }

      const newWaypoints = initialWaypoints.map((wp) => {
        if (!dragFrames.includes(wp.frame)) return wp;
        const isEndpt = wp.frame === 0 || wp.frame === maxFrame;
        return isEndpt ? wp : { ...wp, frame: wp.frame + finalDFrame, y: wp.y + finalDY };
      });

      const newSelectedFrames = initialWaypoints
        .filter((wp) => dragFrames.includes(wp.frame))
        .map((wp) => wp.frame === 0 || wp.frame === maxFrame ? wp.frame : wp.frame + finalDFrame);

      onUpdateWaypoints(clampHandles(newWaypoints), newSelectedFrames);

    } else if (marqueeStartRef.current) {
      const { x: x0, y: y0 } = marqueeStartRef.current;
      if (Math.hypot(x - x0, y - y0) > MARQUEE_THRESHOLD) setMarquee({ x0, y0, x1: x, y1: y });
    }
  };

  const handlePointerUp = (e) => {
    try { e.target.releasePointerCapture(e.pointerId); } catch { /* noop */ }

    if (dragRef.current) {
      if (dragRef.current.type === "waypoint" &&
          !dragRef.current.hasDragged &&
          dragRef.current.wasAlreadySelected &&
          !e.shiftKey) {
        const wp = waypoints[dragRef.current.idx];
        onMarqueeSelect([{ trackId: track.id, frame: wp.frame }], true);
        onSetPrimary(wp.frame);
      }
      dragRef.current = null;
      setIsDragging(false);
    } else if (marqueeStartRef.current) {
      if (marquee) {
        const minX = Math.min(marquee.x0, marquee.x1), maxX = Math.max(marquee.x0, marquee.x1);
        const minY = Math.min(marquee.y0, marquee.y1), maxY = Math.max(marquee.y0, marquee.y1);
        const captured = waypoints
          .filter((wp) => { const wx = ftx(wp.frame); return wx >= minX && wx <= maxX && wp.y >= minY && wp.y <= maxY; })
          .map((wp) => ({ trackId: track.id, frame: wp.frame }));
        if (captured.length > 0) onSetPrimary(captured[captured.length - 1].frame);
        onMarqueeSelect(captured, !e.shiftKey);
        setMarquee(null);
      }
      marqueeStartRef.current = null;
    }
  };

  const handlePointerCancel = (e) => {
    try { e.target.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    dragRef.current = null;
    setIsDragging(false);
    if (marquee) setMarquee(null);
    marqueeStartRef.current = null;
  };

  const handleDoubleClick = (e) => {
    if (isLocked) return;
    const { x, y } = svgCoords(e);
    if (hitTest(x, y) !== -1 || hitTestHandle(x, y)) return;
    const frame = Math.max(1, Math.min(maxFrame - 1, Math.round((x / canvasWidth) * maxFrame)));
    const newY  = Math.max(0, Math.min(laneHeight, y));
    const nextWaypoints = [...waypoints, { frame, y: newY, handleIn: null, handleOut: null }].sort((a, b) => a.frame - b.frame);
    onUpdateWaypoints(clampHandles(nextWaypoints));
    onSetPrimary(frame);
    onSetActiveTrack?.();
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    if (isLocked) return;
    const { x, y } = svgCoords(e);
    const idx = hitTest(x, y);
    if (idx === -1) return;
    const wp = waypoints[idx];
    if (wp.frame === 0 || wp.frame === maxFrame) return;
    onUpdateWaypoints(clampHandles(waypoints.filter((_, i) => i !== idx)));
  };


  // ── Render ────────────────────────────────────────────────────────

  return (
    <svg
      ref={svgRef}
      className="absolute inset-0 z-10"
      width={canvasWidth}
      height={laneHeight}
      style={{
        overflow: "visible",
        pointerEvents: isLocked ? "none" : "all",
        cursor: isDragging ? "grabbing" : "crosshair",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Zero line */}
      <line
        x1={0} y1={zeroY} x2={canvasWidth} y2={zeroY}
        stroke={isHidden ? "rgba(100,100,100,0.15)" : "rgba(255,255,255,0.12)"}
        strokeWidth={1} strokeDasharray="4 4" style={{ pointerEvents: "none" }}
      />

      {/* Limit labels */}
      <text x={6} y={14} fontSize={9} fontWeight="700" letterSpacing="0.05em"
        fill={isHidden ? "rgba(100,100,100,0.2)" : "rgba(255,255,255,0.25)"}
        style={{ pointerEvents: "none" }}>
        {max > 0 && min < 0 ? `+${max}` : max}{unit}
      </text>
      <text x={6} y={laneHeight - 5} fontSize={9} fontWeight="700" letterSpacing="0.05em"
        fill={isHidden ? "rgba(100,100,100,0.2)" : "rgba(255,255,255,0.25)"}
        style={{ pointerEvents: "none" }}>
        {min}{unit}
      </text>

      {/* Curve path */}
      {pathD && (
        <path d={pathD} fill="none" stroke={pathColor} strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round"
          opacity={isHidden ? 0.4 : 0.85} style={{ pointerEvents: "none" }} />
      )}

      {/* Bezier handles for all selected waypoints */}
      {!isLocked && !isHidden && waypoints.filter(isWpSelected).map((wp) => (
        <g key={`handles-${wp.frame}`}>
          {wp.handleIn && (() => {
            const wx = ftx(wp.frame);
            const hx = wx + wp.handleIn.dFrame * pxPerFrame;
            const hy = wp.y + wp.handleIn.dY;
            return (
              <g>
                <line x1={wx} y1={wp.y} x2={hx} y2={hy}
                  stroke="rgba(255,255,255,0.35)" strokeWidth={1} style={{ pointerEvents: "none" }} />
                <circle cx={hx} cy={hy} r={HANDLE_R}
                  fill="#1B1B1D" stroke="rgba(255,255,255,0.85)" strokeWidth={1.5}
                  style={{ cursor: isDragging ? "grabbing" : "grab" }} />
              </g>
            );
          })()}
          {wp.handleOut && (() => {
            const wx = ftx(wp.frame);
            const hx = wx + wp.handleOut.dFrame * pxPerFrame;
            const hy = wp.y + wp.handleOut.dY;
            return (
              <g>
                <line x1={wx} y1={wp.y} x2={hx} y2={hy}
                  stroke="rgba(255,255,255,0.35)" strokeWidth={1} style={{ pointerEvents: "none" }} />
                <circle cx={hx} cy={hy} r={HANDLE_R}
                  fill="#1B1B1D" stroke="rgba(255,255,255,0.85)" strokeWidth={1.5}
                  style={{ cursor: isDragging ? "grabbing" : "grab" }} />
              </g>
            );
          })()}
        </g>
      ))}

      {/* Waypoint diamonds */}
      {waypoints.map((wp, idx) => {
        const x = ftx(wp.frame), y = wp.y, r = DIAMOND_R;
        const selected   = isWpSelected(wp);
        const isPrimary  = wp.frame === primaryFrame;
        const isEndpoint = wp.frame === 0 || wp.frame === maxFrame;
        return (
          <polygon
            key={idx}
            points={`${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`}
            fill={wpColor}
            stroke={selected ? "white" : isEndpoint ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.55)"}
            strokeWidth={isPrimary ? 2.5 : selected ? 2 : 1}
            style={{
              pointerEvents: "none",
              cursor: isDragging ? "grabbing" : "grab",
              filter: selected ? `drop-shadow(0 0 4px ${color})` : "none",
            }}
          />
        );
      })}

      {/* Marquee selection rectangle */}
      {marquee && (
        <rect
          x={Math.min(marquee.x0, marquee.x1)} y={Math.min(marquee.y0, marquee.y1)}
          width={Math.abs(marquee.x1 - marquee.x0)} height={Math.abs(marquee.y1 - marquee.y0)}
          fill="rgba(255,213,0,0.06)" stroke="rgba(255,213,0,0.55)"
          strokeWidth={1} strokeDasharray="4 3" style={{ pointerEvents: "none" }}
        />
      )}
    </svg>
  );
}

// ─── CurveEditor (root) ───────────────────────────────────────────────────────

const CurveEditor = forwardRef(function CurveEditor({
  maxFrame,
  canvasWidth = BASE_CANVAS_W,
  isSnapping = true,
  onSetActiveTrack,   // (trackId: string) => void
  onWaypointsChange,  // (trackId: string, waypoints: array) => void
  lockedTracks,
  hiddenTracks,
}, ref) {
  const laneRef0 = useRef(null);
  const laneRef1 = useRef(null);
  const laneRef2 = useRef(null);
  const laneRefs = [laneRef0, laneRef1, laneRef2];

  const prevMaxFrameRef = useRef(maxFrame);

  const [laneHeights,       setLaneHeights]      = useState([100, 100, 100]);
  const [trackData,         setTrackData]         = useState(() =>
    Object.fromEntries(TRACKS.map((t) => [t.id, makeDefaultWaypoints(t, 100, maxFrame)]))
  );
  const [selectedWaypoints, setSelectedWaypoints] = useState([]);
  const [primarySelection,  setPrimarySelection]  = useState(null); // { trackId, frame } | null

  // Measure actual lane heights after mount.
  useEffect(() => {
    const heights = laneRefs.map((r) => r.current?.clientHeight ?? 100);
    setLaneHeights(heights); // eslint-disable-line react-hooks/set-state-in-effect
    setTrackData(Object.fromEntries(
      TRACKS.map((t, i) => [t.id, makeDefaultWaypoints(t, heights[i], maxFrame)])
    ));
    prevMaxFrameRef.current = maxFrame;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Migrate endpoint waypoints when duration changes.
  useEffect(() => {
    const prev = prevMaxFrameRef.current;
    if (prev === maxFrame) return;
    prevMaxFrameRef.current = maxFrame;

    setTrackData((td) =>
      Object.fromEntries(Object.entries(td).map(([trackId, wps]) => {
        const seen = new Set();
        const updated = wps
          .map((wp) =>
            wp.frame === prev   ? { ...wp, frame: maxFrame }     :
            wp.frame > maxFrame ? { ...wp, frame: maxFrame - 1 } : wp
          )
          .sort((a, b) => a.frame - b.frame)
          .filter((wp) => { if (seen.has(wp.frame)) return false; seen.add(wp.frame); return true; });
        return [trackId, updated];
      }))
    );
    setSelectedWaypoints((sel) =>
      sel.map((s) => s.frame === prev ? { ...s, frame: maxFrame } : s)
         .filter((s) => s.frame <= maxFrame)
    );
    setPrimarySelection((p) =>
      !p                ? null :
      p.frame === prev  ? { ...p, frame: maxFrame } :
      p.frame > maxFrame ? null : p
    );
  }, [maxFrame]);

  // Notify parent whenever trackData changes (mirrors internal state for sidebar).
  useEffect(() => {
    if (!onWaypointsChange) return;
    TRACKS.forEach(({ id }) => onWaypointsChange(id, trackData[id] ?? []));
  }, [trackData]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Selection helpers ─────────────────────────────────────────────

  const toggleWaypoint = ({ trackId, frame }) => {
    setSelectedWaypoints((prev) => {
      const exists = prev.some((s) => s.trackId === trackId && s.frame === frame);
      return exists
        ? prev.filter((s) => !(s.trackId === trackId && s.frame === frame))
        : [...prev, { trackId, frame }];
    });
  };

  const handleMarqueeSelect = (additions, replace) => {
    setSelectedWaypoints((prev) => {
      if (replace) return additions;
      const deduped = additions.filter((a) => !prev.some((s) => s.trackId === a.trackId && s.frame === a.frame));
      return [...prev, ...deduped];
    });
  };

  const clearSelection = () => {
    setSelectedWaypoints([]);
    setPrimarySelection(null);
  };

  const handleSetPrimary = (trackId, frame) => {
    setPrimarySelection(frame !== null ? { trackId, frame } : null);
  };

  // ── Waypoint update ────────────────────────────────────────────────

  const updateWaypoints = (trackId, updated, newSelectedFrames) => {
    setTrackData((prev) => ({ ...prev, [trackId]: updated }));
    if (newSelectedFrames) {
      setSelectedWaypoints((prev) => [
        ...prev.filter((s) => s.trackId !== trackId),
        ...newSelectedFrames.map((f) => ({ trackId, frame: f })),
      ]);
    } else {
      setSelectedWaypoints((prev) =>
        prev.filter((s) => s.trackId !== trackId || updated.some((wp) => wp.frame === s.frame))
      );
    }
  };

  // Returns snapped frame for a cross-track waypoint drag.
  const getSnapFrame = (rawFrame, excludeTrackId) => {
    if (!isSnapping) return rawFrame;
    let best = rawFrame, bestDist = SNAP_DEADZONE + 1;
    TRACKS.forEach((t) => {
      if (t.id === excludeTrackId) return;
      (trackData[t.id] || []).forEach((wp) => {
        const d = Math.abs(wp.frame - rawFrame);
        if (d < bestDist) { bestDist = d; best = wp.frame; }
      });
    });
    return best;
  };

  // ── API exposed to parent via ref ─────────────────────────────────

  useImperativeHandle(ref, () => ({
    applyEasing(type, allOnTrack) {
      if (!primarySelection) return;
      const { trackId } = primarySelection;
      setTrackData((current) => {
        const wps = current[trackId];
        if (!wps) return current;
        let frames;
        if (allOnTrack) {
          frames = type === "linear"
            ? wps.map((wp) => wp.frame)
            : wps.filter((wp) => wp.frame !== 0 && wp.frame !== maxFrame).map((wp) => wp.frame);
        } else {
          const selFrames = selectedWaypoints.filter((s) => s.trackId === trackId).map((s) => s.frame);
          frames = selFrames.length > 0 ? selFrames : [primarySelection.frame];
        }
        return { ...current, [trackId]: applyEasingToWaypoints(wps, frames, type) };
      });
    },

    getAllWaypointFrames() {
      const frames = new Set();
      Object.values(trackData).forEach((wps) => wps.forEach((wp) => frames.add(wp.frame)));
      return [...frames].sort((a, b) => a - b);
    },

    resetTrack(trackId) {
      if (!trackId) return;
      setTrackData((current) => {
        const wps = current[trackId];
        if (!wps) return current;
        const start = wps.find((wp) => wp.frame === 0);
        const end   = wps.find((wp) => wp.frame === maxFrame);
        return { ...current, [trackId]: [start, end].filter(Boolean) };
      });
      setSelectedWaypoints((prev) => prev.filter((s) => s.trackId !== trackId));
    },

    addWaypointAt(trackId, frame) {
      const trackIdx = TRACKS.findIndex((t) => t.id === trackId);
      const lh = laneHeights[trackIdx] ?? 100;
      const f  = Math.max(1, Math.min(maxFrame - 1, frame));
      setTrackData((current) => {
        const wps = current[trackId] ?? [];
        if (wps.some((wp) => wp.frame === f)) return current;
        const prev = [...wps].reverse().find((wp) => wp.frame < f);
        const next = wps.find((wp) => wp.frame > f);
        let y = lh / 2;
        if (prev && next) {
          const t = (f - prev.frame) / (next.frame - prev.frame);
          y = prev.y + t * (next.y - prev.y);
        } else if (prev) { y = prev.y; }
        else if (next)   { y = next.y; }
        const newWps = [...wps, { frame: f, y, handleIn: null, handleOut: null }]
          .sort((a, b) => a.frame - b.frame);
        return { ...current, [trackId]: clampHandles(newWps) };
      });
    },

    removeWaypointAt(trackId, frame) {
      if (frame === 0 || frame === maxFrame) return;
      setTrackData((current) => {
        const wps = current[trackId] ?? [];
        return { ...current, [trackId]: clampHandles(wps.filter((wp) => wp.frame !== frame)) };
      });
    },
  }), [primarySelection, selectedWaypoints, maxFrame, trackData, laneHeights]);

  // ── Render ────────────────────────────────────────────────────────

  return (
    <>
      {TRACKS.map((track, i) => {
        const isLocked     = lockedTracks?.has(track.id) ?? false;
        const isHidden     = hiddenTracks?.has(track.id) ?? false;
        const trackSel     = selectedWaypoints.filter((s) => s.trackId === track.id);
        const primaryFrame = primarySelection?.trackId === track.id ? primarySelection.frame : null;

        return (
          <div
            key={track.id}
            ref={laneRefs[i]}
            className="flex-1 border-b border-[#1B1B1D] relative overflow-hidden"
          >
            <div className="absolute inset-0 bg-hex-mesh pointer-events-none transition-opacity duration-300 z-0"
              style={{ opacity: isHidden ? 1 : 0 }} />
            <div className="absolute inset-0 bg-white/[0.04] pointer-events-none transition-opacity duration-300 z-20"
              style={{ opacity: isLocked ? 1 : 0 }} />

            <TrackSVG
              track={track}
              waypoints={trackData[track.id]}
              laneHeight={laneHeights[i]}
              maxFrame={maxFrame}
              canvasWidth={canvasWidth}
              isLocked={isLocked}
              isHidden={isHidden}
              selectedWaypoints={trackSel}
              primaryFrame={primaryFrame}
              onUpdateWaypoints={(updated, newSel) => updateWaypoints(track.id, updated, newSel)}
              onToggleWaypoint={toggleWaypoint}
              onMarqueeSelect={handleMarqueeSelect}
              onClearSelection={clearSelection}
              onSetPrimary={(frame) => handleSetPrimary(track.id, frame)}
              onSnapFrame={(rawFrame) => getSnapFrame(rawFrame, track.id)}
              onSetActiveTrack={() => onSetActiveTrack?.(track.id)}
            />
          </div>
        );
      })}
    </>
  );
});

export default CurveEditor;
