import assert from "node:assert/strict";
import test from "node:test";
import { livePosition, playTarget, transferTargets } from "../../src/play-target.js";

const car = { id: "dev_car", name: "Model Y", kind: "car", online: true, capabilities: { renderer: "canvas-webcodecs" } };
const mac = { id: "dev_mac", name: "Chrome on Mac", kind: "browser", online: true, capabilities: { renderer: "canvas-webcodecs" } };
const iphone = { id: "dev_iphone", name: "Safari on iPhone", kind: "phone", online: true, capabilities: { renderer: "remote" } };
const tv = { id: "dev_tv", name: "TV", kind: "tv", online: true, capabilities: { renderer: "canvas-webcodecs" } };
const playing = (deviceId, status = "playing") => ({ deviceId, status, item: { title: "A film" } });

test("the car plays a tap on itself, whatever plays elsewhere", () => {
  assert.deepEqual(playTarget({ profile: "car", canPlay: true, hub: playing("dev_mac"), devices: [car, mac], self: "dev_car" }), { here: true });
});

test("Yolo Web plays where playback is now, else in this browser", () => {
  // The car plays (or is paused): a tap on the computer plays there.
  assert.deepEqual(playTarget({ profile: "web", canPlay: true, hub: playing("dev_car"), devices: [car, mac], self: "dev_mac" }), { deviceId: "dev_car" });
  assert.deepEqual(playTarget({ profile: "web", canPlay: true, hub: playing("dev_car", "paused"), devices: [car, mac], self: "dev_mac" }), { deviceId: "dev_car" });
  // Nothing plays, or the device that played went offline: here.
  assert.deepEqual(playTarget({ profile: "web", canPlay: true, hub: { deviceId: "dev_car", status: "idle", item: null }, devices: [car, mac], self: "dev_mac" }), { here: true });
  assert.deepEqual(playTarget({ profile: "web", canPlay: true, hub: playing("dev_car"), devices: [{ ...car, online: false }, mac], self: "dev_mac" }), { here: true });
  // This browser already plays: here.
  assert.deepEqual(playTarget({ profile: "web", canPlay: true, hub: playing("dev_mac"), devices: [car, mac], self: "dev_mac" }), { here: true });
});

test("a browser that cannot play sends a tap to the last screen, the only one online, or lets the owner pick", () => {
  assert.deepEqual(playTarget({ profile: "web", canPlay: false, hub: { deviceId: "dev_car", status: "idle" }, devices: [car, iphone], self: "dev_iphone" }), { deviceId: "dev_car" });
  assert.deepEqual(playTarget({ profile: "web", canPlay: false, hub: null, devices: [mac, iphone], self: "dev_iphone" }), { deviceId: "dev_mac" });
  assert.deepEqual(playTarget({ profile: "web", canPlay: false, hub: null, devices: [car, mac, iphone], self: "dev_iphone" }), { choose: [car, mac] });
  assert.deepEqual(playTarget({ profile: "web", canPlay: false, hub: null, devices: [iphone], self: "dev_iphone" }), { choose: [] });
});

test("playback moves to online screens that play, this one first", () => {
  assert.deepEqual(transferTargets({ devices: [car, mac, iphone, { ...tv, online: false }], self: "dev_mac", canPlay: true }).map((device) => device.id), ["dev_mac", "dev_car"]);
  assert.deepEqual(transferTargets({ devices: [car, mac, iphone], self: "dev_iphone", canPlay: false }).map((device) => device.id), ["dev_car", "dev_mac"]);
});

test("the bar's position runs on from the Hub's last report while playing", () => {
  const hub = { status: "playing", position: 100, positionAt: 1_000_000, item: { duration: 110 } };
  assert.equal(livePosition(hub, 1_005_000), 105);
  assert.equal(livePosition(hub, 1_060_000), 110, "never past the end");
  assert.equal(livePosition({ ...hub, status: "paused" }, 1_060_000), 100);
});
