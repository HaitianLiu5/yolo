import {
  DEVICE_EVENT_TYPE,
  DEVICE_EVENTS_PATH,
  MAX_DEVICE_EVENTS_BODY_BYTES,
  MAX_DEVICE_EVENTS_PER_BATCH,
  sanitizeEventFields,
} from "@useyolo/core";
import { getCredential } from "../api.js";
import { state } from "../state.js";

// Device events (埋点): what happens to this page — the player's runtime log,
// page lifecycle (visibility, pagehide/pageshow, freeze/resume, online), the
// realtime connection, recoveries, and how long a wake took to play again —
// sent in batches to POST /v1/devices/self/events, where each event becomes one
// Workers Logs line (`kind = device_event`,
// Agent Note 2026-10-11-device-telemetry).
//
// - At most one request every 10 seconds, at most 50 events in it.
// - Events wait in a capped buffer while offline or unpaired; the oldest go
//   first when it is full.
// - On pagehide and freeze the rest leaves with a keepalive fetch (a beacon
//   cannot carry the device credential).
// - Fields are sanitized here and again on the server: no credentials,
//   tickets or cookies, and `/m/<token>` paths are redacted.

export const FLUSH_INTERVAL_MS = 10_000;
export const BUFFER_CAPACITY = 400;
const RATE_LIMITED_BACKOFF_MS = 60_000;
const FAILURE_BACKOFF_MS = 30_000;
// A wake whose playback has not come back within this long is not timed.
const WAKE_TIMING_WINDOW_MS = 10 * 60_000;
const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(JSON.stringify(value)).length;

/**
 * The batching core, without browser globals so it can be tested.
 * @param {object} options
 * @param {(body: object, options: { keepalive: boolean }) => Promise<{ status: number }>} options.send
 */
export function createDeviceEvents({
  send,
  now = () => Date.now(),
  isOnline = () => true,
  hasCredential = () => true,
  getSessionId = () => null,
  pageId = Math.random().toString(36).slice(2, 12),
  capacity = BUFFER_CAPACITY,
  maxBatchEvents = MAX_DEVICE_EVENTS_PER_BATCH,
  maxBatchBytes = MAX_DEVICE_EVENTS_BODY_BYTES,
  flushIntervalMs = FLUSH_INTERVAL_MS,
} = {}) {
  const buffer = [];
  let seq = 0;
  let dropped = 0;
  let inFlight = 0;
  let nextSendAt = 0;
  let wake = null;

  function keep(events, { front = false } = {}) {
    if (front) buffer.unshift(...events);
    else buffer.push(...events);
    const overflow = buffer.length - capacity;
    if (overflow > 0) {
      buffer.splice(0, overflow);
      dropped += overflow;
    }
  }

  function record(type, fields = {}) {
    if (typeof type !== "string" || !DEVICE_EVENT_TYPE.test(type)) return;
    let sessionId = null;
    try {
      sessionId = getSessionId() ?? null;
    } catch {
      // No session.
    }
    seq += 1;
    keep([{ type, at: now(), seq, sessionId, fields: sanitizeEventFields(fields) }]);
  }

  // The next batch: oldest first, within the event and byte limits.
  function take() {
    const events = [];
    let size = bytes({ pageId, dropped, events: [] });
    while (buffer.length && events.length < maxBatchEvents) {
      const next = bytes(buffer[0]) + 1;
      if (events.length && size + next > maxBatchBytes) break;
      events.push(buffer.shift());
      size += next;
    }
    return events;
  }

  // `keepalive` is for a page going away (pagehide, freeze): it skips the
  // 10-second spacing and the online check, which may be stale.
  async function flush({ keepalive = false } = {}) {
    if (!buffer.length || !hasCredential()) return false;
    if (!keepalive && (inFlight > 0 || !isOnline() || now() < nextSendAt)) return false;
    const events = take();
    const reportedDrops = dropped;
    dropped = 0;
    inFlight += 1;
    nextSendAt = now() + flushIntervalMs;
    try {
      const { status } = await send({ pageId, dropped: reportedDrops, events }, { keepalive });
      if (status >= 200 && status < 300) return true;
      if (status === 429) {
        nextSendAt = now() + RATE_LIMITED_BACKOFF_MS;
        keep(events, { front: true });
      } else if (status === 0 || status >= 500 || status === 401) {
        // The network, the server, or a credential being replaced: later.
        nextSendAt = now() + FAILURE_BACKOFF_MS;
        keep(events, { front: true });
      } else {
        // The server refused these events (400, 403): resending would fail
        // the same way.
        dropped += events.length;
      }
      dropped += reportedDrops;
      return false;
    } catch {
      nextSendAt = now() + FAILURE_BACKOFF_MS;
      keep(events, { front: true });
      dropped += reportedDrops;
      return false;
    } finally {
      inFlight -= 1;
    }
  }

  return {
    pageId,
    record,
    flush,
    get size() {
      return buffer.length;
    },
    get dropped() {
      return dropped;
    },
    // The wake still waiting for playback to run again, or null.
    get wakePending() {
      return wake;
    },
    // The page just woke up (resume event, or a gap in its timers): time how
    // long until playback runs again.
    markWake(source, gapMs = null) {
      wake = { at: now(), source, gapMs };
      record("page_wake", { source, gapMs });
    },
    markPlaybackRestored(fields = {}) {
      if (!wake) return;
      const delayMs = now() - wake.at;
      const { source, gapMs } = wake;
      wake = null;
      if (delayMs <= WAKE_TIMING_WINDOW_MS) record("wake_to_playback", { delayMs, wakeSource: source, gapMs, ...fields });
    },
  };
}

