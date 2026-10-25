import { recordDeviceEvent } from "./device-events.js";

// The player's runtime log (Agent Note 2026-10-11-device-telemetry): each
// event goes to a ring buffer for diagnostics (globalThis.__yoloPlayerLog,
// which the end-to-end tests read), a debug console line, and the device
// events sent to Yolo's logs (device-events.js, which drops secrets and
// media tokens). Every event carries where playback is, from player.js, and
// the stream it belongs to.

const CAPACITY = 200;
const entries = [];
globalThis.__yoloPlayerLog = entries;

let context = () => ({});
let stream = 0;

/** `read()` gives the playback fields every event carries (player.js). */
export function setPlayerLogContext(read) {
  context = read;
}

/** The stream later events belong to: its number among the page's streams. */
export function setLoggedStream(id) {
  stream = id;
}

export const loggedStream = () => stream;

export function logPlayerEvent(type, fields = {}) {
  const payload = { type, timestamp: Date.now(), ...context(), playbackSessionId: stream, ...fields };
  entries.push(payload);
  if (entries.length > CAPACITY) entries.shift();
  console.debug("[player]", type, payload);
  recordDeviceEvent(type, payload);
}
