####
# To run this backend, use the command: uvicorn main:app --reload --port 8000
####

import asyncio
import base64
import json
import os

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# YOLOv8-nano fine-tuned for face detection (downloaded to backend/yolov8-face.pt).
_MODEL_PATH = os.path.join(os.path.dirname(__file__), "yolov8-face.pt")
model = YOLO(_MODEL_PATH)

# ── Proportional control constants ───────────────────────────────────────────
TRACKING_KP   = 0.003   # YOLO gain: pixels of error → pan speed
DEADZONE_PX   = 80      # YOLO deadzone (px from centre, no pan output)
ORBIT_KP      = 0.006   # orbit proportional gain
ORBIT_DEADZONE = 35     # orbit deadzone (px from centre)
ORBIT_MAX_SPD = 1.0     # orbit max pan speed — full range available

# ── Tracking state ────────────────────────────────────────────────────────────
# "yolo" uses YOLO face detection; "orbit" uses Lucas-Kanade sparse optical flow.
tracking_mode  = "yolo"   # "yolo" | "orbit"
last_frame     = None     # most-recently decoded BGR frame (for start_orbit init)

# LK orbit tracker state (reset by _reset_orbit / start_orbit)
_orbit_pts     = None     # (N,1,2) float32 — currently tracked feature points
_orbit_prev    = None     # grayscale previous frame
_orbit_center  = None     # (cx, cy) last known centroid — used for re-seeding


def _reset_orbit():
    global _orbit_pts, _orbit_prev, _orbit_center
    _orbit_pts    = None
    _orbit_prev   = None
    _orbit_center = None


# ── Frame helpers ─────────────────────────────────────────────────────────────

def _decode_frame(frame_b64: str) -> np.ndarray | None:
    """Decode a base64 JPEG string (with or without data-URL prefix) → BGR array."""
    _, _, b64data = frame_b64.partition(",")
    img_bytes = base64.b64decode(b64data if b64data else frame_b64)
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


# ── YOLO tracking ─────────────────────────────────────────────────────────────

def _infer_yolo(img: np.ndarray) -> tuple[float | None, dict]:
    """
    YOLO face-detection path.
    Target = the face with the largest bounding-box area (closest / most prominent).
    Returns (pan_speed, overlay_data).
    pan_speed is None when no face found; 0.0 when inside the deadzone.
    """
    img_h, img_w = img.shape[:2]
    img_cx = img_w / 2.0

    overlay = {"detections": [], "img_w": img_w, "img_h": img_h,
               "deadzone_px": DEADZONE_PX, "orbit": False}

    results = model(img, verbose=False)[0]
    if not len(results.boxes):
        return None, overlay

    detections = []
    for box in results.boxes:
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        detections.append({"x1": int(x1), "y1": int(y1), "x2": int(x2), "y2": int(y2),
                           "area": int((x2 - x1) * (y2 - y1))})

    target = max(detections, key=lambda d: d["area"])
    overlay["detections"] = [
        {"x1": d["x1"], "y1": d["y1"], "x2": d["x2"], "y2": d["y2"], "is_target": d is target}
        for d in detections
    ]

    target_cx = (target["x1"] + target["x2"]) / 2.0
    error_x   = target_cx - img_cx

    if abs(error_x) < DEADZONE_PX:
        return 0.0, overlay

    sign      = -1.0 if error_x > 0 else 1.0
    pan_speed = float(np.clip((abs(error_x) - DEADZONE_PX) * TRACKING_KP, 0.0, 1.0)) * sign
    return pan_speed, overlay


# ── Orbit: Lucas-Kanade sparse optical flow ───────────────────────────────────

# LK parameters — wider window handles faster motion from slide movement
_LK_PARAMS = dict(
    winSize=(25, 25),
    maxLevel=4,
    criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
)
_GFT_PARAMS = dict(maxCorners=40, qualityLevel=0.01, minDistance=5, blockSize=7)
_MIN_POINTS = 5   # re-seed if tracked count drops below this


