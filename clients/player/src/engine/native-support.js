import { WEB_NATIVE_CAPABILITIES } from "@useyolo/core";

// Which playback engine this page uses and what the browser's own <video>
// element can play (Agent Note 2026-10-12-two-playback-engines).
//
// - A Tesla plays with the canvas engine only: Tesla can freeze a <video>
//   element while the car moves. That is the car profile, and also a page
//   the Tesla fingerprint recognizes whatever type the owner gave it.
// - The web profile plays with the browser's <video> element when it can
//   play Yolo's streams, else with the canvas engine, else not at all (a
//   remote).
//
// HLS reaches a <video> element two ways. Apple's WebKit (Safari, and every
// browser on iPhone and iPad) plays it natively, which also keeps AirPlay
// and the system's power-efficient pipeline; elsewhere hls.js feeds Media
// Source Extensions. Progressive files play directly in both.

export const HLS_MIME = "application/vnd.apple.mpegurl";

// One representative type per codec family, in Yolo's order of preference:
// avc1 and mp4a first, because every browser and every source has them and
// they decode in hardware everywhere.
const NATIVE_CODEC_PROBES = Object.freeze({
  video: Object.freeze([
    ["avc1", 'video/mp4; codecs="avc1.640028"'],
    ["hvc1", 'video/mp4; codecs="hvc1.1.6.L120.90"'],
    ["vp09", 'video/mp4; codecs="vp09.00.40.08"'],
    ["av01", 'video/mp4; codecs="av01.0.08M.08"'],
  ]),
  audio: Object.freeze([
    ["mp4a", 'audio/mp4; codecs="mp4a.40.2"'],
    ["opus", 'audio/mp4; codecs="opus"'],
    ["flac", 'audio/mp4; codecs="flac"'],
    ["ac-3", 'audio/mp4; codecs="ac-3"'],
    ["ec-3", 'audio/mp4; codecs="ec-3"'],
  ]),
});

/**
 * How HLS reaches the <video> element: "native" (the browser plays the
 * playlist itself), "hls.js" (Media Source Extensions), or null.
 * @param {{ nativeHls: boolean, mse: boolean, apple: boolean }} input
 */
export function hlsPathFor({ nativeHls, mse, apple }) {
  if (nativeHls && (apple || !mse)) return "native";
  if (mse) return "hls.js";
  return null;
}

/**
 * What this browser's <video> element plays, from a probe of its media APIs
 * (browserNativeProbe). Null when it cannot play Yolo's streams: HLS by
 * neither path, or not even H.264 with AAC.
 * @param {null | {
 *   canPlay: (type: string) => string,
 *   mse: null | ((type: string) => boolean),
 *   apple: boolean,
 *   pictureInPicture?: boolean,
 *   fullscreen?: boolean,
 *   airPlay?: boolean,
 * }} probe
 * @returns {null | { hls: "native" | "hls.js", video: string[], audio: string[],
 *   pictureInPicture: boolean, fullscreen: boolean, airPlay: boolean }}
 */
export function nativeVideoSupport(probe) {
  if (!probe || typeof probe.canPlay !== "function") return null;
  const hls = hlsPathFor({ nativeHls: Boolean(probe.canPlay(HLS_MIME)), mse: typeof probe.mse === "function", apple: Boolean(probe.apple) });
  if (!hls) return null;
  const plays = (type) => {
    try {
      return hls === "hls.js" ? Boolean(probe.mse(type)) : Boolean(probe.canPlay(type));
    } catch {
      return false;
    }
  };
  const video = NATIVE_CODEC_PROBES.video.filter(([, type]) => plays(type)).map(([codec]) => codec);
  const audio = NATIVE_CODEC_PROBES.audio.filter(([, type]) => plays(type)).map(([codec]) => codec);
  if (!video.includes("avc1") || !audio.includes("mp4a")) return null;
  return {
    hls,
    video,
    audio,
    pictureInPicture: Boolean(probe.pictureInPicture),
    fullscreen: Boolean(probe.fullscreen),
    airPlay: Boolean(probe.airPlay),
  };
}

/**
 * The largest picture worth sending to this display: 2160 or 1440 on a
 * dense or large screen, else 1080. An original file on the home network
 * plays as it is up to this height (Agent Note 2026-10-12-lan-direct-play).
 */
export function displayMaxHeight(win = globalThis) {
  const shortSide = Math.min(Number(win.screen?.width) || 0, Number(win.screen?.height) || 0) * (Number(win.devicePixelRatio) || 1);
  if (shortSide >= 1800) return 2160;
  if (shortSide >= 1300) return 1440;
  return WEB_NATIVE_CAPABILITIES.maxHeight;
}

/** The capabilities a page playing through <video> announces in `hello`. */
export function nativeCapabilities(support, maxHeight = WEB_NATIVE_CAPABILITIES.maxHeight) {
  return { ...WEB_NATIVE_CAPABILITIES, video: [...support.video], audio: [...support.audio], maxHeight };
}

/**
 * The engine a page plays with: "canvas", "native", or null (a remote).
 * `tesla` is the Tesla fingerprint (device-fingerprint.js).
 * @param {{ profile: "car" | "web", tesla?: boolean, canvas: boolean, native: object | null }} input
 */
export function playbackEngineFor({ profile, tesla = false, canvas, native }) {
  if (profile === "car" || tesla) return canvas ? "canvas" : null;
  if (native) return "native";
  return canvas ? "canvas" : null;
}

/** The real browser's media APIs, read once; null without a DOM. */
export function browserNativeProbe(win = globalThis) {
  let element;
  try {
    element = win.document?.createElement?.("video");
  } catch {
    return null;
  }
  if (!element || typeof element.canPlayType !== "function") return null;
  const source = typeof win.MediaSource?.isTypeSupported === "function" ? win.MediaSource
    : typeof win.ManagedMediaSource?.isTypeSupported === "function" ? win.ManagedMediaSource : null;
  const doc = win.document;
  return {
    canPlay: (type) => element.canPlayType(type),
    mse: source ? (type) => source.isTypeSupported(type) : null,
    apple: /Apple/.test(win.navigator?.vendor || ""),
    pictureInPicture: doc?.pictureInPictureEnabled === true
      || typeof element.webkitSupportsPresentationMode === "function" && element.webkitSupportsPresentationMode("picture-in-picture"),
    fullscreen: doc?.fullscreenEnabled === true || doc?.webkitFullscreenEnabled === true,
    airPlay: typeof win.WebKitPlaybackTargetAvailabilityEvent === "function",
  };
}
