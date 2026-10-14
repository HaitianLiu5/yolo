import assert from "node:assert/strict";
import test from "node:test";
import { displayMaxHeight, HLS_MIME, hlsPathFor, nativeVideoSupport } from "../../src/engine/native-support.js";

// What a browser's media APIs answer, by codec family.
function probe({ nativeHls = false, mse = [], native = [], apple = false, pictureInPicture = true, fullscreen = true, airPlay = false } = {}) {
  const has = (list, type) => list.some((codec) => type.includes(codec));
  return {
    canPlay: (type) => (type === HLS_MIME ? (nativeHls ? "maybe" : "") : has(native, type) ? "probably" : ""),
    mse: mse === null ? null : (type) => has(mse, type),
    apple,
    pictureInPicture,
    fullscreen,
    airPlay,
  };
}

const CHROME = probe({ mse: ["avc1", "vp09", "av01", "mp4a", "opus"], native: ["avc1", "vp09", "mp4a"] });
const SAFARI = probe({ nativeHls: true, mse: ["avc1", "hvc1", "mp4a"], native: ["avc1", "hvc1", "mp4a"], apple: true, airPlay: true });
const IPHONE = probe({ nativeHls: true, mse: null, native: ["avc1", "hvc1", "mp4a"], apple: true, fullscreen: false, airPlay: true });

test("HLS reaches the <video> element natively in Apple's WebKit, through hls.js elsewhere", () => {
  assert.equal(hlsPathFor({ nativeHls: true, mse: true, apple: true }), "native");
  assert.equal(hlsPathFor({ nativeHls: true, mse: false, apple: true }), "native");
  // Chrome on Android (and lately on computers) also says it plays HLS:
  // hls.js still, for its statistics and audio renditions.
  assert.equal(hlsPathFor({ nativeHls: true, mse: true, apple: false }), "hls.js");
  assert.equal(hlsPathFor({ nativeHls: false, mse: true, apple: false }), "hls.js");
  assert.equal(hlsPathFor({ nativeHls: true, mse: false, apple: false }), "native");
  assert.equal(hlsPathFor({ nativeHls: false, mse: false, apple: false }), null);
});

test("the <video> element's support lists the codecs its HLS path plays, avc1 and mp4a first", () => {
  assert.deepEqual(nativeVideoSupport(CHROME), {
    hls: "hls.js", video: ["avc1", "vp09", "av01"], audio: ["mp4a", "opus"], pictureInPicture: true, fullscreen: true, airPlay: false,
  });
  // Safari: native HLS, so what the element itself plays counts.
  assert.deepEqual(nativeVideoSupport(SAFARI), {
    hls: "native", video: ["avc1", "hvc1"], audio: ["mp4a"], pictureInPicture: true, fullscreen: true, airPlay: true,
  });
  assert.equal(nativeVideoSupport(IPHONE).hls, "native");
  assert.equal(nativeVideoSupport(IPHONE).fullscreen, false);
  // Without H.264 and AAC, or without HLS, Yolo's streams do not play.
  assert.equal(nativeVideoSupport(probe({ mse: ["vp09", "opus"] })), null);
  assert.equal(nativeVideoSupport(probe({ mse: null, native: ["avc1", "mp4a"] })), null);
  assert.equal(nativeVideoSupport(null), null);
  // A probe that throws is a codec it does not play.
  assert.deepEqual(nativeVideoSupport({ ...CHROME, mse: (type) => { if (type.includes("av01")) throw new Error("no"); return CHROME.mse(type); } }).video, ["avc1", "vp09"]);
});

test("the display's ceiling is its physical short side, rounded to 720, 1080, 1440, or 2160", () => {
  const display = (width, height, devicePixelRatio) => displayMaxHeight({ screen: { width, height }, devicePixelRatio });
  assert.equal(display(1366, 768, 1), 720, "an older laptop");
  assert.equal(display(375, 667, 2), 720, "a small phone");
  assert.equal(display(1536, 864, 1.25), 1080, "a 1080p laptop at 125%");
  assert.equal(display(393, 852, 3), 1080, "a phone");
  assert.equal(display(2560, 1440, 1), 1440, "a 1440p monitor");
  assert.equal(display(1470, 956, 2), 2160, "a 13-inch Retina laptop");
  assert.equal(display(3840, 2160, 1), 2160);
  assert.equal(displayMaxHeight({}), 1080, "a browser that does not say");
});
