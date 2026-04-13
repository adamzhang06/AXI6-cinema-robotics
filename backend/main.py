####
# To run this backend, use the command: uvicorn main:app --reload --port 8000
####

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import asyncio

app = FastAPI()

# Allow React to talk to FastAPI (Cross-Origin Resource Sharing)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, change this to your React app's URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def read_root():
    return {"message": "FastAPI is running!"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("React UI Connected to WebSocket!")
    try:
        while True:
            # Wait for a message from the React frontend (e.g., joystick data)
            data = await websocket.receive_text()
            print(f"Received command: {data}")

            # --- YOLO / Pi Logic Goes Here ---
            # E.g., Process frame, send command to Pi via a different socket

            # Send data back to React (e.g., bounding boxes or Pi telemetry)
            await websocket.send_text(f"Backend processed command: {data}")

    except WebSocketDisconnect:
        print("React UI Disconnected")
