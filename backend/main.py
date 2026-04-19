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

TRACKING_KP = 0.003  # proportional gain: pixels of error → pan speed
DEADZONE_PX = 80     # pixels from centre with no pan output (YOLO only)

# ── Tracker state ─────────────────────────────────────────────────────────────
tracker      = None          # cv2.TrackerCSRT instance when in orbit mode
tracking_mode = "yolo"       # "yolo" | "csrt"
last_frame   = None          # most-recently decoded frame (numpy BGR array)


# ── Frame helpers ─────────────────────────────────────────────────────────────

def _decode_frame(frame_b64: str) -> np.ndarray | None:
    """Decode a base64 JPEG string (with or without data-URL prefix) → BGR array."""
    _, _, b64data = frame_b64.partition(",")
    img_bytes = base64.b64decode(b64data if b64data else frame_b64)
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def _infer_yolo(img: np.ndarray) -> tuple[float | None, dict]:
    """
    YOLO face-detection path.
    Target = largest face (most prominent / closest).
    Returns (pan_speed, overlay_data).
    pan_speed is None when no face is found; 0.0 when inside the deadzone.
    Called via asyncio.to_thread() — no shared mutable state.
    """
    img_h, img_w = img.shape[:2]
    img_cx = img_w / 2.0

    overlay = {"detections": [], "img_w": img_w, "img_h": img_h, "deadzone_px": DEADZONE_PX}

    results = model(img, verbose=False)[0]
    if not len(results.boxes):
        return None, overlay

    detections = []
    for box in results.boxes:
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        detections.append(
            {"x1": int(x1), "y1": int(y1), "x2": int(x2), "y2": int(y2),
             "area": int((x2 - x1) * (y2 - y1))}
        )

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


def _infer_csrt(img: np.ndarray, trk) -> tuple[float, dict]:
    """
    CSRT tracker update path.
    Returns (pan_speed, overlay_data).
    pan_speed is 0.0 when the target is lost.
    Called via asyncio.to_thread() — trk is not modified by any other thread
    because messages are processed sequentially per WebSocket connection.
    """
    img_h, img_w = img.shape[:2]
    img_cx = img_w / 2.0

    overlay = {"detections": [], "img_w": img_w, "img_h": img_h, "deadzone_px": 0}

    success, box = trk.update(img)
    if not success:
        return 0.0, overlay

    x, y, w, h = [int(v) for v in box]
    cx      = x + w / 2.0
    error_x = cx - img_cx

    # Same sign convention as YOLO: target right → negative speed (pan left)
    pan_speed = float(np.clip(-error_x * TRACKING_KP, -1.0, 1.0))

    overlay["detections"] = [{"x1": x, "y1": y, "x2": x + w, "y2": y + h, "is_target": True}]
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
    global tracker, tracking_mode, last_frame

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
                # Tell the Pi to drop pan events when CSRT tracking owns the pan axis
                orbit = tracking_mode == "csrt"
                await manager.send_to("pi", json.dumps({"command": "execute_move", "orbit": orbit}))
                await manager.send_to(
                    client_id, json.dumps({"ack": "execute_move", "status": "ok"})
                )

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
                # Mode change — reset tracker so the next mode starts clean.
                # start_orbit will re-init the tracker if the user draws a new box.
                tracker       = None
                tracking_mode = "yolo"
                await manager.send_to("pi", raw)

            # ── Orbit: initialize CSRT tracker with drawn ROI ─────────────────
            elif command == "start_orbit":
                roi = data.get("roi")   # [x, y, w, h] in native video pixels
                if not roi or last_frame is None:
                    print("WARN: start_orbit — no ROI or no frame available yet\n")
                    continue
                tracker = cv2.TrackerCSRT_create()
                tracker.init(last_frame, tuple(int(v) for v in roi))
                tracking_mode = "csrt"
                print(f"🔵  Orbit tracker initialized  roi={roi}\n")

            # ── Frame processing (tracking + orbit) ───────────────────────────
            elif command == "process_frame":
                frame_b64 = data.get("frame", "")
                if not frame_b64:
                    continue

                # Decode once — cheap, keep last frame for start_orbit init
                img = _decode_frame(frame_b64)
                if img is None:
                    continue
                last_frame = img

                if tracking_mode == "csrt" and tracker is not None:
                    # Run CSRT update in thread (tracker.update is CPU-bound)
                    pan_speed, overlay = await asyncio.to_thread(_infer_csrt, img, tracker)
                    await manager.send_to(
                        "ui", json.dumps({"command": "tracking_overlay", **overlay})
                    )
                    if pan_speed == 0.0:
                        print("🔵  csrt → pi  [lost / centered]")
                    else:
                        print(f"🔵  csrt → pi  pan_speed={pan_speed:+.4f}")
                    await manager.send_to(
                        "pi", json.dumps({"command": "track", "pan_speed": pan_speed})
                    )

                else:
                    # YOLO face-detection path
                    pan_speed, overlay = await asyncio.to_thread(_infer_yolo, img)
                    await manager.send_to(
                        "ui", json.dumps({"command": "tracking_overlay", **overlay})
                    )
                    if pan_speed is not None:
                        if pan_speed == 0.0:
                            print("🎯  yolo → pi  [deadzone]")
                        else:
                            print(f"🎯  yolo → pi  pan_speed={pan_speed:+.4f}")
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
