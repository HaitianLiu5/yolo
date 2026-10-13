// PlaybackState is the single playback snapshot the Hub broadcasts
// (Agent Note 2026-10-07-v1-http-api). Clients extrapolate progress from
// position + positionAt.

export const PLAYBACK_STATUSES = Object.freeze(["idle", "loading", "playing", "paused", "buffering"]);
export const CONTROL_ACTIONS = Object.freeze(["pause", "resume", "stop", "next", "previous"]);
export const LOAD_REASONS = Object.freeze(["play", "recovery", "seek", "quality", "transfer", "tracks"]);
// How a device reaches the node's media (Agent Note 2026-10-12-lan-direct-play):
// through the control plane's /m/* passthrough and the tunnel, or directly
// on the home network from the node's LAN listener.
export const NETWORKS = Object.freeze(["tunnel", "lan"]);

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
