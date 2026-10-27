import assert from "node:assert/strict";
import test from "node:test";
import { guessDevice } from "../../src/device-fingerprint.js";

// What a browser suggests for itself when it pairs; a smart TV's own engine
// names Safari and Linux too, so it is recognized first.

const guess = (userAgent) => guessDevice({ userAgent, devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080, screenWidth: 1920, screenHeight: 1080, viewportScale: 1 });

test("a Samsung TV's Tizen engine pairs as a TV", () => {
  const tizen = "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36";
  assert.deepEqual(guess(tizen), { name: "Samsung TV", kind: "tv" });
});

test("an LG TV's webOS engine pairs as a TV", () => {
  const webos = "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager";
  assert.deepEqual(guess(webos), { name: "LG TV", kind: "tv" });
});

test("computers and phones keep their browser and system names", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  assert.deepEqual([guess(mac), guess(iphone)], [{ name: "Chrome on Mac", kind: "browser" }, { name: "Safari on iPhone", kind: "phone" }]);
});
