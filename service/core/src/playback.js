// PlaybackState is the single playback snapshot the Hub broadcasts
// (Agent Note 2026-10-07-v1-http-api). Clients extrapolate progress from
// position + positionAt.

export const CONTROL_ACTIONS = Object.freeze(["pause", "resume", "stop", "next", "previous"]);
export const LOAD_REASONS = Object.freeze(["play", "recovery", "seek", "quality", "transfer", "tracks"]);
// How a device reaches the node's media, in the order a device tries them
// (Agent Note 2026-10-13-media-off-the-worker): `lan` from the node's LAN
// listener on the home network, `wan` from its remote listener through the
// router, and `relay` through the control plane's /m/* passthrough and the
// tunnel, the fallback unless the owner turned it off.
export const MEDIA_PATHS = Object.freeze(["lan", "wan", "relay"]);

// The owner's relay modes: `auto` (the default) takes the relay only when
// no direct path works for a screen, `on` allows it as a path of its own,
// and `off` never relays.
export const RELAY_MODES = Object.freeze(["auto", "on", "off"]);

/** A relay mode as settings or a request names it, or null; a boolean is the switch before the modes. */
export function relayMode(value) {
  if (value === true) return "on";
  if (value === false) return "off";
  return RELAY_MODES.includes(value) ? value : null;
}

// A path as a request or report names it, or null for any other value,
// "tunnel" included: the relay's name before 0.5 is no longer read
// (Agent Note 2026-10-13-versions-and-releases).
export function mediaPath(value) {
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
