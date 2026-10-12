// The last playback's technical details for /diag (diag.html): which
// stream was chosen, the measured throughput and buffer, quality changes and
// the last error. The player shows none of this; it lives here and in the
// device events (telemetry/device-events.js).

export const PLAYBACK_DIAGNOSTICS_KEY = "yolo.playback.diagnostics";
const WRITE_INTERVAL_MS = 5_000;
const MAX_EVENTS = 12;

let current = { updatedAt: null, stream: null, network: null, quality: null, events: [], lastError: null };
let lastWriteAt = 0;
let writeTimer = null;

function write() {
  writeTimer = null;
  lastWriteAt = Date.now();
  try {
    globalThis.localStorage?.setItem(PLAYBACK_DIAGNOSTICS_KEY, JSON.stringify(current));
  } catch {
    // Storage full or blocked: diagnostics are best effort.
  }
}

/**
 * Merge `patch` into the diagnostics. `event` (a { type, ...fields } object)
 * is appended to the recent events. Writes are spaced out unless `now`.
 */
export function notePlaybackDiagnostics(patch = {}, { event = null, now = false } = {}) {
  current = { ...current, ...patch, updatedAt: new Date().toISOString() };
  if (event) current.events = [...current.events, { at: new Date().toISOString(), ...event }].slice(-MAX_EVENTS);
  if (now || Date.now() - lastWriteAt >= WRITE_INTERVAL_MS) {
    clearTimeout(writeTimer);
    write();
  } else if (!writeTimer) {
    writeTimer = setTimeout(write, WRITE_INTERVAL_MS - (Date.now() - lastWriteAt));
  }
}
