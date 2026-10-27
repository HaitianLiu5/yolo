import { CLIENT_PROTOCOL, HEARTBEAT_INTERVAL_MS, HEARTBEAT_PING, CAR_CANVAS_CAPABILITIES } from "@useyolo/core";
import { api, ApiError } from "./api.js";
import { guessDevice, readFingerprintInput } from "./device-fingerprint.js";
import { t } from "./i18n.js";

// The device side of Yolo's realtime channel
// (Agent Note 2026-10-07-hub-and-realtime-channel): a WebSocket to the user's
// Hub, opened with a one-time ticket from /v1/realtime/ticket.
//
// - The device sends the heartbeat every 25 seconds, exactly HEARTBEAT_PING;
//   the Hub's runtime answers without waking up.
// - Reconnects back off exponentially, and wait at least 30 seconds after
//   the Hub says rate_limited (close 1008, or 429 on the upgrade), and a
//   minute after a welcome with `upgrade: true`, which main.js answers by
//   reloading the page (Agent Note 2026-10-19-client-protocol).
// - Broadcasts (state, queue, playlists, devices) are never answered;
//   commands with an id are acknowledged.
// - whenReady() lets the player's own requests wait until this socket is
//   open and welcomed: a request the Hub sees before the hello finds the
//   device offline when the car wakes up
//   (Agent Note 2026-10-11-wake-request-ordering).

const MAX_BACKOFF_MS = 30_000;
const RATE_LIMITED_BACKOFF_MS = 30_000;
const UPGRADE_RETRY_MS = 60_000;
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

// What this browser guesses it is, for the approval page, where the owner
// can change it (device-fingerprint.js).
export function describeDevice(input = readFingerprintInput()) {
  return guessDevice(input);
}

// `onEvent(type, fields)` receives connection telemetry (open, close,
// ticket failures, welcome); see telemetry/device-events.js. `describe()`
// gives the hello's name, kind, and capabilities (profile.js).
export function createRealtime({
  onMessage, onStatus = () => {}, onRevoked = () => {}, onEvent = () => {}, connectTimeoutMs = CONNECT_TIMEOUT_MS,
  describe = () => ({ ...describeDevice(), capabilities: CAR_CANVAS_CAPABILITIES }),
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
  // Pings sent and pongs received on the current socket, in order (the
  // runtime answers each ping once), and the callbacks waiting for the pong
  // of a given ping (confirm()). A new socket starts over; a socket that
  // goes takes its waiting callbacks with it.
  let pings = 0;
  let pongs = 0;
  let awaitingPong = [];
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

  // Every heartbeat goes through here, so pongs line up with pings.
  function ping(ws) {
    ws.send(HEARTBEAT_PING);
    pings += 1;
  }

  // A pong on the current socket: the callbacks waiting for it, or for an
  // earlier ping, go.
  function ponged(ws) {
    pongs += 1;
    const answered = awaitingPong.filter((entry) => entry.ws === ws && entry.ping <= pongs);
    if (!answered.length) return;
    awaitingPong = awaitingPong.filter((entry) => !answered.includes(entry));
    for (const entry of answered) {
      try {
        entry.heard();
      } catch {
        // A caller's failure never breaks the channel.
      }
    }
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
      ping(ws);
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
    pings = 0;
    pongs = 0;
    awaitingPong = [];
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
      const { name, kind, capabilities } = describe();
      ws.send(JSON.stringify({ v: 1, type: "hello", protocol: CLIENT_PROTOCOL, deviceId, name, kind, capabilities }));
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ping(ws);
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
      if (message?.v === 1 && message.type === "pong") ponged(ws);
      if (!message || message.v !== 1 || message.type === "pong") return;
      // Whether this connection was welcomed before this message: what
      // comes ahead of its welcome may be for a stream whose `load` went
      // with the connection before it (main.js).
      const welcomed = welcomedSocket === ws;
      // The Hub no longer serves this page's protocol and closes the
      // connection. It is not a welcome: no device, no reset backoff, and
      // the next try waits a minute, so a page whose reload is held back
      // (main.js) does not spend the Hub's connection allowance.
      if (message.type === "welcome" && message.upgrade) {
        nextDelay = UPGRADE_RETRY_MS;
        onMessage(message, { welcomed });
        return;
      }
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
      onMessage(message, { welcomed });
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
    // Pings over the welcomed connection now and calls `heard` when its
    // pong comes back: the socket delivers in order, so whatever the Hub
    // sends after that pong, or sent and the page has not received, was
    // sent after this call (the runtime is taken to answer a ping only
    // after what the Hub sent before it; Agent Note
    // 2026-10-07-hub-and-realtime-channel). Only a welcomed connection
    // counts: until a new connection's hello binds it, the Hub still sends
    // to the old one, so an answer over the new one proves nothing about
    // what the old one lost. False, and `heard` is never called, when there
    // is no welcomed open connection; never called either when it goes
    // before the pong.
    confirm(heard) {
      const ws = socket;
      if (stopped || !ws || ws !== welcomedSocket || ws.readyState !== WebSocket.OPEN) return false;
      try {
        ping(ws);
      } catch {
        return false;
      }
      awaitingPong.push({ ws, ping: pings, heard });
      return true;
    },
    // Resolves once the Hub has welcomed this connection, at once if it
    // already has. A dead connection is replaced first. Rejects with a
    // RealtimeUnavailableError after `timeoutMs`, or when stopped.
    whenReady({ timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
      if (isReady()) return Promise.resolve();
      if (stopped) return Promise.reject(new RealtimeUnavailableError(t("This screen is not connected to Yolo"), "realtime_stopped"));
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
          t("Yolo's realtime connection did not come back within {seconds} s", { seconds: Math.round(timeoutMs / 1000) }),
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
      rejectWaiters(new RealtimeUnavailableError(t("This screen is not connected to Yolo"), "realtime_stopped"));
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
