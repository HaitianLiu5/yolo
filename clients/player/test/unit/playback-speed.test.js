import assert from "node:assert/strict";
import test from "node:test";
import { browserNativeProbe, nativeVideoSupport } from "../../src/engine/native-support.js";
import { holdSpeed, MAX_SPEED, speedAt, speedFraction, speedLimits, stepSpeed } from "../../src/playback-speed.js";

// The speed panel's slider and keys, and how fast each engine plays
// (Agent Note 2026-10-12-two-playback-engines).

const steps = (max) => Array.from({ length: Math.round((max - 0.5) * 10) + 1 }, (_, index) => Math.round((0.5 + index / 10) * 10) / 10);

test("the slider gives 0.5× to 2× half of the web's track, stops on every 0.1 and lands on a preset within 0.05, and ends at the engine's fastest", () => {
  assert.ok(Math.abs(speedFraction(2, MAX_SPEED.native) - 0.5) < 1e-9);
  for (const max of [MAX_SPEED.native, MAX_SPEED.canvas]) {
    assert.deepEqual([speedFraction(0.5, max), speedFraction(max, max), speedAt(0, max), speedAt(1, max)], [0, 1, 0.5, max]);
    for (const speed of steps(max)) assert.equal(speedAt(speedFraction(speed, max), max), speed, `${speed}× on a track to ${max}×`);
  }
  const at = (speed) => speedAt(speedFraction(speed, 5), 5);
  assert.deepEqual([at(1.05), at(2.96), at(1.06), at(5.4)], [1, 3, 1.1, 5]);
});

test("keys step by quarters within the engine's range, a hold plays at 2× only below it, and Firefox's <video> says where its sound stops", () => {
  assert.deepEqual(
    [stepSpeed(1, 1, 5), stepSpeed(1.1, 1, 5), stepSpeed(1.1, -1, 5), stepSpeed(0.5, -1, 5), stepSpeed(4.9, 1, 5), stepSpeed(3, 1, 3)],
    [1.25, 1.25, 1, 0.5, 5, 3],
  );
  assert.deepEqual([holdSpeed(1.5), holdSpeed(2), holdSpeed(3)], [2, null, null]);

  const browser = (userAgent) => nativeVideoSupport(browserNativeProbe({
    navigator: { userAgent },
    MediaSource: { isTypeSupported: () => true },
    document: { createElement: () => ({ canPlayType: () => "" }) },
  }));
  const firefox = browser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0");
  const chrome = browser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36");
  assert.deepEqual(speedLimits("native", firefox), { max: 5, quietAbove: 4 });
  assert.deepEqual(speedLimits("native", chrome), { max: 5, quietAbove: null });
  assert.deepEqual(speedLimits("canvas", chrome), { max: 3, quietAbove: null }, "the car's engine");
});
