// PlaybackState is the single playback snapshot the Hub broadcasts
// (Agent Note 2026-10-07-v1-http-api). Clients extrapolate progress from
// position + positionAt.

export const CONTROL_ACTIONS = Object.freeze(["pause", "resume", "stop", "next", "previous"]);
export const LOAD_REASONS = Object.freeze(["play", "recovery", "seek", "quality", "transfer", "tracks"]);
// How a device reaches the node's media, in the order a device tries them
// (Agent Note 2026-10-13-media-off-the-worker): `lan` from the node's LAN
// listener on the home network, `wan` from its remote listener through the
// router, and `relay` through the control plane's /m/* passthrough and the
// tunnel, only while the owner has the relay on.
export const MEDIA_PATHS = Object.freeze(["lan", "wan", "relay"]);

// A path as a request or report names it, or null. "tunnel" is the relay's
// name in players and control planes from before 0.5, read until the
// release after it (Agent Note 2026-10-13-versions-and-releases).
export function mediaPath(value) {
  if (value === "tunnel") return "relay";
  return MEDIA_PATHS.includes(value) ? value : null;
}

export function emptyPlaybackState() {
  return {
    status: "idle",
    deviceId: null,
    item: null,
    position: 0,
    positionAt: 0,
    tracks: { subtitles: [], audio: null },
    sessionId: null,
  };
}

export function currentPosition(state, now = Date.now()) {
  const position = Number(state?.position) || 0;
  if (state?.status !== "playing" || !state.positionAt) return position;
  const elapsed = Math.max(0, now - state.positionAt) / 1000;
  const duration = Number(state.item?.duration) || 0;
  const next = position + elapsed;
  return duration > 0 && !state.item?.isLive ? Math.min(duration, next) : next;
}
