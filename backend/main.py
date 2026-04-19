####
# To run this backend, use the command: uvicorn main:app --reload --port 8000
####

import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
                json.dumps(
                    {"sender": "hub", "command": "pi_status", "status": "connected"}
                ),
            )
        elif client_id == "ui":
            status = "connected" if "pi" in self.active_connections else "disconnected"
            await self.send_to(
                "ui",
                json.dumps(
                    {"sender": "hub", "command": "pi_status", "status": status}
                ),
            )

    def disconnect(self, client_id: str):
        self.active_connections.pop(client_id, None)
        print(
            f"[-] {client_id} disconnected  (active: {list(self.active_connections)})"
        )

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

            if command == "save_trajectory":
                print("\n🟢  TRAJECTORY SAVED — forwarding to pi\n")
                await manager.send_to("pi", raw)  # forward full payload to Pi
                await manager.send_to(
                    client_id, json.dumps({"ack": "save_trajectory", "status": "ok"})
                )

            elif command == "execute_move":
                print("\n🚀  EXECUTING MOVE — forwarding to pi\n")
                await manager.send_to("pi", json.dumps({"command": "execute_move"}))
                await manager.send_to(
                    client_id, json.dumps({"ack": "execute_move", "status": "ok"})
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
                json.dumps(
                    {"sender": "hub", "command": "pi_status", "status": "disconnected"}
                ),
            )
