import { api } from "./api.js";
import { state } from "./state.js";
import { createStreamRequester } from "./stream-requests.js";
import { recordDeviceEvent } from "./telemetry/device-events.js";

// Asking Yolo to play on this device. The answer arrives as a `load` message
// on the realtime channel; these calls only start it, and they wait until the
// channel is connected and welcomed, so the Hub sees this device online and
// the `load` reaches it (stream-requests.js).

const PLAY_TIMEOUT_MS = 90_000; // yt-dlp plus probing can take tens of seconds

let channel = null;
let paths = null;

const requester = createStreamRequester({
  // Before the realtime channel runs (pairing, the page's own tests), there
  // is nothing to wait for.
  whenReady: (options) => (channel?.running ? channel.whenReady(options) : Promise.resolve()),
  replaceChannel: (reason) => channel?.replace(reason),
  // Refused as superseded: the `load` of the stream that won comes over
  // the channel, which may have died unnoticed; a dead one is replaced, and
  // the welcome after it names that stream (main.js).
  onSuperseded: () => channel?.probe(),
  onEvent: recordDeviceEvent,
});

// The realtime channel (realtime.js), set by main.js.
export function setPlaybackChannel(realtime) {
  channel = realtime;
}

// The screen's media paths (media-paths.js), set by main.js.
export function setPlaybackNetwork(controller) {
  paths = controller;
}

async function playRequest(body, label) {
  // The probes after a welcome choose the path first (at most their
  // timeouts); a recovery's path is already chosen.
  await paths?.settled();
  return api("/v1/playback/play", {
    method: "POST",
    // The device id is read when the request is sent: after a reload, the
    // welcome is what tells this page which device it is. So is the path: a
    // recovery after a failure asks for the next one down
    // (Agent Note 2026-10-13-media-off-the-worker); null says none works.
    body: { ...body, deviceId: state.deviceId, ...(paths ? { network: paths.network() } : {}) },
    timeoutMs: PLAY_TIMEOUT_MS,
    retries: 0,
    label,
  });
}

// `ref` is one of { itemId }, { source }, { queueItemId }, { url }.
export function playOnThisDevice(ref, { startTime } = {}) {
  return requester.request(
    () => playRequest({ ...ref, ...(startTime != null ? { startTime } : {}) }, "Start playback"),
    { label: "Start playback", reason: "play" },
  );
}

// A new stream of what this device already plays (recovery, a seek outside
// the stream, a page reload or wake). `buildBody()` runs once the channel is
// ready and returns the body from buildFreshPlaybackSessionRequest(), or null
// when the stream it would replace is gone already (nothing is sent then).
// Recoveries are single-flight: a second one joins the first.
export function requestStream(buildBody, { label, reason = "recovery" } = {}) {
  const name = label || (reason === "seek" ? "Seek" : "Playback recovery");
  return requester.request(() => {
    const body = buildBody();
    return body ? playRequest(body, name) : null;
  }, { label: name, reason });
}

export const streamRecoveryPending = () => requester.recoveryPending;

// The first items this screen's home offers, which Yolo may resolve ahead
// for it (POST /v1/playback/warm), so a tap on one starts sooner. It waits
// for this page's media path, which decides the stream's ceiling and with
// it the formats a source picks. Best effort: never retried, never an error.
const WARM_SOURCES = 3;
export async function warmPlayback(sources) {
  const list = sources.filter(Boolean).slice(0, WARM_SOURCES);
  if (!list.length || !channel?.ready) return;
  await paths?.settled();
  await api("/v1/playback/warm", {
    method: "POST",
    body: { sources: list, ...(paths?.network() ? { network: paths.network() } : {}) },
    timeoutMs: 10_000,
    retries: 0,
    label: "Warm",
  }).catch(() => {});
}

export async function setTracks(selection) {
  // A track change can rebuild the stream (`load` with reason "tracks"),
  // which the Hub sends over the channel.
  if (channel?.running) await channel.whenReady();
  return api("/v1/playback/tracks", { method: "PUT", body: selection, timeoutMs: 60_000, retries: 0, label: "Change tracks" });
}
