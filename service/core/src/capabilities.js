// Device capabilities (Agent Note 2026-10-07-capability-negotiation). The
// player's car profile and its web profile announce the sets below; other
// renderers send their own in `hello`. `containers` are the progressive file
// containers the device plays as they are (direct play,
// Agent Note 2026-10-12-lan-direct-play); `video` and `audio` are codec ids
// such as "avc1", "hvc1", "mp4a", "ac-3".
// A `remote` device shows and controls playback but cannot play: the Hub
// never picks it to play and refuses to play or move playback onto it.

export const RENDERERS = Object.freeze(["canvas-webcodecs", "html5-video", "native", "external", "remote"]);
export const DEVICE_KINDS = Object.freeze(["car", "browser", "phone", "tv", "other"]);

// The car profile's canvas engine, and any page the Tesla fingerprint
// recognizes: 720p H.264 and AAC, what the car decodes reliably.
export const CAR_CANVAS_CAPABILITIES = Object.freeze({
  renderer: "canvas-webcodecs",
  delivery: ["hls", "mp4"],
  containers: ["mp4"],
  video: ["avc1"],
  audio: ["mp4a"],
  maxHeight: 720,
  subtitles: "client-vtt",
  audioOnly: false,
});

// The web profile playing through the browser's own <video> element
// (Agent Note 2026-10-12-two-playback-engines): HLS through hls.js or the
// browser's native HLS, progressive MP4 directly. The page replaces `video`
// and `audio` with the codecs its browser reports, avc1 and mp4a first (these
// are the ones every such browser plays), and `maxHeight` with 2160, 1440,
// 1080, or 720 by its display (displayMaxHeight in the player's
// engine/native-support.js).
export const WEB_NATIVE_CAPABILITIES = Object.freeze({
  renderer: "html5-video",
  delivery: ["hls", "mp4"],
  containers: ["mp4"],
  video: ["avc1"],
  audio: ["mp4a"],
  maxHeight: 1080,
  subtitles: "client-vtt",
  audioOnly: false,
});

// The web profile in a browser without a usable <video> path but with the canvas
// engine: the car's engine, at up to 1080p
// (Agent Note 2026-10-11-yolo-web-client).
export const WEB_CANVAS_CAPABILITIES = Object.freeze({
  renderer: "canvas-webcodecs",
  delivery: ["hls", "mp4"],
  containers: ["mp4"],
  video: ["avc1"],
  audio: ["mp4a"],
  maxHeight: 1080,
  subtitles: "client-vtt",
  audioOnly: false,
});

// A browser that can run neither engine: the player there is a remote only.
export const REMOTE_CAPABILITIES = Object.freeze({
  renderer: "remote",
  delivery: [],
  containers: [],
  video: [],
  audio: [],
  maxHeight: 0,
  subtitles: "client-vtt",
  audioOnly: false,
});

/** Whether a device with these capabilities can play (not a remote). */
export const canPlay = (capabilities) => capabilities?.renderer !== "remote";

// What only the canvas engine reads (Agent Note 2026-10-12-two-playback-engines).
// It demuxes media itself, so it can read separate audio and video files by
// byte range (a `split-mp4` delivery) and keep a live playlist open across
// segments the source has not published yet. A <video> element needs one
// stream, and a native HLS player treats a live playlist's last segment as
// the live edge.

/** Whether the device reads a `split-mp4` delivery. */
export const readsSplitFiles = (capabilities) => capabilities?.renderer === "canvas-webcodecs";

/** Whether the device waits for advertised live segments that are not published yet. */
export const waitsForLiveRunway = (capabilities) => capabilities?.renderer === "canvas-webcodecs";

const SUBTITLE_MODES = new Set(["client-vtt", "native-vtt", "burn-in"]);

function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item) => typeof item === "string" && item.length <= 32).slice(0, 16);
}

export function normalizeCapabilities(input = {}) {
  const value = input && typeof input === "object" ? input : {};
  const maxHeight = Number(value.maxHeight);
  return {
    renderer: RENDERERS.includes(value.renderer) ? value.renderer : "html5-video",
    delivery: stringList(value.delivery, ["hls", "mp4"]),
    containers: stringList(value.containers, ["mp4"]),
    video: stringList(value.video, ["avc1"]),
    audio: stringList(value.audio, ["mp4a"]),
    maxHeight: Number.isFinite(maxHeight) && maxHeight > 0 ? Math.min(4320, Math.floor(maxHeight)) : 1080,
    subtitles: SUBTITLE_MODES.has(value.subtitles) ? value.subtitles : "client-vtt",
    audioOnly: value.audioOnly === true,
  };
}
