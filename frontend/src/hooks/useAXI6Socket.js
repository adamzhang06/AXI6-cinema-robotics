import { useState, useEffect, useRef, useCallback } from "react";

const WS_URL = "ws://localhost:8000/ws/ui";

export function useAXI6Socket() {
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const wsRef = useRef(null);

  const sendMessage = useCallback((payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  useEffect(() => {
    let unmounted = false;
    let reconnectTimer = null;

    const connect = () => {
      if (unmounted) return;
      setConnectionStatus("connecting");
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen  = () => { if (!unmounted) setConnectionStatus("connected"); };
      ws.onclose = () => {
        if (unmounted) return;
        setConnectionStatus("disconnected");
        reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, []);

  return { connectionStatus, sendMessage };
}
