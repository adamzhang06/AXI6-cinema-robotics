import { useState, useRef, useEffect } from "react";

const FPS = 30;
const DURATION_S = 120;
const MAX_FRAME = FPS * DURATION_S; // 3600
const CANVAS_WIDTH = 6000;
const DIAMOND_R = 5;
const HIT_R = DIAMOND_R + 4; // slightly larger pick radius

const TRACKS = [
  { id: "slide", name: "Slide", color: "#3993DD", max: 28,  min: 0,    unit: "in" },
  { id: "pan",   name: "Pan",   color: "#ff4444", max: 360, min: -360, unit: "°"  },
  { id: "tilt",  name: "Tilt",  color: "#44ff44", max: 45,  min: -45,  unit: "°"  },
];

const frameToX = (frame) => (frame / MAX_FRAME) * CANVAS_WIDTH;

function makeDefaultWaypoints(track, laneHeight) {
  const zeroY = (track.max / (track.max - track.min)) * laneHeight;
  return [
    { frame: 0,         y: zeroY, handleIn: null, handleOut: null },
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
    const cur = pts[i];
    const nxt = pts[i + 1];
    if (cur.ho || nxt.hi) {
      const cp1x = cur.ho ? cur.x + cur.ho.dFrame * pxPerFrame : cur.x;
      const cp1y = cur.ho ? cur.y + cur.ho.dY                  : cur.y;
      const cp2x = nxt.hi ? nxt.x + nxt.hi.dFrame * pxPerFrame : nxt.x;
      const cp2y = nxt.hi ? nxt.y + nxt.hi.dY                  : nxt.y;
      d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${nxt.x} ${nxt.y}`;
    } else {
      d += ` L ${nxt.x} ${nxt.y}`;
    }
  }
  return d;
}

// ─── TrackSVG ────────────────────────────────────────────────────────────────

function TrackSVG({ track, waypoints, laneHeight, onUpdateWaypoints }) {
  const svgRef     = useRef(null);
  const dragRef    = useRef(null); // { idx } | null
  const [isDragging, setIsDragging] = useState(false);

  const { color, max, min, unit } = track;
  const zeroY = (max / (max - min)) * laneHeight;
  const pathD = buildPathD(waypoints);

  // Convert a mouse event to SVG-local coordinates (accounts for scroll offset).
  const svgCoords = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // Return the index of the waypoint under (svgX, svgY), or -1.
  const hitTest = (svgX, svgY) => {
    for (let i = 0; i < waypoints.length; i++) {
      const wx = frameToX(waypoints[i].frame);
      const wy = waypoints[i].y;
      if (Math.abs(svgX - wx) <= HIT_R && Math.abs(svgY - wy) <= HIT_R) return i;
    }
    return -1;
  };

  // ── Event handlers ───────────────────────────────────────────────

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    const { x, y } = svgCoords(e);
    const idx = hitTest(x, y);
    if (idx !== -1) {
      dragRef.current = { idx };
      setIsDragging(true);
      e.preventDefault(); // prevent text selection while dragging
    }
  };

  const handleMouseMove = (e) => {
    if (!dragRef.current) return;
    const { x, y } = svgCoords(e);
    const { idx } = dragRef.current;
    const wp = waypoints[idx];
    const isEndpoint = wp.frame === 0 || wp.frame === MAX_FRAME;

    // Endpoints are pinned on X; interior waypoints are constrained between neighbours.
    const rawFrame    = Math.round((x / CANVAS_WIDTH) * MAX_FRAME);
    const minFrame    = idx > 0                   ? waypoints[idx - 1].frame + 1 : 0;
    const maxFrame    = idx < waypoints.length - 1 ? waypoints[idx + 1].frame - 1 : MAX_FRAME;
    const newFrame    = isEndpoint ? wp.frame : Math.max(minFrame, Math.min(maxFrame, rawFrame));
    const newY        = Math.max(0, Math.min(laneHeight, y));

    onUpdateWaypoints(
      waypoints.map((w, i) => (i === idx ? { ...w, frame: newFrame, y: newY } : w))
    );
  };

  const stopDrag = () => {
    dragRef.current = null;
    setIsDragging(false);
  };

  // Double-click on empty space → add waypoint.
  const handleDoubleClick = (e) => {
    const { x, y } = svgCoords(e);
    if (hitTest(x, y) !== -1) return; // clicked on an existing waypoint — ignore
    const frame = Math.max(1, Math.min(MAX_FRAME - 1, Math.round((x / CANVAS_WIDTH) * MAX_FRAME)));
    const newY  = Math.max(0, Math.min(laneHeight, y));
    const newWp = { frame, y: newY, handleIn: null, handleOut: null };
    onUpdateWaypoints([...waypoints, newWp].sort((a, b) => a.frame - b.frame));
  };

  // Right-click on interior waypoint → delete it.
  const handleContextMenu = (e) => {
    e.preventDefault();
    const { x, y } = svgCoords(e);
    const idx = hitTest(x, y);
    if (idx === -1) return;
    const wp = waypoints[idx];
    if (wp.frame === 0 || wp.frame === MAX_FRAME) return; // protect endpoints
    onUpdateWaypoints(waypoints.filter((_, i) => i !== idx));
  };

  // ── Render ───────────────────────────────────────────────────────

  return (
    <svg
      ref={svgRef}
      className="absolute inset-0 z-10"
      width={CANVAS_WIDTH}
      height={laneHeight}
      style={{
        overflow: "visible",
        pointerEvents: "all",
        cursor: isDragging ? "grabbing" : "crosshair",
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={stopDrag}
      onMouseLeave={stopDrag}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Zero / value-zero line */}
      <line
        x1={0} y1={zeroY} x2={CANVAS_WIDTH} y2={zeroY}
        stroke="rgba(255,255,255,0.12)" strokeWidth={1} strokeDasharray="4 4"
        style={{ pointerEvents: "none" }}
      />

      {/* Limit labels */}
      <text x={6} y={14} fontSize={9} fill="rgba(255,255,255,0.25)"
        fontWeight="700" letterSpacing="0.05em" style={{ pointerEvents: "none" }}>
        {max > 0 && min < 0 ? `+${max}` : max}{unit}
      </text>
      <text x={6} y={laneHeight - 5} fontSize={9} fill="rgba(255,255,255,0.25)"
        fontWeight="700" letterSpacing="0.05em" style={{ pointerEvents: "none" }}>
        {min}{unit}
      </text>

      {/* Curve path — non-interactive so clicks pass through to SVG background */}
      {pathD && (
        <path
          d={pathD}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.85}
          style={{ pointerEvents: "none" }}
        />
      )}

      {/* Waypoint diamonds */}
      {waypoints.map((wp, idx) => {
        const x  = frameToX(wp.frame);
        const y  = wp.y;
        const r  = DIAMOND_R;
        const isEndpoint = wp.frame === 0 || wp.frame === MAX_FRAME;
        return (
          <polygon
            key={idx}
            points={`${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`}
            fill={color}
            stroke={isEndpoint ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.55)"}
            strokeWidth={1}
            style={{ cursor: isDragging ? "grabbing" : "grab", pointerEvents: "none" }}
          />
        );
      })}
    </svg>
  );
}

// ─── CurveEditor (root) ───────────────────────────────────────────────────────

export default function CurveEditor() {
  const ref0 = useRef(null);
  const ref1 = useRef(null);
  const ref2 = useRef(null);
  const laneRefs = [ref0, ref1, ref2];

  const [laneHeights, setLaneHeights] = useState([100, 100, 100]);
  const [trackData, setTrackData] = useState(
    () => Object.fromEntries(TRACKS.map((t) => [t.id, makeDefaultWaypoints(t, 100)]))
  );

  // Measure actual lane heights after mount and re-initialise waypoint Y positions.
  useEffect(() => {
    const heights = laneRefs.map((r) => r.current?.clientHeight ?? 100);
    setLaneHeights(heights);
    setTrackData(
      Object.fromEntries(TRACKS.map((t, i) => [t.id, makeDefaultWaypoints(t, heights[i])]))
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const updateWaypoints = (trackId, updated) =>
    setTrackData((prev) => ({ ...prev, [trackId]: updated }));

  return (
    <>
      {TRACKS.map((track, i) => (
        <div
          key={track.id}
          ref={laneRefs[i]}
          className="flex-1 border-b border-[#1B1B1D] relative overflow-hidden"
        >
          {/* Hex-mesh overlay — opacity raised when track visibility is toggled off */}
          <div className="absolute inset-0 bg-hex-mesh opacity-0 pointer-events-none transition-opacity duration-300 z-0" />
          {/* Dim overlay shown when track is locked */}
          <div className="absolute inset-0 bg-white/10 opacity-0 pointer-events-none transition-opacity duration-300 z-20" />

          <TrackSVG
            track={track}
            waypoints={trackData[track.id]}
            laneHeight={laneHeights[i]}
            onUpdateWaypoints={(updated) => updateWaypoints(track.id, updated)}
          />
        </div>
      ))}
    </>
  );
}
