import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_PING, TESLA_CANVAS_CAPABILITIES } from "@useyolo/core";
import { api, ApiError } from "./api.js";

// The device side of Yolo's realtime channel (yolo-v1.md §7): a WebSocket to
// the user's Hub, opened with a one-time ticket from /v1/realtime/ticket.
//
// - The device sends the heartbeat every 25 seconds, exactly HEARTBEAT_PING;
//   the Hub's runtime answers without waking up.
// - Reconnects back off exponentially, and wait at least 30 seconds after
//   the Hub says rate_limited (close 1008, or 429 on the upgrade).
// - Broadcasts (state, queue, playlists, devices) are never answered;
//   commands with an id are acknowledged.

const MAX_BACKOFF_MS = 30_000;
const RATE_LIMITED_BACKOFF_MS = 30_000;
const STALE_AFTER_MS = 70_000;
const REVOKED_CLOSE = 4003;

// What this browser is, for the owner's device list and the approval page.
export function describeDevice(userAgent = navigator.userAgent || "") {
  const tesla = /Tesla/i.test(userAgent);
  return { name: tesla ? "Tesla" : "Browser", kind: tesla ? "car" : "browser" };
}

export function createRealtime({ onMessage, onStatus = () => {}, onRevoked = () => {} }) {
  let socket = null;
  let deviceId = null;
  let attempts = 0;
  let reconnectTimer = null;
  let heartbeat = null;
  let lastActivityAt = 0;
  let stopped = true;
  let nextDelay = 0;

  function clearTimers() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function schedule(delayMs) {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void open();
    }, delayMs);
  }

  function backoff(minimum = 0) {
    attempts += 1;
    return Math.max(minimum, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts - 1, 5)));
  }

  async function open() {
    if (stopped || socket) return;
    onStatus("connecting");
    let ticket;
    try {
      ({ ticket } = await api("/v1/realtime/ticket", { method: "POST", label: "Realtime ticket", retries: 0 }));
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthorized") return;
      onStatus("offline");
      schedule(backoff(error?.code === "rate_limited" ? RATE_LIMITED_BACKOFF_MS : 0));
      return;
    }
    if (stopped || socket) return;
    const url = new URL("/v1/realtime", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    const ws = new WebSocket(url);
    socket = ws;
    lastActivityAt = Date.now();

    ws.onopen = () => {
      if (socket !== ws) return;
      lastActivityAt = Date.now();
      const { name, kind } = describeDevice();
      ws.send(JSON.stringify({ v: 1, type: "hello", deviceId, name, kind, capabilities: TESLA_CANVAS_CAPABILITIES }));
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(HEARTBEAT_PING);
        if (Date.now() - lastActivityAt > STALE_AFTER_MS) ws.close(4000, "stale");
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (socket !== ws || typeof event.data !== "string") return;
      lastActivityAt = Date.now();
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || message.v !== 1 || message.type === "pong") return;
      if (message.type === "welcome") {
        deviceId = message.deviceId;
        attempts = 0;
        onStatus("online");
      }
      onMessage(message);
      if (message.id && message.type !== "welcome") send({ type: "ack", id: message.id });
    };

    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      clearInterval(heartbeat);
      heartbeat = null;
      if (event.code === REVOKED_CLOSE) {
        onRevoked();
        return;
      }
      onStatus("offline");
      const delay = nextDelay || backoff(event.code === 1008 ? RATE_LIMITED_BACKOFF_MS : 0);
      nextDelay = 0;
      schedule(delay);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // Already closing.
      }
    };
  }

  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ v: 1, ...message }));
    return true;
  }

  return {
    get deviceId() {
      return deviceId;
    },
    get connected() {
      return socket?.readyState === WebSocket.OPEN && Boolean(deviceId);
    },
    start() {
      stopped = false;
      void open();
    },
    stop() {
      stopped = true;
      clearTimers();
      const ws = socket;
      socket = null;
      ws?.close(1000, "stopped");
    },
    // Reconnect now (a "take over here" press, or a page that wakes up).
    reconnect(delayMs = 0) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (socket) {
        nextDelay = Math.max(delayMs, 1);
        socket.close(1000, "reconnect");
      } else {
        schedule(delayMs);
      }
    },
    // A connection that looks dead after the page slept is replaced.
    verify() {
      if (stopped) return;
      if (!socket) schedule(0);
      else if (socket.readyState === WebSocket.OPEN && Date.now() - lastActivityAt > STALE_AFTER_MS) socket.close(4000, "stale");
    },
    send,
  };
}
