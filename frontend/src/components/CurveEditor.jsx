import { useState, useRef, useEffect } from "react";

const FPS = 30;
const DURATION_S = 120;
const MAX_FRAME = FPS * DURATION_S; // 3600
const CANVAS_WIDTH = 6000;
const DIAMOND_R = 5;
const HIT_R = DIAMOND_R + 4;
const MARQUEE_THRESHOLD = 4; // px before a click becomes a drag/marquee

const TRACKS = [
  { id: "slide", name: "Slide", color: "#3993DD", max: 28, min: 0, unit: "in" },
  { id: "pan", name: "Pan", color: "#ff4444", max: 360, min: -360, unit: "°" },
  { id: "tilt", name: "Tilt", color: "#44ff44", max: 45, min: -45, unit: "°" },
];

const frameToX = (frame) => (frame / MAX_FRAME) * CANVAS_WIDTH;

function makeDefaultWaypoints(track, laneHeight) {
  const zeroY = (track.max / (track.max - track.min)) * laneHeight;
  return [
    { frame: 0, y: zeroY, handleIn: null, handleOut: null },
    { frame: MAX_FRAME, y: zeroY, handleIn: null, handleOut: null },
  ];
}

function buildPathD(waypoints) {
  if (waypoints.length < 2) return "";
  const pxPerFrame = CANVAS_WIDTH / MAX_FRAME;
  const pts = waypoints.map((wp) => ({
    x: frameToX(wp.frame),
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

// ─── TrackSVG ────────────────────────────────────────────────────────────────

function TrackSVG({
  track,
  waypoints,
  laneHeight,
  isLocked,
  isHidden,
  selectedWaypoints, // Array<{ trackId, frame }> — pre-filtered to this track
  onUpdateWaypoints,
  onToggleWaypoint, // ({ trackId, frame }) → void
  onMarqueeSelect, // (Array<{ trackId, frame }>, replace: boolean) → void
  onClearSelection, // () → void
}) {
  const svgRef = useRef(null);
  const dragRef = useRef(null); // { idx } | null
  const marqueeStartRef = useRef(null); // { x, y } | null — raw start coords

  const [isDragging, setIsDragging] = useState(false);
  const [marquee, setMarquee] = useState(null); // { x0,y0,x1,y1 } | null

  const { color, max, min, unit } = track;
  const zeroY = (max / (max - min)) * laneHeight;
  const pathD = buildPathD(waypoints);

  // Derive display colours from lock/hidden state.
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
        Math.abs(svgX - frameToX(waypoints[i].frame)) <= HIT_R &&
        Math.abs(svgY - waypoints[i].y) <= HIT_R
      )
        return i;
    }
    return -1;
  };

  // ── Mouse handlers ────────────────────────────────────────────────

  const handlePointerDown = (e) => {
    if (isLocked || e.button !== 0) return;
    try {
      e.target.setPointerCapture(e.pointerId);
    } catch (err) {}
    const { x, y } = svgCoords(e);
    const idx = hitTest(x, y);

    if (idx !== -1) {
      if (e.shiftKey) {
        // Shift+click toggles this waypoint in/out of selection.
        onToggleWaypoint({ trackId: track.id, frame: waypoints[idx].frame });
      } else {
        // Normal click on waypoint → start drag.
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
      // Empty space → potential marquee.
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
        if (Math.abs(x - startX) > 0 || Math.abs(y - startY) > 0) {
          dragRef.current.hasDragged = true;
        }
      }

      if (!dragRef.current.hasDragged) return;

      const rawFrame = Math.round((x / CANVAS_WIDTH) * MAX_FRAME);
      const targetDFrame = rawFrame - initialWaypoints[idx].frame;
      const targetDY = y - startY;

      let allowedMinDFrame = -Infinity;
      let allowedMaxDFrame = Infinity;
      let allowedMinDY = -Infinity;
      let allowedMaxDY = Infinity;

      initialWaypoints.forEach((wp, i) => {
        if (!dragFrames.includes(wp.frame)) return;

        allowedMinDY = Math.max(allowedMinDY, 0 - wp.y);
        allowedMaxDY = Math.min(allowedMaxDY, laneHeight - wp.y);

        if (wp.frame === 0 || wp.frame === MAX_FRAME) return;

        let leftBound = 0;
        for (let j = i - 1; j >= 0; j--) {
          if (!dragFrames.includes(initialWaypoints[j].frame)) {
            leftBound = initialWaypoints[j].frame + 1;
            break;
          }
        }

        let rightBound = MAX_FRAME;
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
        const isEndpt = wp.frame === 0 || wp.frame === MAX_FRAME;
        return {
          ...wp,
          frame: isEndpt ? wp.frame : wp.frame + finalDFrame,
          y: wp.y + finalDY,
        };
      });

      const newSelectedFrames = initialWaypoints
        .filter((wp) => dragFrames.includes(wp.frame))
        .map((wp) => {
          const isEndpt = wp.frame === 0 || wp.frame === MAX_FRAME;
          return isEndpt ? wp.frame : wp.frame + finalDFrame;
        });

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
    } catch (err) {}

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
        // Finalise marquee → select captured waypoints.
        const minX = Math.min(marquee.x0, marquee.x1);
        const maxX = Math.max(marquee.x0, marquee.x1);
        const minY = Math.min(marquee.y0, marquee.y1);
        const maxY = Math.max(marquee.y0, marquee.y1);
        const captured = waypoints
          .filter((wp) => {
            const wx = frameToX(wp.frame);
            return wx >= minX && wx <= maxX && wp.y >= minY && wp.y <= maxY;
          })
          .map((wp) => ({ trackId: track.id, frame: wp.frame }));
        onMarqueeSelect(captured, !e.shiftKey); // shift → additive, else replace
        setMarquee(null);
      } else {
        // Plain click on empty space → deselect all.
        if (!e.shiftKey) onClearSelection();
      }
      marqueeStartRef.current = null;
    }
  };

  const handlePointerCancel = (e) => {
    try {
      e.target.releasePointerCapture(e.pointerId);
    } catch (err) {}

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
      Math.min(MAX_FRAME - 1, Math.round((x / CANVAS_WIDTH) * MAX_FRAME)),
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
    if (wp.frame === 0 || wp.frame === MAX_FRAME) return;
    onUpdateWaypoints(waypoints.filter((_, i) => i !== idx));
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <svg
      ref={svgRef}
      className="absolute inset-0 z-10"
      width={CANVAS_WIDTH}
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
        x2={CANVAS_WIDTH}
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
        const x = frameToX(wp.frame);
        const y = wp.y;
        const r = DIAMOND_R;
        const selected = isWpSelected(wp);
        const isEndpoint = wp.frame === 0 || wp.frame === MAX_FRAME;

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

export default function CurveEditor({ lockedTracks, hiddenTracks }) {
  const ref0 = useRef(null);
  const ref1 = useRef(null);
  const ref2 = useRef(null);
  const laneRefs = [ref0, ref1, ref2];

  const [laneHeights, setLaneHeights] = useState([100, 100, 100]);
  const [trackData, setTrackData] = useState(() =>
    Object.fromEntries(TRACKS.map((t) => [t.id, makeDefaultWaypoints(t, 100)])),
  );
  // selectedWaypoints uses { trackId, frame } as a stable identity (frame never duplicates
  // within a track, and is stable across reorders — unlike array index).
  const [selectedWaypoints, setSelectedWaypoints] = useState([]); // Array<{ trackId, frame }>

  useEffect(() => {
    const heights = laneRefs.map((r) => r.current?.clientHeight ?? 100);
    setLaneHeights(heights);
    setTrackData(
      Object.fromEntries(
        TRACKS.map((t, i) => [t.id, makeDefaultWaypoints(t, heights[i])]),
      ),
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      // If waypoints were deleted, remove them from selection too.
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
            {/* Hex-mesh overlay — opacity raised externally when track is hidden */}
            <div
              className="absolute inset-0 bg-hex-mesh pointer-events-none transition-opacity duration-300 z-0"
              style={{ opacity: isHidden ? 1 : 0 }}
            />
            {/* Dim overlay shown when track is locked */}
            <div
              className="absolute inset-0 bg-white/[0.04] pointer-events-none transition-opacity duration-300 z-20"
              style={{ opacity: isLocked ? 1 : 0 }}
            />

            <TrackSVG
              track={track}
              waypoints={trackData[track.id]}
              laneHeight={laneHeights[i]}
              isLocked={isLocked}
              isHidden={isHidden}
              selectedWaypoints={trackSel}
              onUpdateWaypoints={(updated, newSel) =>
                updateWaypoints(track.id, updated, newSel)
              }
              onToggleWaypoint={toggleWaypoint}
              onMarqueeSelect={handleMarqueeSelect}
              onClearSelection={clearSelection}
            />
          </div>
        );
      })}
    </>
  );
}
