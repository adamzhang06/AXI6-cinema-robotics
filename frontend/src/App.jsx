import { useState, useEffect, useRef } from 'react';
import './App.css';

function App() {
  const [messages, setMessages] = useState([]);
  const ws = useRef(null);

  useEffect(() => {
    // Connect to the FastAPI WebSocket
    ws.current = new WebSocket('ws://localhost:8000/ws');

    ws.current.onopen = () => console.log('Connected to Python Backend');
    
    ws.current.onmessage = (event) => {
      // Listen for data from the backend (like YOLO coordinates or Pi stats)
      setMessages((prev) => [...prev, event.data]);
    };

    return () => {
      ws.current.close();
    };
  }, []);

  const sendCommand = () => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send('MOVE_FORWARD');
    }
  };

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Robotics Dashboard</h1>
      
      <button onClick={sendCommand} style={{ padding: '10px', fontSize: '16px' }}>
        Send "Move Forward" Command
      </button>

      <div style={{ marginTop: '20px', textAlign: 'left' }}>
        <h3>Telemetry from Backend:</h3>
        <pre style={{ background: '#f4f4f4', padding: '10px', color: '#333' }}>
          {messages.map((msg, index) => (
            <div key={index}>{msg}</div>
          ))}
        </pre>
      </div>
    </div>
  );
}

export default App;