import { useState, useEffect, useRef, useCallback } from "react";

const WS_URL = "ws://localhost:8000/ws/ui";

export function useAXI6Socket() {
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [piStatus, setPiStatus] = useState("disconnected");
  const wsRef = useRef(null);

  const sendMessage = useCallback((payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify(payload));
        return true;
      } catch (err) {
        return false;
      }
    }
    return false;
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
        setPiStatus("disconnected");   // Pi is unreachable if backend drops
        reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.command === "pi_status") {
            setPiStatus(data.status);
          }
        } catch {
          /* noop */
        }
      };
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

  return { connectionStatus, piStatus, sendMessage };
}
