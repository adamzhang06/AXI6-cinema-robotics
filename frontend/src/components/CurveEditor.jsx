import { useState, useRef, useEffect } from "react";

const FPS = 30;
const DURATION_S = 120;
const MAX_FRAME = FPS * DURATION_S; // 3600
const CANVAS_WIDTH = 6000;
const DIAMOND_R = 5;

const TRACKS = [
  { id: "slide", name: "Slide", color: "#3993DD", max: 28, min: 0, unit: "in" },
  { id: "pan", name: "Pan", color: "#ff4444", max: 360, min: -360, unit: "°" },
  { id: "tilt", name: "Tilt", color: "#44ff44", max: 45, min: -45, unit: "°" },
];

const frameToX = (frame) => (frame / MAX_FRAME) * CANVAS_WIDTH;

function makeDefaultWaypoints(track, laneHeight) {
  const range = track.max - track.min;
  const zeroRatio = track.max / range;
  const zeroY = zeroRatio * laneHeight;

  return [
    { frame: 0, y: zeroY, handleIn: null, handleOut: null },
    { frame: MAX_FRAME, y: zeroY, handleIn: null, handleOut: null },
  ];
}

function buildPathD(waypoints) {
  if (waypoints.length < 2) return "";

  const pts = waypoints.map((wp) => ({
    x: frameToX(wp.frame),
    y: wp.y,
    handleIn: wp.handleIn,
    handleOut: wp.handleOut,
  }));

  let d = `M ${pts[0].x} ${pts[0].y}`;

  for (let i = 0; i < pts.length - 1; i++) {
    const cur = pts[i];
    const next = pts[i + 1];
    const pxPerFrame = CANVAS_WIDTH / MAX_FRAME;

    if (cur.handleOut || next.handleIn) {
      const cp1x = cur.handleOut
        ? cur.x + cur.handleOut.dFrame * pxPerFrame
        : cur.x;
      const cp1y = cur.handleOut ? cur.y + cur.handleOut.dY : cur.y;
      const cp2x = next.handleIn
        ? next.x + next.handleIn.dFrame * pxPerFrame
        : next.x;
      const cp2y = next.handleIn ? next.y + next.handleIn.dY : next.y;
      d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${next.x} ${next.y}`;
    } else {
      d += ` L ${next.x} ${next.y}`;
    }
  }

  return d;
}

function TrackSVG({ track, waypoints, laneHeight }) {
  const { color, max, min, unit } = track;
  const range = max - min;
  const zeroRatio = max / range;
  const zeroY = zeroRatio * laneHeight;
  const pathD = buildPathD(waypoints);

  return (
    <svg
      className="absolute inset-0 z-10"
      width={CANVAS_WIDTH}
      height={laneHeight}
      style={{ overflow: "visible", pointerEvents: "none" }}
    >
      {/* Zero / centre line */}
      <line
        x1={0}
        y1={zeroY}
        x2={CANVAS_WIDTH}
        y2={zeroY}
        stroke="rgba(255,255,255,0.12)"
        strokeWidth={1}
        strokeDasharray="4 4"
      />

      {/* Limit corner labels */}
      <text
        x={6}
        y={14}
        fontSize={9}
        fill="rgba(255,255,255,0.25)"
        fontWeight="700"
        letterSpacing="0.05em"
      >
        {max > 0 && min < 0 ? `+${max}` : max}{unit}
      </text>
      <text
        x={6}
        y={laneHeight - 5}
        fontSize={9}
        fill="rgba(255,255,255,0.25)"
        fontWeight="700"
        letterSpacing="0.05em"
      >
        {min}{unit}
      </text>

      {/* Curve path */}
      {pathD && (
        <path
          d={pathD}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.85}
        />
      )}

      {/* Waypoint diamonds */}
      {waypoints.map((wp, idx) => {
        const x = frameToX(wp.frame);
        const y = wp.y;
        const pts = `${x},${y - DIAMOND_R} ${x + DIAMOND_R},${y} ${x},${y + DIAMOND_R} ${x - DIAMOND_R},${y}`;
        return (
          <polygon
            key={idx}
            points={pts}
            fill={color}
            stroke="rgba(0,0,0,0.5)"
            strokeWidth={1}
          />
        );
      })}
    </svg>
  );
}

export default function CurveEditor() {
  const ref0 = useRef(null);
  const ref1 = useRef(null);
  const ref2 = useRef(null);
  const laneRefs = [ref0, ref1, ref2];

  const [laneHeights, setLaneHeights] = useState([100, 100, 100]);
  const [trackData, setTrackData] = useState(() =>
    Object.fromEntries(TRACKS.map((t) => [t.id, makeDefaultWaypoints(t, 100)])),
  );

  useEffect(() => {
    const heights = laneRefs.map((r) => r.current?.clientHeight ?? 100);
    setLaneHeights(heights);
    setTrackData(
      Object.fromEntries(
        TRACKS.map((t, i) => [t.id, makeDefaultWaypoints(t, heights[i])]),
      ),
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
          />
        </div>
      ))}
    </>
  );
}