def _init_orbit(img: np.ndarray, roi: tuple) -> bool:
    """
    Detect Shi-Tomasi feature points inside the drawn ROI and store them for LK tracking.
    Returns True if enough features were found to start tracking.
    """
    global _orbit_pts, _orbit_prev, _orbit_center

    x, y, w, h = [max(0, int(v)) for v in roi]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    mask = np.zeros_like(gray)
    mask[y : y + h, x : x + w] = 255

    pts = cv2.goodFeaturesToTrack(gray, mask=mask, **_GFT_PARAMS)

    _orbit_prev   = gray
    _orbit_center = (x + w / 2.0, y + h / 2.0)

    if pts is not None and len(pts) >= _MIN_POINTS:
        _orbit_pts = pts
        print(f"🔵  Orbit LK init — {len(pts)} feature points in roi={roi}")
        return True

    # ROI may have low texture — seed a grid of points as fallback
    grid_pts = []
    step = max(8, min(w, h) // 6)
    for gy in range(y + step, y + h - step, step):
        for gx in range(x + step, x + w - step, step):
            grid_pts.append([[float(gx), float(gy)]])
    if grid_pts:
        _orbit_pts = np.array(grid_pts, dtype=np.float32)
        print(f"🔵  Orbit LK init (grid fallback) — {len(_orbit_pts)} points in roi={roi}")
        return True

    print("WARN: start_orbit — no features found in ROI, tracking not started\n")
    _orbit_pts = None
    return False


def _infer_orbit(img: np.ndarray) -> tuple[float, dict]:
    """
    Advance the LK tracker by one frame.
    Returns (pan_speed, overlay_data).
    Writes to global _orbit_pts / _orbit_prev / _orbit_center in-place;
    safe because this is called via asyncio.to_thread and messages are sequential.
    """
    global _orbit_pts, _orbit_prev, _orbit_center

    img_h, img_w = img.shape[:2]
    img_cx = img_w / 2.0

    overlay = {"detections": [], "img_w": img_w, "img_h": img_h,
               "deadzone_px": ORBIT_DEADZONE, "orbit": True}

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    if _orbit_pts is None or _orbit_prev is None:
        _orbit_prev = gray
        return 0.0, overlay

    # ── Forward LK flow ───────────────────────────────────────────────────────
    new_pts, status, _ = cv2.calcOpticalFlowPyrLK(
        _orbit_prev, gray, _orbit_pts, None, **_LK_PARAMS
    )
    _orbit_prev = gray

    if new_pts is None or status is None:
        _orbit_pts = None
        return 0.0, overlay

    good = new_pts[status.ravel() == 1]

    # ── Re-seed if too few points remain ─────────────────────────────────────
    if len(good) < _MIN_POINTS:
        if _orbit_center is not None:
            cx_last, cy_last = _orbit_center
            pad = 50
            x1 = max(0, int(cx_last - pad))
            y1 = max(0, int(cy_last - pad))
            x2 = min(img_w, int(cx_last + pad))
            y2 = min(img_h, int(cy_last + pad))
            mask = np.zeros_like(gray)
            mask[y1:y2, x1:x2] = 255
            reseeded = cv2.goodFeaturesToTrack(gray, mask=mask, **_GFT_PARAMS)
            if reseeded is not None and len(reseeded) >= _MIN_POINTS:
                good = reseeded.reshape(-1, 2)
                print(f"🔵  Orbit LK re-seeded — {len(good)} points")
            else:
                _orbit_pts = None
                return 0.0, overlay
        else:
            _orbit_pts = None
            return 0.0, overlay

    _orbit_pts = good.reshape(-1, 1, 2).astype(np.float32)

    # ── Compute centroid and bounding box of tracked points ───────────────────
    pts2d        = good.reshape(-1, 2)
    cx           = float(pts2d[:, 0].mean())
    cy           = float(pts2d[:, 1].mean())
    _orbit_center = (cx, cy)

    # Display box = tight bbox of points with padding
    pad  = 20
    x_min = max(0,     int(pts2d[:, 0].min()) - pad)
    y_min = max(0,     int(pts2d[:, 1].min()) - pad)
    x_max = min(img_w, int(pts2d[:, 0].max()) + pad)
    y_max = min(img_h, int(pts2d[:, 1].max()) + pad)

    overlay["detections"] = [
        {"x1": x_min, "y1": y_min, "x2": x_max, "y2": y_max, "is_target": True}
    ]
    overlay["n_pts"] = len(good)

    # ── Proportional control with deadzone ────────────────────────────────────
    error_x = cx - img_cx
    if abs(error_x) < ORBIT_DEADZONE:
        return 0.0, overlay

    sign      = -1.0 if error_x > 0 else 1.0
    pan_speed = float(np.clip((abs(error_x) - ORBIT_DEADZONE) * ORBIT_KP, 0.0, ORBIT_MAX_SPD)) * sign
    return pan_speed, overlay


# ── Connection manager ────────────────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, WebSocket] = {}

    async def connect(self, client_id: str, websocket: WebSocket):
        await websocket.accept()
        self.active_connections[client_id] = websocket
        print(f"[+] {client_id} connected  (active: {list(self.active_connections)})")
        if client_id == "pi":
            await self.send_to(
                "ui",
                json.dumps({"sender": "hub", "command": "pi_status", "status": "connected"}),
            )
        elif client_id == "ui":
            status = "connected" if "pi" in self.active_connections else "disconnected"
            await self.send_to(
                "ui",
                json.dumps({"sender": "hub", "command": "pi_status", "status": status}),
            )

    def disconnect(self, client_id: str):
        self.active_connections.pop(client_id, None)
        print(f"[-] {client_id} disconnected  (active: {list(self.active_connections)})")

    async def send_to(self, target_id: str, message: str):
        ws = self.active_connections.get(target_id)
        if ws:
            await ws.send_text(message)


manager = ConnectionManager()


@app.get("/")
def read_root():
    return {"message": "AXI6 backend running"}


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    global tracking_mode, last_frame

    await manager.connect(client_id, websocket)
    try:
        while True:
            raw = await websocket.receive_text()

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await manager.send_to(client_id, json.dumps({"error": "invalid JSON"}))
                continue

            command = data.get("command", "")

            # ── Trajectory commands ───────────────────────────────────────────
            if command == "save_trajectory":
                print("\n🟢  TRAJECTORY SAVED — forwarding to pi\n")
                await manager.send_to("pi", raw)
                await manager.send_to(
                    client_id, json.dumps({"ack": "save_trajectory", "status": "ok"})
                )

            elif command == "execute_move":
                print("\n🚀  EXECUTING MOVE — forwarding to pi\n")
                orbit = tracking_mode == "orbit"
                await manager.send_to("pi", json.dumps({"command": "execute_move", "orbit": orbit}))
                await manager.send_to(
                    client_id, json.dumps({"ack": "execute_move", "status": "ok"})
                )

            elif command == "emergency_stop":
                print("\n🛑  EMERGENCY STOP\n")
                tracking_mode = "yolo"
                _reset_orbit()
                await manager.send_to("pi", json.dumps({"command": "emergency_stop"}))

            elif command == "trajectory_complete":
                print("\n✅  TRAJECTORY COMPLETE — forwarding to ui\n")
                await manager.send_to("ui", json.dumps({"command": "trajectory_complete"}))

            # ── Jog commands ──────────────────────────────────────────────────
            elif command == "start_jog":
                await manager.send_to("pi", raw)

            elif command == "stop_jog":
                await manager.send_to("pi", raw)

            # ── Slide lock / unlock ───────────────────────────────────────────
            elif command in ("lock_slide", "unlock_slide"):
                tracking_mode = "yolo"
                _reset_orbit()
                await manager.send_to("pi", raw)

            # ── Orbit: initialize LK tracker with drawn ROI ───────────────────
            elif command == "start_orbit":
                roi = data.get("roi")   # [x, y, w, h] in native video pixels
                if not roi or last_frame is None:
                    print("WARN: start_orbit — no ROI or no frame received yet\n")
                    continue
                _reset_orbit()
                ok = _init_orbit(last_frame, roi)
                if ok:
                    tracking_mode = "orbit"
                    print(f"🔵  Orbit mode active  roi={roi}\n")
                else:
                    print("WARN: start_orbit — failed to find features, staying in yolo mode\n")

            # ── Frame processing (tracking + orbit) ───────────────────────────
            elif command == "process_frame":
                frame_b64 = data.get("frame", "")
                if not frame_b64:
                    continue

                img = _decode_frame(frame_b64)
                if img is None:
                    continue
                last_frame = img

                if tracking_mode == "orbit":
                    pan_speed, overlay = await asyncio.to_thread(_infer_orbit, img)
                    await manager.send_to(
                        "ui", json.dumps({"command": "tracking_overlay", **overlay})
                    )
                    n = overlay.get("n_pts", 0)
                    if pan_speed == 0.0:
                        print(f"🔵  orbit → pi  [deadzone / lost]  pts={n}")
                    else:
                        print(f"🔵  orbit → pi  pan={pan_speed:+.4f}  pts={n}")
                    await manager.send_to(
                        "pi", json.dumps({"command": "track", "pan_speed": pan_speed})
                    )

                else:
                    pan_speed, overlay = await asyncio.to_thread(_infer_yolo, img)
                    await manager.send_to(
                        "ui", json.dumps({"command": "tracking_overlay", **overlay})
                    )
                    if pan_speed is not None:
                        if pan_speed == 0.0:
                            print("🎯  yolo → pi  [deadzone]")
                        else:
                            print(f"🎯  yolo → pi  pan={pan_speed:+.4f}")
                        await manager.send_to(
                            "pi", json.dumps({"command": "track", "pan_speed": pan_speed})
                        )

            else:
                print(f"[{client_id}] unknown command: {data}")
                await manager.send_to(
                    client_id,
                    json.dumps({"ack": command or "unknown", "status": "received"}),
                )

    except WebSocketDisconnect:
        manager.disconnect(client_id)
        if client_id == "pi":
            await manager.send_to(
                "ui",
                json.dumps({"sender": "hub", "command": "pi_status", "status": "disconnected"}),
            )
