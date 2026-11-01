import assert from "node:assert/strict";
import test from "node:test";
import { CAR_CANVAS_CAPABILITIES } from "@useyolo/core";
import { teslaFingerprint } from "../../src/device-fingerprint.js";
import { createMode, KIND_KEY } from "../../src/mode.js";

// A Tesla plays with the canvas engine, whatever device type the owner chose:
// Tesla can freeze a native <video> while the car moves
// (Agent Note 2026-10-12-two-playback-engines).

const CHROME_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
// What the player recorded in a car on Tesla software 2026.26: a plain Chrome UA.
const TESLA = { devicePixelRatio: 1.5299999713897705, innerWidth: 773, innerHeight: 601, screen: { width: 1254, height: 784 } };
const LAPTOP = { devicePixelRatio: 2, innerWidth: 1440, innerHeight: 900, screen: { width: 1440, height: 900 } };

function fakeWindow(device, stored = {}) {
  const items = new Map(Object.entries(stored));
  return {
    ...device,
    crossOriginIsolated: true, SharedArrayBuffer, VideoDecoder: function () {}, AudioDecoder: function () {}, AudioWorkletNode: function () {},
    MediaSource: { isTypeSupported: () => true },
    visualViewport: { scale: 1 },
    navigator: { userAgent: CHROME_LINUX },
    localStorage: { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)), removeItem: (key) => items.delete(key) },
    document: { documentElement: { dataset: {} }, createElement: () => ({ canPlayType: (type) => (type.includes("mpegurl") ? "" : "probably") }) },
  };
}

test("the Tesla is recognized by its measurements when its user agent is plain Chrome", () => {
  const measured = (device) => teslaFingerprint({
    userAgent: CHROME_LINUX, devicePixelRatio: device.devicePixelRatio, innerWidth: device.innerWidth, innerHeight: device.innerHeight,
    screenWidth: device.screen.width, screenHeight: device.screen.height, viewportScale: 1,
  }).tesla;
  assert.deepEqual([measured(TESLA), measured(LAPTOP)], [true, false]);
});

test("a Tesla plays with the canvas engine whatever type the owner gave it; other browsers use <video>", () => {
  for (const kind of [undefined, "car", "browser", "phone"]) {
    const car = createMode({ win: fakeWindow(TESLA, kind ? { [KIND_KEY]: kind } : {}) });
    assert.deepEqual([car.engine, car.capabilities()], ["canvas", CAR_CANVAS_CAPABILITIES], String(kind));
  }
  const computer = createMode({ win: fakeWindow(LAPTOP) });
  assert.deepEqual([computer.name, computer.engine], ["web", "native"]);
  computer.setKind("car");
  assert.deepEqual([computer.name, computer.engine], ["car", "canvas"]);
});
