import "./index.css";

// ─────────────────────────────────────────────────────────────────
// SHARED MICRO-COMPONENTS
// ─────────────────────────────────────────────────────────────────

/** Icon button used in the playback bar. */
function PlaybackBtn({ title, className = "", children }) {
  return (
    <button className={`playback-btn ${className}`} title={title}>
      {children}
    </button>
  );
}

/** Thin vertical separator line for the playback bar. */
function BarDivider({ className = "" }) {
  return <div className={`w-px h-4 bg-white/20 ${className}`} />;
}

// ─────────────────────────────────────────────────────────────────
// NAVBAR  (24 px top strip)
// ─────────────────────────────────────────────────────────────────
function Navbar() {
  return (
    <div className="bg-[var(--bg-main-light)] flex items-center text-xs w-full text-white">
      {/* Aligns "AXI6" directly above the 50 px toolbar column */}
      <div className="w-[50px] flex justify-center shrink-0">
        <span className="font-bold tracking-wider">AXI6</span>
      </div>
      {/* Aligns "|" above the 2 px gap between toolbar and center */}
      <div className="w-[2px] flex justify-center items-center shrink-0">
        <span className="opacity-30">|</span>
      </div>
      <span className="font-bold pl-3 text-[#cccccc]">Cinema Robotics</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// TOOLBAR  (50 px far-left icon strip)
// ─────────────────────────────────────────────────────────────────
function Toolbar() {
  return (
    <div className="bg-[var(--bg-main)] flex flex-col p-1 pt-2 items-center gap-4">
      {/* App logo */}
      <div className="flex aspect-square w-full items-center justify-center rounded bg-[#2a2a2c] p-0.5">
        <img
          src="/axi6_logo.png"
          alt="AXI6"
          className="w-full h-full object-contain brightness-150"
        />
      </div>

      <hr className="border-white/10 w-8" />

      {/* Camera toggle — logic wired in a later chunk */}
      <button
        className="w-10 h-10 flex items-center justify-center rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
        title="Toggle Camera"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// LEFT SIDEBAR  (320 px — Robot Controls panel)
// ─────────────────────────────────────────────────────────────────

/** Single directional wedge button inside a joystick widget. */
function JogWedge({ style, children }) {
  return (
    <button className="joystick-wedge" style={style}>
      {children}
    </button>
  );
}

/** Circular home button centred over a joystick widget. */
function JogHome() {
  return (
    <button
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10
                 w-[38%] h-[38%] rounded-full bg-[#3a3a3e] flex items-center
                 justify-center text-[#FFD500] hover:bg-[#4a4a4e] transition-colors border-none"
      title="Home"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
        <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    </button>
  );
}

function LeftSidebar() {
  return (
    <div className="bg-[var(--bg-main)] flex flex-col p-2 overflow-hidden">
      <h2 className="panel-header mb-2">Robot Controls</h2>

      {/* ── Jog D-pads ─────────────────────────────────────────── */}
      <span className="ctrl-label">Jog</span>
      <div className="flex gap-3 justify-center mt-[6px]">

        {/* Slide joystick (horizontal only) */}
        <div className="text-center">
          <div className="relative w-[120px] h-[120px] rounded-full overflow-hidden bg-[#2a2a2c]">
            <div className="w-full h-full grid grid-cols-2 gap-1 bg-[#1a1a1c]">
              <JogWedge style={{ paddingRight: 12 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M15 19l-7-7 7-7" />
                </svg>
              </JogWedge>
              <JogWedge style={{ paddingLeft: 12 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9 5l7 7-7 7" />
                </svg>
              </JogWedge>
            </div>
            <JogHome />
          </div>
          <span className="ctrl-label mt-1 block">Slide</span>
        </div>

        {/* Pan & Tilt joystick (4-way, rotated 45°) */}
        <div className="text-center">
          <div className="relative w-[120px] h-[120px] rounded-full overflow-hidden bg-[#2a2a2c]">
            {/*
              The inner grid is rotated 45° so the cells become diamond-shaped
              wedges. Icons are counter-rotated inside each button to stay upright.
            */}
            <div
              className="w-full h-full grid grid-cols-2 grid-rows-2 gap-1 bg-[#1a1a1c]"
              style={{ transform: "rotate(45deg)" }}
            >
              {/* Top (tilt up) */}
              <JogWedge>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
                  style={{ transform: "rotate(-45deg)" }}>
                  <path d="M5 15l7-7 7 7" />
                </svg>
              </JogWedge>
              {/* Right (pan right) */}
              <JogWedge>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
                  style={{ transform: "rotate(-45deg)" }}>
                  <path d="M9 5l7 7-7 7" />
                </svg>
              </JogWedge>
              {/* Left (pan left) */}
              <JogWedge>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
                  style={{ transform: "rotate(-45deg)" }}>
                  <path d="M15 19l-7-7 7-7" />
                </svg>
              </JogWedge>
              {/* Bottom (tilt down) */}
              <JogWedge>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
                  style={{ transform: "rotate(-45deg)" }}>
                  <path d="M19 9l-7 7-7-7" />
                </svg>
              </JogWedge>
            </div>
            <JogHome />
          </div>
          <span className="ctrl-label mt-1 block">Pan &amp; Tilt</span>
        </div>
      </div>

      {/* ── Jog Speed ──────────────────────────────────────────── */}
      <div className="mt-[14px]">
        <div className="flex items-center justify-between mb-1">
          <span className="ctrl-label">Max Jog Speed</span>
          <span className="text-[11px] font-semibold text-white/70" style={{ fontFamily: "var(--font-mono)" }}>
            50%
          </span>
        </div>
        <input
          type="range" min="0" max="100" defaultValue="50"
          className="w-full h-1 cursor-pointer accent-[#FFD500]"
        />
      </div>

      {/* ── Dynamic settings area (context-dependent) ─────────── */}
      <div className="flex-1 mt-5" />

      {/* ── Mode Toggle ────────────────────────────────────────── */}
      <div className="mb-0.5">
        <span className="ctrl-label block mb-1.5">Operation Mode</span>
        <div className="mode-pill">
          {/* active state toggled in a later chunk */}
          <button className="mode-seg active">Trajectory</button>
          <button className="mode-seg">Tracking</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// VIEWPORT  (shows logo placeholder or live MJPEG stream)
// ─────────────────────────────────────────────────────────────────
function Viewport() {
  return (
    <div className="bg-[var(--bg-main)] flex flex-col p-2 relative min-h-0 min-w-0">
      {/* Camera-active label — hidden until stream is on */}
      <div className="absolute top-4 left-4 z-10 bg-black/50 backdrop-blur-md px-2 py-1
                      flex items-center gap-2 rounded text-white/80 hidden pointer-events-none">
        <h2 className="panel-header mb-0">CAMERA</h2>
        <div className="w-2.5 h-2.5 rounded-full bg-red-600 shadow-[0_0_8px_#dc2626] animate-cam-pulse" />
      </div>

      <div className="w-full bg-[var(--bg-lighter)] rounded flex-1 overflow-hidden
                      relative min-h-0 min-w-0 flex items-center justify-center">
        {/* Static logo placeholder (swapped out when camera is on) */}
        <img
          src="/axi6_wide_logo_crop.jpeg"
          alt="AXI6 Logo"
          className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
        />
        {/* MJPEG stream — hidden by default, src set by camera logic */}
        <img
          id="mjpeg-stream"
          src=""
          alt="Camera Feed"
          className="absolute inset-0 w-full h-full object-contain bg-black hidden"
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// TIMELINE — sub-components
// ─────────────────────────────────────────────────────────────────

/** One track label row (Slide / Pan / Tilt) in the left labels panel. */
function TrackBlock({ id, name, color }) {
  return (
    <div
      className="track-block flex-1"
      id={`track-${id}`}
      data-name={name}
      data-color={color}
    >
      <div className="flex items-center pr-3 w-full">
        <span className="track-title flex-none w-14">{name}</span>

        <div className="flex-1 flex justify-center items-center gap-2">
          {/* Visibility toggle (eye icon) */}
          <button className="text-white/40 hover:text-white transition-colors border-none bg-transparent"
            title="Toggle Visibility">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>

          {/* Lock toggle (padlock icon) */}
          <button className="text-white/40 hover:text-white transition-colors border-none bg-transparent"
            title="Lock Track">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 9.9-1" />
            </svg>
          </button>
        </div>

        {/* Coloured indicator dot */}
        <div
          className="flex-none w-[14px] h-[14px] rounded-full pointer-events-none transition-all duration-300"
          style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }}
        />
      </div>
    </div>
  );
}

/** One SVG lane (Slide / Pan / Tilt) inside the scrollable curve canvas. */
function TrackLane({ id }) {
  return (
    <div id={`lane-${id}`} className="flex-1 border-b border-[#1B1B1D] relative overflow-hidden">
      {/* Hex-mesh overlay — made visible when track visibility is toggled off */}
      <div className="absolute inset-0 bg-hex-mesh opacity-0 pointer-events-none transition-opacity duration-300 z-0" />
      {/* Dim overlay shown when track is locked */}
      <div className="absolute inset-0 bg-white/10 opacity-0 pointer-events-none transition-opacity duration-300 z-20" />
      {/* SVG canvas — curve-editor will draw paths here */}
      <svg
        id={`svg-${id}`}
        className="absolute inset-0 w-full h-full pointer-events-none z-10"
        overflow="visible"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// TIMELINE  (bottom half of center content)
// ─────────────────────────────────────────────────────────────────
function Timeline() {
  const tracks = [
    { id: "slide", name: "Slide", color: "#3993DD" },
    { id: "pan",   name: "Pan",   color: "#ff4444" },
    { id: "tilt",  name: "Tilt",  color: "#44ff44" },
  ];

  return (
    <div className="flex flex-col gap-[2px] h-full overflow-hidden">

      {/* ── Split Header (48 px) ───────────────────────────────── */}
      <div className="h-[48px] grid grid-cols-[200px_1fr] gap-[2px] w-full shrink-0">

        {/* Left: TIMELINE label + max-length timecode input */}
        <div className="bg-[var(--bg-main)] pl-3 pr-4 flex items-center justify-between h-full">
          <h2 className="panel-header mb-0 shrink-0">TIMELINE</h2>
          <div className="flex flex-col items-center mt-0.5 gap-0.5">
            <span className="ctrl-label text-[8px] leading-none">Max Length</span>
            <input
              type="text"
              defaultValue="00:02:00:00"
              autoComplete="off"
              spellCheck="false"
              className="bg-neutral-950 border border-white/5 rounded px-1.5 w-[80px] py-0.5
                         text-[10px] text-[#FFD500] opacity-80 text-center
                         shadow-[inset_0_2px_4px_rgba(0,0,0,0.4)]
                         focus:outline-none focus:border-[#FFD500]/50 focus:opacity-100
                         transition-colors"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </div>
        </div>

        {/* Right: Playback controls */}
        <div className="secondary-header justify-center relative py-0 px-4">

          {/* Frame counter — pinned to the left */}
          <div className="absolute left-4 text-[10px] text-white/40 tracking-wider flex items-center gap-1"
            style={{ fontFamily: "var(--font-mono)" }}>
            <span>FRAME:</span>
            <span className="text-white/80 w-[24px] text-right">0</span>
            <span>/ 3600</span>
          </div>

          {/* Centred button row */}
          <div className="flex items-center gap-1.5 p-0.5">

            {/* Eraser */}
            <PlaybackBtn title="Clear all waypoints">
              <svg className="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                <path d="M22 21H7" /><path d="m5 11 9 9" />
              </svg>
            </PlaybackBtn>

            {/* Magnet snap */}
            <PlaybackBtn title="Toggle waypoint snap">
              <svg className="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15" />
                <path d="m5 8 4 4" /><path d="m12 15 4 4" />
              </svg>
            </PlaybackBtn>

            <BarDivider />

            {/* Skip left */}
            <PlaybackBtn title="Skip to start">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18 5.5v13L8 12l10-6.5z" /><path d="M6 5.5h2v13H6v-13z" />
              </svg>
            </PlaybackBtn>
            {/* Play left */}
            <PlaybackBtn title="Play backward">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18 5.5v13L8 12l10-6.5z" />
              </svg>
            </PlaybackBtn>
            {/* Pause */}
            <PlaybackBtn title="Pause">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 5.5h4v13H6v-13zm8 0h4v13h-4v-13z" />
              </svg>
            </PlaybackBtn>
            {/* Play right */}
            <PlaybackBtn title="Play forward">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 5.5v13L16 12 6 5.5z" />
              </svg>
            </PlaybackBtn>
            {/* Skip right */}
            <PlaybackBtn title="Skip to end">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 5.5v13L16 12 6 5.5z" /><path d="M16 5.5h2v13h-2v-13z" />
              </svg>
            </PlaybackBtn>

            <BarDivider />

            {/* Zoom controls */}
            <div className="flex items-center gap-1.5 ml-2 text-white/50 hover:text-white transition-colors">
              <button className="w-4 h-4 flex items-center justify-center hover:bg-white/10 rounded border-none bg-transparent"
                title="Zoom out">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <input type="range" min="0" max="100" defaultValue="50"
                className="w-20 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-[#FFD500]" />
              <button className="w-4 h-4 flex items-center justify-center hover:bg-white/10 rounded border-none bg-transparent"
                title="Zoom in">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>

            <BarDivider className="ml-2" />

            {/* Bezier easing tools — greyed out until a waypoint is selected */}
            <div className="flex items-center gap-1.5 ml-2 opacity-30 pointer-events-none transition-opacity duration-300">
              {[
                {
                  title: "Ease out (add right handle)",
                  icon: (
                    <>
                      <path d="M6 18C12 18 18 12 18 6" />
                      <circle cx="6" cy="18" r="2" fill="white" stroke="currentColor" strokeWidth="1.5" />
                    </>
                  ),
                },
                {
                  title: "Ease both (symmetric handles)",
                  icon: (
                    <>
                      <path d="M4 16C8 10 16 10 20 16" />
                      <circle cx="12" cy="11.5" r="2" fill="white" stroke="currentColor" strokeWidth="1.5" />
                    </>
                  ),
                },
                {
                  title: "Ease in (add left handle)",
                  icon: (
                    <>
                      <path d="M6 6C6 12 12 18 18 18" />
                      <circle cx="6" cy="6" r="2" fill="white" stroke="currentColor" strokeWidth="1.5" />
                    </>
                  ),
                },
                {
                  title: "Linear (remove handles)",
                  icon: (
                    <>
                      <line x1="6" y1="18" x2="18" y2="6" />
                      <circle cx="12" cy="12" r="2" fill="white" stroke="currentColor" strokeWidth="1.5" />
                    </>
                  ),
                },
              ].map(({ title, icon }) => (
                <button
                  key={title}
                  title={title}
                  className="w-7 h-7 flex items-center justify-center rounded border border-white/20
                             bg-neutral-900 hover:bg-white/10 text-white transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    {icon}
                  </svg>
                </button>
              ))}
            </div>
          </div>

          <BarDivider className="ml-2" />

          {/* Send mission to Pi */}
          <PlaybackBtn
            title="Send mission to Pi"
            className="text-[#FFD500] hover:text-white hover:bg-[#FFD500]/20 ml-1"
          >
            <svg className="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2 11 13" /><path d="M22 2 15 22 11 13 2 9l20-7z" />
            </svg>
          </PlaybackBtn>
        </div>
      </div>

      {/* ── Main Curve Area ─────────────────────────────────────── */}
      <div className="flex-1 relative overflow-hidden grid grid-cols-[200px_1fr] gap-[2px] min-w-0">

        {/* Track label sidebar */}
        <div className="bg-[var(--bg-main)] flex flex-col z-50">

          {/* Timecode display (height matches the ruler) */}
          <div className="h-[30px] shrink-0 bg-[var(--bg-main)] flex items-center justify-center p-1 z-10
                          relative border-b-2 border-[#0a0a0c]">
            <div className="w-full h-full bg-neutral-950 rounded border border-white/5 flex items-center
                            justify-center shadow-[inset_0_2px_4px_rgba(0,0,0,0.4)]">
              <span
                className="text-[#FFD500] text-[12px] font-medium opacity-90 tracking-widest"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                00:00:00:00
              </span>
            </div>
          </div>

          {tracks.map((t) => (
            <TrackBlock key={t.id} {...t} />
          ))}
        </div>

        {/* Scrollable SVG canvas */}
        <div className="bg-[#0a0a0c] relative overflow-x-auto no-scrollbar min-w-0">
          {/*
            This div is the scrollable content area. Its width is set wide enough
            to show the full timeline at any zoom level. The curve-editor will resize
            it dynamically once wired up.
          */}
          <div className="relative h-full" style={{ width: "6000px" }}>

            {/* Timeline ruler (tick marks injected by JS in a later chunk) */}
            <div
              className="absolute top-0 left-0 right-0 h-[30px] z-20 overflow-hidden
                         border-b border-[#1B1B1D] bg-[#0a0a0c]/80 origin-top cursor-ew-resize"
            />

            {/* Track lane area — sits below the 30 px ruler */}
            <div className="absolute left-0 right-0 flex flex-col z-10" style={{ top: 30, bottom: 0 }}>
              {tracks.map((t) => (
                <TrackLane key={t.id} id={t.id} />
              ))}
            </div>

            {/* Playhead (draggable red vertical line) */}
            <div
              className="absolute top-0 bottom-0 w-[2px] bg-red-600/70 z-30 pointer-events-none"
              style={{ left: 0 }}
            >
              <div className="absolute -top-px -left-[6px] w-[14px] h-[16px] bg-red-600
                              rounded-b-sm border-t border-red-400 pointer-events-auto cursor-ew-resize" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// RIGHT SIDEBAR  (300 px — Settings panel)
// ─────────────────────────────────────────────────────────────────
function RightSidebar() {
  return (
    <div className="bg-[var(--bg-main)] flex flex-col p-2">
      <h2 className="panel-header">Settings</h2>

      {/* Selected track info — hidden until a track is clicked */}
      <div className="flex items-center gap-2 mb-4 hidden bg-[#252528] p-2 rounded border border-white/5">
        <div className="w-3 h-3 rounded-full" />
        <span className="text-sm text-white font-bold opacity-90 tracking-wide">Track Name</span>
      </div>

      {/* Waypoint controls — hidden until a track is selected */}
      <div className="hidden mb-4">
        <span className="text-[9px] text-white/30 uppercase tracking-widest font-bold block mb-1.5">
          Waypoint
        </span>
        <div className="flex items-center gap-1">
          {/* Prev */}
          <button className="flex-1 flex items-center justify-center h-7 rounded bg-[#252528]
                             border border-white/10 text-white/50 hover:text-white hover:bg-white/10
                             transition-colors"
            title="Go to previous waypoint">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          {/* Add / remove at scrubber */}
          <button className="flex-[1.4] flex items-center justify-center h-7 rounded bg-[#252528]
                             border border-white/10 hover:bg-white/10 transition-colors"
            title="Add / remove waypoint at current frame">
            <svg width="13" height="13" viewBox="0 0 24 24">
              <polygon points="12,2 22,12 12,22 2,12" fill="rgba(255,255,255,0.45)" />
            </svg>
          </button>
          {/* Next */}
          <button className="flex-1 flex items-center justify-center h-7 rounded bg-[#252528]
                             border border-white/10 text-white/50 hover:text-white hover:bg-white/10
                             transition-colors"
            title="Go to next waypoint">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          <div className="w-px h-4 bg-white/10 mx-0.5" />

          {/* Reset to centre */}
          <button className="flex items-center justify-center w-7 h-7 rounded bg-[#252528]
                             border border-white/10 text-white/50 hover:text-white hover:bg-white/10
                             transition-colors"
            title="Reset waypoints to vertical centre">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </div>

        {/* Boundary limit input */}
        <div className="flex items-center justify-between mt-2">
          <span className="text-[9px] text-white/30 uppercase tracking-widest font-bold">Boundary</span>
          <div className="flex items-center gap-1">
            <input
              type="number" min="1" max="100" defaultValue="100" step="1"
              className="w-14 bg-[#111113] border border-white/10 rounded px-1.5 py-0.5
                         text-[11px] text-[#FFD500] text-right outline-none appearance-none"
              style={{ fontFamily: "var(--font-mono)" }}
            />
            <span className="text-[10px] text-white/35 font-semibold min-w-[12px]">cm</span>
          </div>
        </div>
      </div>

      {/* Tracking mode active banner — hidden until mode is switched */}
      <div className="flex items-center gap-2 mb-4 hidden bg-[#FFD500]/15 p-2 rounded border-l-4 border-l-[#FFD500]">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="#FFD500" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span className="text-sm text-white font-bold opacity-90 tracking-wide">Tracking Mode Active</span>
      </div>

      {/* Push connection bar to the bottom */}
      <div className="flex-1" />

      {/* Connection status indicators */}
      <div className="flex gap-2 items-center flex-wrap pt-2 border-t border-white/[0.06]">
        <div className="flex items-center gap-[5px]">
          <div className="w-[7px] h-[7px] rounded-full bg-[#555] shrink-0
                          transition-[background,box-shadow] duration-300" />
          <span className="text-[9px] font-semibold tracking-[0.06em] text-white/35 uppercase whitespace-nowrap">
            WS: —
          </span>
        </div>
        <div className="w-px h-3 bg-white/[0.08] shrink-0" />
        <div className="flex items-center gap-[5px]">
          <div className="w-[7px] h-[7px] rounded-full bg-[#555] shrink-0
                          transition-[background,box-shadow] duration-300" />
          <span className="text-[9px] font-semibold tracking-[0.06em] text-white/35 uppercase whitespace-nowrap">
            Server: —
          </span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// APP ROOT
// ─────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <div className="grid grid-rows-[24px_1fr] h-screen w-screen gap-[2px] overflow-hidden text-[#cccccc]">
      <Navbar />

      {/* Three-column workspace */}
      <div className="grid grid-cols-[50px_1fr_300px] gap-[2px] h-full overflow-hidden">
        <Toolbar />

        {/* Center: top (controls + viewport) and bottom (timeline) */}
        <div className="grid grid-rows-[1fr_1fr] gap-[2px]">
          <div className="grid grid-cols-[320px_1fr] gap-[2px]">
            <LeftSidebar />
            <Viewport />
          </div>
          <Timeline />
        </div>

        <RightSidebar />
      </div>
    </div>
  );
}
