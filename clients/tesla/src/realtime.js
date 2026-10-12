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
// - whenReady() lets the player's own requests wait until this socket is
//   open and welcomed: a request the Hub sees before the hello finds the
//   device offline (the car waking up, yolo-v1.md §7).

const MAX_BACKOFF_MS = 30_000;
const RATE_LIMITED_BACKOFF_MS = 30_000;
const STALE_AFTER_MS = 70_000;
// After the page slept, a ping must come back this fast or the socket is
// treated as dead and replaced.
const PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
// A socket that neither opens nor fails this long (a network that drops
// packets silently) is replaced.
const CONNECT_TIMEOUT_MS = 15_000;
const REVOKED_CLOSE = 4003;

export class RealtimeUnavailableError extends Error {
  constructor(message, code = "realtime_unavailable") {
    super(message);
    this.name = "RealtimeUnavailableError";
    this.code = code;
  }
}

// What this browser is, for the owner's device list and the approval page.
export function describeDevice(userAgent = navigator.userAgent || "") {
  const tesla = /Tesla/i.test(userAgent);
  return { name: tesla ? "Tesla" : "Browser", kind: tesla ? "car" : "browser" };
}

// `onEvent(type, fields)` receives connection telemetry (open, close,
// ticket failures, welcome); see telemetry/device-events.js.
export function createRealtime({
  onMessage, onStatus = () => {}, onRevoked = () => {}, onEvent = () => {}, connectTimeoutMs = CONNECT_TIMEOUT_MS,
}) {
  let socket = null;
  let deviceId = null;
  let attempts = 0;
  let reconnectTimer = null;
  let heartbeat = null;
  let lastActivityAt = 0;
  let stopped = true;
  let nextDelay = 0;
  // The socket the Hub welcomed; requests wait for it (whenReady).
  let welcomedSocket = null;
  let probeTimer = null;
  let connectTimer = null;
  let openedAt = 0;
  const waiters = new Set();

  function clearTimers() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearInterval(heartbeat);
    heartbeat = null;
    clearProbe();
    clearConnectTimer();
  }

  function clearProbe() {
    clearTimeout(probeTimer);
    probeTimer = null;
  }

  function clearConnectTimer() {
    clearTimeout(connectTimer);
    connectTimer = null;
  }

  function isReady() {
    return Boolean(socket)
      && socket === welcomedSocket
      && socket.readyState === WebSocket.OPEN
      && !probeTimer
      && Date.now() - lastActivityAt <= STALE_AFTER_MS;
  }

  function settleWaiters() {
    if (!isReady()) return;
    for (const waiter of [...waiters]) waiter.resolve();
  }

  function rejectWaiters(error) {
    for (const waiter of [...waiters]) waiter.reject(error);
  }

  function emit(type, fields) {
    try {
      onEvent(type, fields);
    } catch {
      // Telemetry never breaks the channel.
    }
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

  // Give up on `ws` now, without waiting for its close handshake: a socket
  // that died while the page slept may never finish one.
  function drop(ws, reason) {
    if (!ws || socket !== ws) return;
    socket = null;
    if (welcomedSocket === ws) welcomedSocket = null;
    clearInterval(heartbeat);
    heartbeat = null;
    clearProbe();
    clearConnectTimer();
    emit("realtime_close", { code: 4000, reason, wasClean: false, local: true, openForMs: openedAt ? Date.now() - openedAt : null });
    openedAt = 0;
    try {
      ws.close(4000, reason);
    } catch {
      // Already closing.
    }
    onStatus("offline");
    const delay = backoff();
    schedule(attempts === 1 ? 0 : delay);
  }

  function verify() {
    if (stopped) return;
    if (!socket) schedule(0);
    else if (socket.readyState === WebSocket.OPEN && Date.now() - lastActivityAt > STALE_AFTER_MS) drop(socket, "stale");
  }

  function probe(timeoutMs) {
    if (stopped || probeTimer) return;
    verify();
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(HEARTBEAT_PING);
    } catch {
      drop(ws, "stale");
      return;
    }
    probeTimer = setTimeout(() => {
      probeTimer = null;
      if (socket !== ws) return;
      emit("realtime_probe", { outcome: "dead", timeoutMs });
      drop(ws, "stale");
    }, timeoutMs);
  }

  async function open() {
    if (stopped || socket) return;
    onStatus("connecting");
    let ticket;
    const ticketStartedAt = Date.now();
    try {
      ({ ticket } = await api("/v1/realtime/ticket", { method: "POST", label: "Realtime ticket", retries: 0 }));
    } catch (error) {
      emit("realtime_ticket_failed", {
        code: error?.code || error?.name || null, status: error?.status ?? null, message: error?.message || String(error), attempt: attempts + 1,
        durationMs: Date.now() - ticketStartedAt,
      });
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
    const connectStartedAt = Date.now();
    clearConnectTimer();
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (socket === ws && ws.readyState === WebSocket.CONNECTING) drop(ws, "connect_timeout");
    }, connectTimeoutMs);

    ws.onopen = () => {
      if (socket !== ws) return;
      clearConnectTimer();
      lastActivityAt = Date.now();
      openedAt = Date.now();
      emit("realtime_open", { connectMs: openedAt - connectStartedAt, ticketMs: connectStartedAt - ticketStartedAt, attempt: attempts + 1 });
      const { name, kind } = describeDevice();
      ws.send(JSON.stringify({ v: 1, type: "hello", deviceId, name, kind, capabilities: TESLA_CANVAS_CAPABILITIES }));
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(HEARTBEAT_PING);
        if (Date.now() - lastActivityAt > STALE_AFTER_MS) drop(ws, "stale");
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (socket !== ws || typeof event.data !== "string") return;
      lastActivityAt = Date.now();
      if (probeTimer) {
        // Any traffic proves the socket survived the page's sleep.
        clearProbe();
        emit("realtime_probe", { outcome: "alive" });
        settleWaiters();
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || message.v !== 1 || message.type === "pong") return;
      if (message.type === "welcome") {
        deviceId = message.deviceId;
        welcomedSocket = ws;
        emit("realtime_welcome", {
          attempt: attempts + 1, sinceOpenMs: openedAt ? Date.now() - openedAt : null,
          hubStatus: message.state?.status ?? null, hubSessionId: message.state?.sessionId ?? null,
          interruptedAt: message.state?.interruptedAt ?? null,
        });
        attempts = 0;
        onStatus("online");
      }
      onMessage(message);
      if (message.id && message.type !== "welcome") send({ type: "ack", id: message.id });
      // After main.js handled the welcome, requests waiting for it go.
      if (message.type === "welcome") settleWaiters();
    };

    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      if (welcomedSocket === ws) welcomedSocket = null;
      clearInterval(heartbeat);
      heartbeat = null;
      clearProbe();
      clearConnectTimer();
      emit("realtime_close", {
        code: event.code, reason: String(event.reason || "").slice(0, 120), wasClean: Boolean(event.wasClean),
        openForMs: openedAt ? Date.now() - openedAt : null,
      });
      openedAt = 0;
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
    // Open, welcomed by the Hub, and not left over from before a sleep.
    get ready() {
      return isReady();
    },
    // Started (paired) and trying to stay connected.
    get running() {
      return !stopped;
    },
    // Resolves once the Hub has welcomed this connection, at once if it
    // already has. A dead connection is replaced first. Rejects with a
    // RealtimeUnavailableError after `timeoutMs`, or when stopped.
    whenReady({ timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
      if (isReady()) return Promise.resolve();
      if (stopped) return Promise.reject(new RealtimeUnavailableError("This screen is not connected to Yolo", "realtime_stopped"));
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve: () => {
            clearTimeout(timer);
            waiters.delete(waiter);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            waiters.delete(waiter);
            reject(error);
          },
        };
        const timer = setTimeout(() => waiter.reject(new RealtimeUnavailableError(
          `Yolo's realtime connection did not come back within ${Math.round(timeoutMs / 1000)} s`,
        )), timeoutMs);
        waiters.add(waiter);
        verify();
      });
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
      welcomedSocket = null;
      ws?.close(1000, "stopped");
      rejectWaiters(new RealtimeUnavailableError("This screen is not connected to Yolo", "realtime_stopped"));
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
    // The Hub says this device is offline although the socket looks fine:
    // it died without the browser noticing. Replace it now.
    replace(reason = "replaced") {
      if (stopped) return;
      if (socket) drop(socket, reason);
      else schedule(0);
    },
    // A connection that looks dead after the page slept is replaced.
    verify,
    // The page just woke up: its socket may have died while it slept without
    // the browser noticing yet. Ping it; no answer within PROBE_TIMEOUT_MS
    // replaces it. Requests wait meanwhile (whenReady).
    probe(timeoutMs = PROBE_TIMEOUT_MS) {
      probe(timeoutMs);
    },
    send,
  };
}
