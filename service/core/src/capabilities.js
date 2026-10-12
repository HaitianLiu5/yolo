// Device capabilities (Agent Note 2026-10-07-capability-negotiation). Tesla's
// canvas player is one profile; other renderers send their own in `hello`.
// A `remote` device shows and controls playback but cannot play: the Hub
// never picks it to play and refuses to play or move playback onto it.

export const RENDERERS = Object.freeze(["canvas-webcodecs", "html5-video", "native", "external", "remote"]);
export const DEVICE_KINDS = Object.freeze(["car", "browser", "phone", "tv", "other"]);

export const TESLA_CANVAS_CAPABILITIES = Object.freeze({
  renderer: "canvas-webcodecs",
  delivery: ["hls", "mp4"],
  video: ["avc1"],
  audio: ["mp4a"],
  maxHeight: 720,
  subtitles: "client-vtt",
  audioOnly: false,
});

// Yolo Web in a computer's or phone's browser: the same canvas engine, at
// up to 1080p (Agent Note 2026-10-11-yolo-web-client).
export const WEB_CANVAS_CAPABILITIES = Object.freeze({
  renderer: "canvas-webcodecs",
  delivery: ["hls", "mp4"],
  video: ["avc1"],
  audio: ["mp4a"],
  maxHeight: 1080,
  subtitles: "client-vtt",
  audioOnly: false,
});

// A browser that cannot run the canvas engine (no cross-origin isolation or
// WebCodecs): Yolo Web there is a remote only.
export const REMOTE_CAPABILITIES = Object.freeze({
  renderer: "remote",
  delivery: [],
  video: [],
  audio: [],
  maxHeight: 0,
  subtitles: "client-vtt",
  audioOnly: false,
});

/** Whether a device with these capabilities can play (not a remote). */
export const canPlay = (capabilities) => capabilities?.renderer !== "remote";

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
    video: stringList(value.video, ["avc1"]),
    audio: stringList(value.audio, ["mp4a"]),
    maxHeight: Number.isFinite(maxHeight) && maxHeight > 0 ? Math.min(4320, Math.floor(maxHeight)) : 1080,
    subtitles: SUBTITLE_MODES.has(value.subtitles) ? value.subtitles : "client-vtt",
    audioOnly: value.audioOnly === true,
  };
}