// --- The page's instance ----------------------------------------------------

let instance = null;

function browserSend(body, { keepalive }) {
  const credential = getCredential();
  if (!credential?.token) return Promise.resolve({ status: 401 });
  return fetch(`${location.origin}${DEVICE_EVENTS_PATH}`, {
    method: "POST",
    keepalive,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.token}` },
    body: JSON.stringify(body),
  }).then((response) => ({ status: response.status }));
}

export function deviceEvents() {
  instance ??= createDeviceEvents({
    send: browserSend,
    isOnline: () => globalThis.navigator?.onLine !== false,
    hasCredential: () => Boolean(getCredential()),
    getSessionId: () => state.sessionId,
  });
  return instance;
}

export function recordDeviceEvent(type, fields) {
  deviceEvents().record(type, fields);
}

const WAKE_CHECK_INTERVAL_MS = 5_000;
// Timers that fire this much later than due mean the page (or the whole
// car) was suspended.
const WAKE_GAP_MS = 20_000;

// Page lifecycle events, the periodic flush, and wake detection. `onWake`
// lets main.js check its realtime connection at once.
export function installDeviceTelemetry({ onWake = () => {} } = {}) {
  const events = deviceEvents();
  const record = (type, fields) => events.record(type, fields);
  const wake = (source, gapMs = null) => {
    events.markWake(source, gapMs);
    try {
      onWake(source);
    } catch {
      // Telemetry never breaks the page.
    }
  };

  record("page_start", {
    userAgent: navigator.userAgent,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: globalThis.devicePixelRatio || 1 },
    visibility: document.visibilityState,
    online: navigator.onLine,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  });

  document.addEventListener("visibilitychange", () => {
    record("visibilitychange", { state: document.visibilityState });
    if (document.visibilityState === "hidden") void events.flush({ keepalive: true });
  });
  window.addEventListener("pagehide", (event) => {
    record("pagehide", { persisted: Boolean(event.persisted) });
    void events.flush({ keepalive: true });
  });
  window.addEventListener("pageshow", (event) => {
    record("pageshow", { persisted: Boolean(event.persisted) });
    if (event.persisted) wake("pageshow");
  });
  // Page Lifecycle API (Chromium): the page is frozen, then resumed.
  document.addEventListener("freeze", () => {
    record("freeze", {});
    void events.flush({ keepalive: true });
  });
  document.addEventListener("resume", () => {
    record("resume", { wasDiscarded: Boolean(document.wasDiscarded) });
    wake("resume");
  });
  window.addEventListener("online", () => {
    record("online", {});
    void events.flush();
  });
  window.addEventListener("offline", () => record("offline", {}));

  // A car that sleeps suspends everything; no event says so. A timer that
  // fires far too late does.
  let lastTick = Date.now();
  let visibleAtLastTick = document.visibilityState === "visible";
  setInterval(() => {
    const tick = Date.now();
    const gapMs = tick - lastTick - WAKE_CHECK_INTERVAL_MS;
    // Hidden pages' timers are throttled on purpose; only a visible page's
    // late timer means a sleep.
    if (gapMs > WAKE_GAP_MS && visibleAtLastTick) wake("timer_gap", gapMs);
    lastTick = tick;
    visibleAtLastTick = document.visibilityState === "visible";
  }, WAKE_CHECK_INTERVAL_MS);

  setInterval(() => void events.flush(), FLUSH_INTERVAL_MS);
  return events;
}
