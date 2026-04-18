import { useState, useRef, useEffect } from "react";

export const CINEMATIC_FPS = 24;
const BASE_CANVAS_W = 6000; // unzoomed width; scaled by zoomLevel in the parent
const DIAMOND_R = 5;
const HIT_R = DIAMOND_R + 4;
const MARQUEE_THRESHOLD = 4;
const RULER_H = 30; // must match h-[30px] ruler container in App.jsx

const TRACKS = [
  { id: "slide", name: "Slide", color: "#3993DD", max: 28, min: 0, unit: "in" },
  { id: "pan", name: "Pan", color: "#ff4444", max: 360, min: -360, unit: "°" },
  { id: "tilt", name: "Tilt", color: "#44ff44", max: 45, min: -45, unit: "°" },
];

function makeDefaultWaypoints(track, laneHeight, maxFrame) {
  const zeroY = (track.max / (track.max - track.min)) * laneHeight;
  return [
    { frame: 0, y: zeroY, handleIn: null, handleOut: null },
    { frame: maxFrame, y: zeroY, handleIn: null, handleOut: null },
  ];
}

function buildPathD(waypoints, maxFrame, canvasWidth) {
  if (waypoints.length < 2) return "";
  const ftx = (f) => (f / maxFrame) * canvasWidth;
  const pxPerFrame = canvasWidth / maxFrame;
  const pts = waypoints.map((wp) => ({
    x: ftx(wp.frame),
    y: wp.y,
    hi: wp.handleIn,
    ho: wp.handleOut,
  }));
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const cur = pts[i],
      nxt = pts[i + 1];
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

// ─── TimelineRuler ────────────────────────────────────────────────────────────

function computeRulerTicks(canvasWidth, maxFrame) {
  const durationS = maxFrame / CINEMATIC_FPS;
  const pxPerSec = canvasWidth / durationS;
  const pxPerFrame = canvasWidth / maxFrame;

  // Choose the coarsest "nice" second interval where major ticks are ≥ 60 px apart.
  const SEC_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const majorSec = SEC_STEPS.find((s) => pxPerSec * s >= 60) ?? 600;

  // Show minor frame ticks only when there is enough room.
  let minorFrameStep = null;
  if (pxPerFrame >= 30) minorFrameStep = 1;
  else if (pxPerFrame >= 15) minorFrameStep = 2;
  else if (pxPerFrame >= 8) minorFrameStep = 4;
  else if (pxPerFrame >= 4) minorFrameStep = 6;

  return { majorSec, minorFrameStep, durationS };
}

function fmtSec(s) {
  if (s === 0) return "0";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}:${String(r).padStart(2, "0")}`;
}

export function TimelineRuler({ canvasWidth, maxFrame, onFrameChange }) {
  const svgRef = useRef(null);
  const { majorSec, minorFrameStep, durationS } = computeRulerTicks(
    canvasWidth,
    maxFrame,
  );

  // Build major ticks (at whole-second boundaries).
  const majorTicks = [];
  for (let s = 0; s <= durationS + 0.001; s += majorSec) {
    const frame = Math.round(s * CINEMATIC_FPS);
    if (frame > maxFrame) break;
    majorTicks.push({
      x: (frame / maxFrame) * canvasWidth,
      label: fmtSec(Math.round(s)),
    });
  }

  // Build minor frame ticks (skipping positions already covered by major ticks).
  const minorTicks = [];
  if (minorFrameStep) {
    for (let f = 0; f <= maxFrame; f += minorFrameStep) {
      const s = f / CINEMATIC_FPS;
      // Skip if this frame aligns with a major tick.
      if (
        Math.abs(s % majorSec) < 0.001 ||
        Math.abs((s % majorSec) - majorSec) < 0.001
      )
        continue;
      minorTicks.push({ x: (f / maxFrame) * canvasWidth });
    }
  }

  const handleClick = (e) => {
    if (!svgRef.current) return;
    const x = e.clientX - svgRef.current.getBoundingClientRect().left;
    const frame = Math.max(
      0,
      Math.min(maxFrame, Math.round((x / canvasWidth) * maxFrame)),
    );
    onFrameChange?.(frame);
  };

  return (
    <svg
      ref={svgRef}
      width={canvasWidth}
      height={RULER_H}
      style={{ display: "block", cursor: "ew-resize" }}
      onClick={handleClick}
    >
      {/* Baseline */}
      <line
        x1={0}
        y1={RULER_H - 1}
        x2={canvasWidth}
        y2={RULER_H - 1}
        stroke="rgba(255,255,255,0.08)"
        strokeWidth={1}
      />

      {/* Minor frame ticks */}
      {minorTicks.map(({ x }, i) => (
        <line
          key={`m${i}`}
          x1={x}
          y1={RULER_H - 6}
          x2={x}
          y2={RULER_H - 1}
          stroke="rgba(255,255,255,0.18)"
          strokeWidth={1}
          style={{ pointerEvents: "none" }}
        />
      ))}

      {/* Major second ticks + labels */}
      {majorTicks.map(({ x, label }, i) => (
        <g key={`M${i}`} style={{ pointerEvents: "none" }}>
          <line
            x1={x}
            y1={RULER_H - 14}
            x2={x}
            y2={RULER_H - 1}
            stroke="rgba(255,255,255,0.4)"
            strokeWidth={1}
          />
          <text
            x={i === 0 ? x + 4 : x - 4}
            y={RULER_H - 17}
            fontSize={9}
            fill="rgba(255,255,255,0.4)"
            fontFamily="monospace"
            fontWeight="600"
            textAnchor={i === 0 ? "start" : "end"}
            style={{ userSelect: "none" }}
          >
            {label}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ─── TrackSVG ────────────────────────────────────────────────────────────────

function TrackSVG({
  track,
  waypoints,
  laneHeight,
  maxFrame,
  canvasWidth,
  isLocked,
  isHidden,
  selectedWaypoints, // Array<{ trackId, frame }> — pre-filtered to this track
  onUpdateWaypoints,
  onToggleWaypoint, // ({ trackId, frame }) → void
  onMarqueeSelect, // (Array<{ trackId, frame }>, replace: boolean) → void
  onClearSelection, // () → void
  onFrameChange, // (frame: number) → void  (kept for future use)
}) {
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const marqueeStartRef = useRef(null); // { x, y } | null

  const [isDragging, setIsDragging] = useState(false);
  const [marquee, setMarquee] = useState(null); // { x0,y0,x1,y1 } | null

  const { color, max, min, unit } = track;

  // All pixel math uses the dynamic canvasWidth prop.
  const ftx = (frame) => (frame / maxFrame) * canvasWidth;
  const zeroY = (max / (max - min)) * laneHeight;
  const pathD = buildPathD(waypoints, maxFrame, canvasWidth);

  const pathColor = isHidden ? "rgba(100,100,100,0.3)" : color;
  const wpColor = isLocked ? "#888888" : pathColor;

  const isWpSelected = (wp) =>
    selectedWaypoints.some((s) => s.frame === wp.frame);

  // ── Coordinate helpers ────────────────────────────────────────────

  const svgCoords = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const hitTest = (svgX, svgY) => {
    for (let i = 0; i < waypoints.length; i++) {
      if (
        Math.abs(svgX - ftx(waypoints[i].frame)) <= HIT_R &&
        Math.abs(svgY - waypoints[i].y) <= HIT_R
      )
        return i;
    }
    return -1;
  };

  // ── Pointer handlers ──────────────────────────────────────────────

  const handlePointerDown = (e) => {
    if (isLocked || e.button !== 0) return;
    try {
      e.target.setPointerCapture(e.pointerId);
    } catch (_) {}
    const { x, y } = svgCoords(e);
    const idx = hitTest(x, y);

    if (idx !== -1) {
      if (e.shiftKey) {
        onToggleWaypoint({ trackId: track.id, frame: waypoints[idx].frame });
      } else {
        const wp = waypoints[idx];
        const isSelected = isWpSelected(wp);
        let dragFrames = selectedWaypoints.map((s) => s.frame);

        if (!isSelected) {
          onMarqueeSelect([{ trackId: track.id, frame: wp.frame }], true);
          dragFrames = [wp.frame];
        }

        dragRef.current = {
          idx,
          startX: x,
          startY: y,
          initialWaypoints: [...waypoints],
          dragFrames,
          hasDragged: false,
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
    if (dragRef.current) {
      // ── Waypoint drag ──
      const { x, y } = svgCoords(e);
      const { idx, startX, startY, initialWaypoints, dragFrames } =
        dragRef.current;

      if (!dragRef.current.hasDragged) {
        if (Math.abs(x - startX) > 0 || Math.abs(y - startY) > 0)
          dragRef.current.hasDragged = true;
      }
      if (!dragRef.current.hasDragged) return;

      const rawFrame = Math.round((x / canvasWidth) * maxFrame);
      const targetDFrame = rawFrame - initialWaypoints[idx].frame;
      const targetDY = y - startY;

      let allowedMinDFrame = -Infinity,
        allowedMaxDFrame = Infinity;
      let allowedMinDY = -Infinity,
        allowedMaxDY = Infinity;

      initialWaypoints.forEach((wp, i) => {
        if (!dragFrames.includes(wp.frame)) return;
        allowedMinDY = Math.max(allowedMinDY, 0 - wp.y);
        allowedMaxDY = Math.min(allowedMaxDY, laneHeight - wp.y);
        if (wp.frame === 0 || wp.frame === maxFrame) return;

        let leftBound = 0;
        for (let j = i - 1; j >= 0; j--) {
          if (!dragFrames.includes(initialWaypoints[j].frame)) {
            leftBound = initialWaypoints[j].frame + 1;
            break;
          }
        }
        let rightBound = maxFrame;
        for (let j = i + 1; j < initialWaypoints.length; j++) {
          if (!dragFrames.includes(initialWaypoints[j].frame)) {
            rightBound = initialWaypoints[j].frame - 1;
            break;
          }
        }
        allowedMinDFrame = Math.max(allowedMinDFrame, leftBound - wp.frame);
        allowedMaxDFrame = Math.min(allowedMaxDFrame, rightBound - wp.frame);
      });

      const finalDFrame = Math.max(
        allowedMinDFrame,
        Math.min(allowedMaxDFrame, targetDFrame),
      );
      const finalDY = Math.max(allowedMinDY, Math.min(allowedMaxDY, targetDY));

      const newWaypoints = initialWaypoints.map((wp) => {
        if (!dragFrames.includes(wp.frame)) return wp;
        const isEndpt = wp.frame === 0 || wp.frame === maxFrame;
        return {
          ...wp,
          frame: isEndpt ? wp.frame : wp.frame + finalDFrame,
          y: wp.y + finalDY,
        };
      });

      const newSelectedFrames = initialWaypoints
        .filter((wp) => dragFrames.includes(wp.frame))
        .map((wp) =>
          wp.frame === 0 || wp.frame === maxFrame
            ? wp.frame
            : wp.frame + finalDFrame,
        );

      onUpdateWaypoints(newWaypoints, newSelectedFrames);
    } else if (marqueeStartRef.current) {
      // ── Marquee draw ──
      const { x, y } = svgCoords(e);
      const { x: x0, y: y0 } = marqueeStartRef.current;
      if (Math.hypot(x - x0, y - y0) > MARQUEE_THRESHOLD) {
        setMarquee({ x0, y0, x1: x, y1: y });
      }
    }
  };

  const handlePointerUp = (e) => {
    try {
      e.target.releasePointerCapture(e.pointerId);
    } catch (_) {}

    if (dragRef.current) {
      if (
        !dragRef.current.hasDragged &&
        dragRef.current.wasAlreadySelected &&
        !e.shiftKey
      ) {
        const wp = waypoints[dragRef.current.idx];
        onMarqueeSelect([{ trackId: track.id, frame: wp.frame }], true);
      }
      dragRef.current = null;
      setIsDragging(false);
    } else if (marqueeStartRef.current) {
      if (marquee) {
        const minX = Math.min(marquee.x0, marquee.x1);
        const maxX = Math.max(marquee.x0, marquee.x1);
        const minY = Math.min(marquee.y0, marquee.y1);
        const maxY = Math.max(marquee.y0, marquee.y1);
        const captured = waypoints
          .filter((wp) => {
            const wx = ftx(wp.frame);
            return wx >= minX && wx <= maxX && wp.y >= minY && wp.y <= maxY;
          })
          .map((wp) => ({ trackId: track.id, frame: wp.frame }));
        onMarqueeSelect(captured, !e.shiftKey);
        setMarquee(null);
      }
      marqueeStartRef.current = null;
    }
  };

  const handlePointerCancel = (e) => {
    try {
      e.target.releasePointerCapture(e.pointerId);
    } catch (_) {}
    dragRef.current = null;
    setIsDragging(false);
    if (marquee) setMarquee(null);
    marqueeStartRef.current = null;
  };

  const handleDoubleClick = (e) => {
    if (isLocked) return;
    const { x, y } = svgCoords(e);
    if (hitTest(x, y) !== -1) return;
    const frame = Math.max(
      1,
      Math.min(maxFrame - 1, Math.round((x / canvasWidth) * maxFrame)),
    );
    const newY = Math.max(0, Math.min(laneHeight, y));
    onUpdateWaypoints(
      [...waypoints, { frame, y: newY, handleIn: null, handleOut: null }].sort(
        (a, b) => a.frame - b.frame,
      ),
    );
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    if (isLocked) return;
    const { x, y } = svgCoords(e);
    const idx = hitTest(x, y);
    if (idx === -1) return;
    const wp = waypoints[idx];
    if (wp.frame === 0 || wp.frame === maxFrame) return;
    onUpdateWaypoints(waypoints.filter((_, i) => i !== idx));
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
      {/* Zero / value-zero line */}
      <line
        x1={0}
        y1={zeroY}
        x2={canvasWidth}
        y2={zeroY}
        stroke={isHidden ? "rgba(100,100,100,0.15)" : "rgba(255,255,255,0.12)"}
        strokeWidth={1}
        strokeDasharray="4 4"
        style={{ pointerEvents: "none" }}
      />

      {/* Limit labels */}
      <text
        x={6}
        y={14}
        fontSize={9}
        fontWeight="700"
        letterSpacing="0.05em"
        fill={isHidden ? "rgba(100,100,100,0.2)" : "rgba(255,255,255,0.25)"}
        style={{ pointerEvents: "none" }}
      >
        {max > 0 && min < 0 ? `+${max}` : max}
        {unit}
      </text>
      <text
        x={6}
        y={laneHeight - 5}
        fontSize={9}
        fontWeight="700"
        letterSpacing="0.05em"
        fill={isHidden ? "rgba(100,100,100,0.2)" : "rgba(255,255,255,0.25)"}
        style={{ pointerEvents: "none" }}
      >
        {min}
        {unit}
      </text>

      {/* Curve path */}
      {pathD && (
        <path
          d={pathD}
          fill="none"
          stroke={pathColor}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={isHidden ? 0.4 : 0.85}
          style={{ pointerEvents: "none" }}
        />
      )}

      {/* Waypoint diamonds */}
      {waypoints.map((wp, idx) => {
        const x = ftx(wp.frame);
        const y = wp.y;
        const r = DIAMOND_R;
        const selected = isWpSelected(wp);
        const isEndpoint = wp.frame === 0 || wp.frame === maxFrame;
        return (
          <polygon
            key={idx}
            points={`${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`}
            fill={wpColor}
            stroke={
              selected
                ? "white"
                : isEndpoint
                  ? "rgba(255,255,255,0.5)"
                  : "rgba(0,0,0,0.55)"
            }
            strokeWidth={selected ? 2 : 1}
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
          x={Math.min(marquee.x0, marquee.x1)}
          y={Math.min(marquee.y0, marquee.y1)}
          width={Math.abs(marquee.x1 - marquee.x0)}
          height={Math.abs(marquee.y1 - marquee.y0)}
          fill="rgba(255,213,0,0.06)"
          stroke="rgba(255,213,0,0.55)"
          strokeWidth={1}
          strokeDasharray="4 3"
          style={{ pointerEvents: "none" }}
        />
      )}
    </svg>
  );
}

// ─── CurveEditor (root) ───────────────────────────────────────────────────────

export default function CurveEditor({
  maxFrame,
  canvasWidth = BASE_CANVAS_W, // scaled by zoomLevel in parent
  onFrameChange,
  lockedTracks,
  hiddenTracks,
}) {
  const ref0 = useRef(null);
  const ref1 = useRef(null);
  const ref2 = useRef(null);
  const laneRefs = [ref0, ref1, ref2];

  const prevMaxFrameRef = useRef(maxFrame);

  const [laneHeights, setLaneHeights] = useState([100, 100, 100]);
  const [trackData, setTrackData] = useState(() =>
    Object.fromEntries(
      TRACKS.map((t) => [t.id, makeDefaultWaypoints(t, 100, maxFrame)]),
    ),
  );
  const [selectedWaypoints, setSelectedWaypoints] = useState([]);

  // Measure actual lane heights after mount.
  useEffect(() => {
    const heights = laneRefs.map((r) => r.current?.clientHeight ?? 100);
    setLaneHeights(heights);
    setTrackData(
      Object.fromEntries(
        TRACKS.map((t, i) => [
          t.id,
          makeDefaultWaypoints(t, heights[i], maxFrame),
        ]),
      ),
    );
    prevMaxFrameRef.current = maxFrame;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Migrate endpoint waypoints when duration changes.
  useEffect(() => {
    const prev = prevMaxFrameRef.current;
    if (prev === maxFrame) return;
    prevMaxFrameRef.current = maxFrame;

    setTrackData((td) =>
      Object.fromEntries(
        Object.entries(td).map(([trackId, wps]) => {
          const seen = new Set();
          const updated = wps
            .map((wp) => {
              if (wp.frame === prev) return { ...wp, frame: maxFrame };
              if (wp.frame > maxFrame) return { ...wp, frame: maxFrame - 1 };
              return wp;
            })
            .sort((a, b) => a.frame - b.frame)
            .filter((wp) => {
              if (seen.has(wp.frame)) return false;
              seen.add(wp.frame);
              return true;
            });
          return [trackId, updated];
        }),
      ),
    );

    setSelectedWaypoints((sel) =>
      sel
        .map((s) => (s.frame === prev ? { ...s, frame: maxFrame } : s))
        .filter((s) => s.frame <= maxFrame),
    );
  }, [maxFrame]);

  // ── Selection helpers ─────────────────────────────────────────────

  const toggleWaypoint = ({ trackId, frame }) => {
    setSelectedWaypoints((prev) => {
      const exists = prev.some(
        (s) => s.trackId === trackId && s.frame === frame,
      );
      return exists
        ? prev.filter((s) => !(s.trackId === trackId && s.frame === frame))
        : [...prev, { trackId, frame }];
    });
  };

  const handleMarqueeSelect = (additions, replace) => {
    setSelectedWaypoints((prev) => {
      if (replace) return additions;
      const deduped = additions.filter(
        (a) =>
          !prev.some((s) => s.trackId === a.trackId && s.frame === a.frame),
      );
      return [...prev, ...deduped];
    });
  };

  const clearSelection = () => setSelectedWaypoints([]);

  // ── Waypoint update (also prunes stale selection entries) ─────────

  const updateWaypoints = (trackId, updated, newSelectedFrames) => {
    setTrackData((prev) => ({ ...prev, [trackId]: updated }));
    if (newSelectedFrames) {
      setSelectedWaypoints((prev) => [
        ...prev.filter((s) => s.trackId !== trackId),
        ...newSelectedFrames.map((f) => ({ trackId, frame: f })),
      ]);
    } else {
      setSelectedWaypoints((prev) =>
        prev.filter(
          (s) =>
            s.trackId !== trackId || updated.some((wp) => wp.frame === s.frame),
        ),
      );
    }
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <>
      {TRACKS.map((track, i) => {
        const isLocked = lockedTracks?.has(track.id) ?? false;
        const isHidden = hiddenTracks?.has(track.id) ?? false;
        const trackSel = selectedWaypoints.filter(
          (s) => s.trackId === track.id,
        );

        return (
          <div
            key={track.id}
            ref={laneRefs[i]}
            className="flex-1 border-b border-[#1B1B1D] relative overflow-hidden"
          >
            <div
              className="absolute inset-0 bg-hex-mesh pointer-events-none transition-opacity duration-300 z-0"
              style={{ opacity: isHidden ? 1 : 0 }}
            />
            <div
              className="absolute inset-0 bg-white/[0.04] pointer-events-none transition-opacity duration-300 z-20"
              style={{ opacity: isLocked ? 1 : 0 }}
            />

            <TrackSVG
              track={track}
              waypoints={trackData[track.id]}
              laneHeight={laneHeights[i]}
              maxFrame={maxFrame}
              canvasWidth={canvasWidth}
              isLocked={isLocked}
              isHidden={isHidden}
              selectedWaypoints={trackSel}
              onUpdateWaypoints={(updated, newSel) =>
                updateWaypoints(track.id, updated, newSel)
              }
              onToggleWaypoint={toggleWaypoint}
              onMarqueeSelect={handleMarqueeSelect}
              onClearSelection={clearSelection}
              onFrameChange={onFrameChange}
            />
          </div>
        );
      })}
    </>
  );
}
