import assert from "node:assert/strict";
import test from "node:test";
import { REMOTE_CAPABILITIES, CAR_CANVAS_CAPABILITIES, WEB_CANVAS_CAPABILITIES, WEB_NATIVE_CAPABILITIES } from "@useyolo/core";
import { createProfile, KIND_KEY, profileFor } from "../../src/profile.js";

const TESLA_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// `playable`: the canvas engine runs; `video`: the <video> element plays
// HLS through Media Source (Chrome) or natively (Safari), or not at all.
function fakeWindow({ tesla = false, stored = {}, playable = true, video = null } = {}) {
  const items = new Map(Object.entries(stored));
  const root = { dataset: {} };
  const engine = playable ? { crossOriginIsolated: true, SharedArrayBuffer, VideoDecoder: function () {}, AudioDecoder: function () {}, AudioWorkletNode: function () {} } : {};
  const element = { canPlayType: (type) => (type.includes("mpegurl") ? (video === "native" ? "maybe" : "") : video ? "probably" : "") };
  return {
    ...engine,
    ...(video === "mse" ? { MediaSource: { isTypeSupported: () => true } } : {}),
    devicePixelRatio: tesla ? 1.53 : 2,
    innerWidth: tesla ? 773 : 1440,
    innerHeight: tesla ? 601 : 900,
    screen: tesla ? { width: 1254, height: 784 } : { width: 1440, height: 900 },
    visualViewport: { scale: 1 },
    navigator: { userAgent: TESLA_UA },
    localStorage: { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)), removeItem: (key) => items.delete(key) },
    document: { documentElement: root, createElement: () => element },
    items,
    root,
  };
}

test("the owner's device type decides the profile; the fingerprint only guesses until then", () => {
  assert.equal(profileFor({ tesla: true }), "car");
  assert.equal(profileFor({ tesla: false }), "web");
  assert.equal(profileFor({ kind: "car", tesla: false }), "car");
  assert.equal(profileFor({ kind: "browser", tesla: true }), "web");
  assert.equal(profileFor({ kind: "toaster", tesla: true }), "car");
});

test("the car plays with the canvas engine, the web profile with the <video> element, and each announces its engine's capabilities", () => {
  // A Tesla, also where its browser would play <video>: canvas.
  const car = createProfile({ win: fakeWindow({ tesla: true, video: "mse" }) });
  assert.deepEqual([car.name, car.engine, car.canPlay, car.capabilities()], ["car", "canvas", true, CAR_CANVAS_CAPABILITIES]);
  // A computer's Chrome: hls.js through Media Source.
  const computer = createProfile({ win: fakeWindow({ video: "mse" }) });
  assert.deepEqual([computer.name, computer.engine, computer.native.hls], ["web", "native", "hls.js"]);
  // A 1440×900 display at 2× is worth 2160p originals on the home network.
  assert.deepEqual(computer.capabilities(), {
    ...WEB_NATIVE_CAPABILITIES, video: ["avc1", "hvc1", "vp09", "av01"], audio: ["mp4a", "opus", "flac", "ac-3", "ec-3"], maxHeight: 2160,
  });
  // Safari on iPhone: not cross-origin isolated, native HLS. It plays.
  const iphone = createProfile({ win: fakeWindow({ playable: false, video: "native", stored: { [KIND_KEY]: "phone" } }) });
  assert.deepEqual([iphone.engine, iphone.canPlay, iphone.native.hls], ["native", true, "native"]);
  // A <video> element without Yolo's streams, but the canvas engine runs.
  const canvasOnly = createProfile({ win: fakeWindow() });
  assert.deepEqual([canvasOnly.engine, canvasOnly.capabilities()], ["canvas", WEB_CANVAS_CAPABILITIES]);
  // Neither engine: a remote.
  const remote = createProfile({ win: fakeWindow({ playable: false }) });
  assert.deepEqual([remote.engine, remote.canPlay, remote.capabilities()], [null, false, REMOTE_CAPABILITIES]);
  // The owner says the computer is the car: the canvas engine from now on.
  computer.setKind("car");
  assert.deepEqual([computer.name, computer.engine], ["car", "canvas"]);
});

test("a Tesla plays with the canvas engine whatever type the owner gave it", () => {
  // A car paired as a browser keeps the web layout, but never <video>:
  // Tesla can freeze it while the car moves.
  const car = createProfile({ win: fakeWindow({ tesla: true, video: "mse", stored: { [KIND_KEY]: "browser" } }) });
  assert.deepEqual([car.name, car.engine, car.capabilities()], ["web", "canvas", CAR_CANVAS_CAPABILITIES]);
});

test("the profile is <html data-profile> and follows what Yolo says this device is", () => {
  const win = fakeWindow({ tesla: true });
  const changes = [];
  const profile = createProfile({ win, onChange: (next, previous) => changes.push([previous, next]) });
  assert.deepEqual([profile.name, win.root.dataset.profile], ["car", "car"]);
  profile.setKind("browser");
  assert.deepEqual([profile.name, win.root.dataset.profile, win.items.get(KIND_KEY)], ["web", "web", "browser"]);
  profile.setKind("phone");
  assert.deepEqual(changes, [["car", "web"]], "phone and browser are both the web profile");
  // Remembered for the next visit, before Yolo says it again.
  assert.equal(createProfile({ win: fakeWindow({ tesla: true, stored: { [KIND_KEY]: "browser" } }) }).name, "web");
  profile.forget();
  assert.equal(win.items.has(KIND_KEY), false);
  assert.equal(createProfile({ win: fakeWindow({ playable: false }) }).capabilities(), REMOTE_CAPABILITIES);
});
