import { api } from "./api.js";
import { state } from "./state.js";

// Asking Yolo to play on this device. The answer arrives as a `load` message
// on the realtime channel; these calls only start it.

const PLAY_TIMEOUT_MS = 90_000; // yt-dlp plus probing can take tens of seconds

// `ref` is one of { itemId }, { source }, { queueItemId }, { url }.
export function playOnThisDevice(ref, { startTime } = {}) {
  return api("/v1/playback/play", {
    method: "POST",
    body: { ...ref, deviceId: state.deviceId, ...(startTime != null ? { startTime } : {}) },
    timeoutMs: PLAY_TIMEOUT_MS,
    retries: 0,
    label: "Start playback",
  });
}

// A new stream of what this device already plays (recovery, a seek outside
// the stream, a page reload). `body` comes from
// buildFreshPlaybackSessionRequest().
export function requestStream(body) {
  return api("/v1/playback/play", {
    method: "POST",
    body: { ...body, deviceId: state.deviceId },
    timeoutMs: PLAY_TIMEOUT_MS,
    retries: 0,
    label: body.reason === "seek" ? "Seek" : "Playback recovery",
  });
}

export function setTracks(selection) {
  return api("/v1/playback/tracks", { method: "PUT", body: selection, timeoutMs: 60_000, retries: 0, label: "Change tracks" });
}
