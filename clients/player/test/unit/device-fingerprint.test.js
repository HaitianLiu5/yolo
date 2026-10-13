import assert from "node:assert/strict";
import test from "node:test";
import { guessDevice, teslaFingerprint } from "../../src/device-fingerprint.js";

const CHROME_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

test("Tesla software 2026.26: a plain Chrome UA, recognized by its measurements", () => {
  // What Drive-In recorded in our car.
  const result = teslaFingerprint({
    userAgent: CHROME_LINUX, devicePixelRatio: 1.5299999713897705, innerWidth: 773, innerHeight: 601,
    screenWidth: 1254, screenHeight: 784, viewportScale: 1,
  });
  assert.deepEqual([result.tesla, result.by, result.score, result.maxScore], [true, "score", 14, 14]);
  assert.ok(result.signals.every((signal) => signal.matched));
  assert.deepEqual(guessDevice({ userAgent: CHROME_LINUX, devicePixelRatio: 1.53, innerWidth: 773, innerHeight: 601, screenWidth: 1254, screenHeight: 784 }),
    { name: "Tesla", kind: "car" });
});

test("older Tesla software says so in its user agent", () => {
  const result = teslaFingerprint({
    userAgent: "Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/79.0.3945.130 Chrome/79.0.3945.130 Safari/537.36 Tesla/2024.20.9-fa7b2e2c3c",
    devicePixelRatio: 1, innerWidth: 1180, innerHeight: 919, screenWidth: 1920, screenHeight: 1200, viewportScale: 1,
  });
  assert.deepEqual([result.tesla, result.by], [true, "user-agent"]);
  assert.ok(result.score < 9);
});

test("a 16:9 laptop at 150% scaling, or a Linux desktop with the car's user agent, is not a car", () => {
  const result = teslaFingerprint({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    devicePixelRatio: 1.5, innerWidth: 1280, innerHeight: 593, screenWidth: 1280, screenHeight: 720, viewportScale: 1,
  });
  assert.equal(result.tesla, false);
  assert.ok(result.score < 9, `score ${result.score}`);
  assert.deepEqual(result.signals.filter((signal) => !signal.matched).map((signal) => signal.id).sort(), ["innerWidth", "screenAspect", "widthRatio"]);
  const desktop = { userAgent: CHROME_LINUX, devicePixelRatio: 1, innerWidth: 1920, innerHeight: 960, screenWidth: 1920, screenHeight: 1080, viewportScale: 1 };
  assert.equal(teslaFingerprint(desktop).tesla, false);
  assert.deepEqual(guessDevice(desktop), { name: "Chrome on Linux", kind: "browser" });
});

test("other browsers name themselves by browser and system, and phones say so", () => {
  const guess = (userAgent, size = {}) => guessDevice({ userAgent, devicePixelRatio: 2, innerWidth: 1440, innerHeight: 900, screenWidth: 1440, screenHeight: 900, ...size });
  assert.deepEqual(guess("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"),
    { name: "Chrome on Mac", kind: "browser" });
  assert.deepEqual(guess("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15"),
    { name: "Safari on Mac", kind: "browser" });
  assert.deepEqual(guess("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0"),
    { name: "Edge on Windows", kind: "browser" });
  const phone = { devicePixelRatio: 3, innerWidth: 390, innerHeight: 844, screenWidth: 390, screenHeight: 844 };
  assert.deepEqual(guess("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1", phone),
    { name: "Safari on iPhone", kind: "phone" });
  assert.deepEqual(guess("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36", phone),
    { name: "Chrome on Android", kind: "phone" });
  assert.deepEqual(guess(""), { name: "Browser", kind: "browser" });
});
