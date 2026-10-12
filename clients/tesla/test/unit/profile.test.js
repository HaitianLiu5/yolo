import assert from "node:assert/strict";
import test from "node:test";
import { REMOTE_CAPABILITIES, TESLA_CANVAS_CAPABILITIES, WEB_CANVAS_CAPABILITIES } from "@useyolo/core";
import { canPlayHere, capabilitiesFor, createProfile, KIND_KEY, profileFor } from "../../src/profile.js";

const TESLA_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function fakeWindow({ tesla = false, stored = {}, playable = true } = {}) {
  const items = new Map(Object.entries(stored));
  const root = { dataset: {} };
  const engine = playable ? { crossOriginIsolated: true, SharedArrayBuffer, VideoDecoder: function () {}, AudioDecoder: function () {}, AudioWorkletNode: function () {} } : {};
  return {
    ...engine,
    devicePixelRatio: tesla ? 1.53 : 2,
    innerWidth: tesla ? 773 : 1440,
    innerHeight: tesla ? 601 : 900,
    screen: tesla ? { width: 1254, height: 784 } : { width: 1440, height: 900 },
    visualViewport: { scale: 1 },
    navigator: { userAgent: TESLA_UA },
    localStorage: { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)), removeItem: (key) => items.delete(key) },
    document: { documentElement: root },
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

test("each profile announces its capabilities, and a browser that cannot play is a remote", () => {
  assert.equal(capabilitiesFor("car", true), TESLA_CANVAS_CAPABILITIES);
  assert.equal(capabilitiesFor("web", true), WEB_CANVAS_CAPABILITIES);
  assert.equal(capabilitiesFor("web", false), REMOTE_CAPABILITIES);
  assert.equal(canPlayHere({}), false);
  assert.equal(canPlayHere(fakeWindow()), true);
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
