import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestControlPlane, onlineScreen, USER } from "../helpers/setup.js";
import { upsertDevice } from "../../src/store/devices.js";
import { addQueueItems, listQueue } from "../../src/store/queue.js";
import { listHistory } from "../../src/store/history.js";

const movie = { plugin: "library", id: "42" };

test("play defaults to the only online device and records history", async () => {
  const plane = createTestControlPlane();
  const car = await onlineScreen(plane);
  const { state, device } = await plane.hub.play({ source: movie });
  assert.equal(device.id, car.id);
  assert.equal(state.status, "loading");
  assert.equal(state.item.title, "Movie 42");
  const prepare = plane.node.calls.find((call) => call.path === "/internal/v1/prepare");
  assert.deepEqual(prepare.body.tracks.preferences, { saved: null, fallback: null });
  assert.equal((await listHistory(plane.db, USER))[0].sourceKey, "library:42");
  assert.equal(plane.transport.broadcasts.at(-1).type, "state");
});

test("play fails with device_offline when nothing can play, and with node_offline when the node is down too", async () => {
  const plane = createTestControlPlane();
  await assert.rejects(plane.hub.play({ source: movie }), { code: "device_offline" });
  plane.node.offline = true;
  await assert.rejects(plane.hub.play({ source: movie }), { code: "node_offline" });
});

test("play fails with node_offline when the node is down", async () => {
  const plane = createTestControlPlane();
  const device = await upsertDevice(plane.db, USER, { name: "Phone", kind: "phone", capabilities: {} });
  plane.transport.online.add(device.id);
  plane.node.offline = true;
  await assert.rejects(plane.hub.play({ source: movie }), { code: "node_offline" });
});

test("realtime devices receive load, then commands; position extrapolates", async () => {
  const plane = createTestControlPlane();
  const car = await upsertDevice(plane.db, USER, { name: "Model Y", kind: "car", capabilities: { renderer: "canvas-webcodecs" } });
  plane.transport.online.add(car.id);

  await plane.hub.play({ source: movie, device: "model y", startTime: 30 });
  const load = plane.transport.sent.at(-1);
  assert.equal(load.deviceId, car.id);
  assert.equal(load.message.type, "load");
  assert.equal(load.message.startTime, 30);

  await plane.hub.deviceMessage(car.id, { type: "report", status: "playing", position: 31, duration: 600 });
  plane.advance(10_000);
  assert.equal((await plane.hub.getState()).position, 41);

  await plane.hub.control("pause");
  assert.equal(plane.transport.sent.at(-1).message.type, "pause");
  assert.equal((await plane.hub.state()).status, "paused");
  await plane.hub.seek(100);
  assert.deepEqual(
    { type: plane.transport.sent.at(-1).message.type, position: plane.transport.sent.at(-1).message.position },
    { type: "seek", position: 100 },
  );
});

test("next plays the queue head; ended advances; empty queue goes idle", async () => {
  const plane = createTestControlPlane();
  const car = await upsertDevice(plane.db, USER, { name: "Car", kind: "car", capabilities: {} });
  plane.transport.online.add(car.id);
  await addQueueItems(plane.db, USER, [
    { source: { plugin: "library", id: "1" }, title: "One" },
    { source: { plugin: "library", id: "2" }, title: "Two" },
  ]);
  await plane.hub.control("next");
  let state = await plane.hub.state();
  assert.equal(state.item.source.id, "1");

  await plane.hub.deviceMessage(car.id, { type: "ended", sessionId: state.sessionId });
  state = await plane.hub.state();
  assert.equal(state.item.source.id, "2");
  assert.equal((await listQueue(plane.db, USER)).length, 0);

  await plane.hub.deviceMessage(car.id, { type: "ended", sessionId: state.sessionId });
  assert.equal((await plane.hub.state()).status, "idle");
});

test("a failed advance puts the item back at the head", async () => {
  const plane = createTestControlPlane();
  await onlineScreen(plane);
  await addQueueItems(plane.db, USER, [{ source: movie, title: "Movie" }]);
  plane.node.routes["POST /internal/v1/prepare"] = () => {
    throw Object.assign(new Error("The source could not resolve it"), { code: "resolve_failed" });
  };
  await assert.rejects(plane.hub.control("next"), { code: "resolve_failed" });
  assert.equal((await listQueue(plane.db, USER))[0].title, "Movie");
});

test("previous plays the most recent other history entry", async () => {
  const plane = createTestControlPlane();
  await onlineScreen(plane);
  await plane.hub.play({ source: { plugin: "library", id: "1" } });
  plane.advance(1_000);
  await plane.hub.play({ source: { plugin: "library", id: "2" } });
  plane.advance(1_000);
  await plane.hub.control("previous");
  assert.equal((await plane.hub.state()).item.source.id, "1");
});

test("transfer continues on the new device and deactivates the old one", async () => {
  const plane = createTestControlPlane();
  const car = await upsertDevice(plane.db, USER, { name: "Car", kind: "car", capabilities: {} });
  const tv = await upsertDevice(plane.db, USER, { name: "Living room", kind: "tv", capabilities: {} });
  plane.transport.online.add(car.id);
  await plane.hub.play({ source: movie, device: car.id, startTime: 10 });
  await plane.hub.deviceMessage(car.id, { type: "report", status: "playing", position: 10 });
  plane.transport.online.add(tv.id);
  plane.advance(5_000);

  await plane.hub.transfer("living room");
  const messages = plane.transport.sent.slice(-2);
  assert.deepEqual(messages.map(({ deviceId, message }) => [deviceId, message.type]), [[car.id, "deactivate"], [tv.id, "load"]]);
  assert.equal(messages[1].message.reason, "transfer");
  assert.equal(messages[1].message.startTime, 15);
});

test("several online devices without an active one require a choice", async () => {
  const plane = createTestControlPlane();
  await onlineScreen(plane);
  await onlineScreen(plane, { name: "Phone", kind: "phone" });
  await assert.rejects(plane.hub.play({ source: movie }), /Several devices/);
});

test("a remote (Yolo Web that cannot play) is never picked, named, or handed playback", async () => {
  const plane = createTestControlPlane();
  const car = await upsertDevice(plane.db, USER, { name: "Model Y", kind: "car", capabilities: { renderer: "canvas-webcodecs" } });
  const phone = await upsertDevice(plane.db, USER, { name: "iPhone", kind: "phone", capabilities: { renderer: "remote" } });
  plane.transport.online.add(car.id);
  plane.transport.online.add(phone.id);
  // Two devices online, one of them a remote: the car is the only one that plays.
  const { device } = await plane.hub.play({ source: movie });
  assert.equal(device.id, car.id);
  await assert.rejects(plane.hub.play({ source: movie, device: phone.id }), { code: "invalid_request", message: /iPhone is a remote/ });
  await assert.rejects(plane.hub.transfer(phone.id), { code: "invalid_request" });
  assert.equal((await plane.hub.state()).deviceId, car.id);
});

test("set_tracks saves preferences that the next play passes to the node", async () => {
  const plane = createTestControlPlane();
  await onlineScreen(plane);
  plane.node.routes["POST /internal/v1/sessions/*/tracks"] = () => ({
    tracks: { subtitles: [{ id: "library:7", kind: "subtitle", language: "zh", name: "简体", format: "text" }], audio: [] },
  });
  await plane.hub.play({ source: movie });
  await plane.hub.setTracks({ subtitles: ["library:7"] });
  assert.deepEqual((await plane.hub.state()).tracks.subtitles, ["library:7"]);

  await plane.hub.play({ source: { plugin: "library", id: "43" } });
  const prepare = plane.node.calls.filter((call) => call.path === "/internal/v1/prepare").at(-1);
  assert.equal(prepare.body.tracks.preferences.saved, null, "another source has no saved choice of its own");
  assert.equal(prepare.body.tracks.preferences.fallback.subtitles[0].language, "zh");
});

test("hello registers a device and returns the welcome payload", async () => {
  const plane = createTestControlPlane();
  const { device, welcome } = await plane.hub.hello({ name: "Model Y", kind: "car", capabilities: { renderer: "canvas-webcodecs", maxHeight: 720 } });
  assert.match(device.id, /^dev_/);
  assert.equal(welcome.type, "welcome");
  assert.equal(welcome.deviceId, device.id);
  assert.deepEqual(welcome.queue, []);
  const again = await plane.hub.hello({ deviceId: device.id, name: "Model Y", kind: "car" });
  assert.equal(again.device.id, device.id);
  // The LAN origin is in media.paths only: `lan`, its place for players from before 0.5, is gone.
  const lan = { path: "lan", origin: "https://yolo-lan-1.example.com:9443", notAfter: Infinity };
  plane.hub.media = async () => ({ paths: [lan], relayMode: "auto" });
  const listed = (await plane.hub.hello({ deviceId: device.id, name: "Model Y", kind: "car" })).welcome;
  assert.deepEqual([listed.media.paths, "lan" in listed], [[lan], false]);
});

// --- Realtime devices (the player) -------------------------------------------

const TESLA = { renderer: "canvas-webcodecs", delivery: ["hls", "mp4"], video: ["avc1"], audio: ["mp4a"], maxHeight: 720, subtitles: "client-vtt" };

async function carPlane() {
  const plane = createTestControlPlane();
  const car = await upsertDevice(plane.db, USER, { name: "Model Y", kind: "car", capabilities: TESLA });
  plane.transport.online.add(car.id);
  const prepares = () => plane.node.calls.filter((call) => call.path === "/internal/v1/prepare").map((call) => call.body);
  return { plane, car, prepares };
}

test("a realtime device gets a stream prepared for its capabilities and viewport", async () => {
  const { plane, car, prepares } = await carPlane();
  await plane.hub.deviceMessage(car.id, { type: "report", status: "idle", position: 0, viewport: { width: 1280, height: 720, devicePixelRatio: 1 } });
  await plane.hub.play({ source: movie, autoplay: false });
  const body = prepares().at(-1);
  assert.equal(body.capabilities.renderer, "canvas-webcodecs");
  assert.equal(body.capabilities.maxHeight, 720);
  assert.deepEqual(body.viewport, { width: 1280, height: 720, devicePixelRatio: 1 });
  const load = plane.transport.sent.at(-1).message;
  assert.deepEqual([load.type, load.autoplay, load.reason, load.stream.sessionId], ["load", false, "play", body.sessionId]);
  assert.equal((await plane.hub.state()).status, "loading");
});

test("warm asks the node to resolve a device's first few items ahead, with the path and cap its plays get", async () => {
  const { plane, car } = await carPlane();
  await plane.hub.deviceMessage(car.id, { type: "network", path: "wan", probes: { wan: "ok" } });
  await plane.hub.play({ source: movie, requester: car.id, maxVideoKbps: 1500 });
  const sources = [1, 2, 3, 4].map((n) => ({ plugin: "web", id: `v${n}` }));
  assert.deepEqual(await plane.hub.warm({ sources, requester: car.id }), { warming: 3 });
  const warm = plane.node.calls.filter((call) => call.path === "/internal/v1/warm").at(-1).body;
  assert.deepEqual(warm.sources.map((source) => source.id), ["v1", "v2", "v3"]);
  assert.equal(warm.capabilities.maxHeight, 720);
  assert.equal(warm.network, "wan");
  assert.deepEqual(warm.limits, { maxVideoKbps: 1500 });
  // Only a device that plays warms, for itself: never an agent.
  const before = plane.node.calls.length;
  assert.deepEqual(await plane.hub.warm({ sources }), { warming: 0 });
  assert.equal(plane.node.calls.length, before);
});

test("resume uses Yolo's history, else lets the source decide; finished items start over", async () => {
  const { plane, car, prepares } = await carPlane();
  await plane.hub.play({ source: movie });
  assert.equal(prepares().at(-1).startTime, null, "no Yolo position: the source resumes at its own position");
  const { sessionId } = await plane.hub.state();
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "playing", position: 200, duration: 600 });
  await plane.hub.play({ source: { plugin: "library", id: "2" } });
  await plane.hub.play({ source: movie });
  assert.equal(prepares().at(-1).startTime, 200);
  plane.db.raw.prepare("UPDATE history SET position = 595 WHERE source_key = 'library:42'").run();
  await plane.hub.play({ source: movie });
  assert.equal(prepares().at(-1).startTime, 0);
  await plane.hub.play({ source: movie, startTime: 33 });
  assert.equal(prepares().at(-1).startTime, 33);
});

test("reports move the state and save progress; idle stops the session and keeps the item paused", async () => {
  const { plane, car } = await carPlane();
  await plane.hub.play({ source: movie });
  const { sessionId } = await plane.hub.state();
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "playing", position: 10, duration: 600 });
  // A report about a replaced stream is ignored.
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId: "ses_old", status: "paused", position: 999 });
  assert.equal((await plane.hub.state()).status, "playing");
  plane.advance(31_000);
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "playing", position: 41, duration: 600 });
  assert.equal((await listHistory(plane.db, USER))[0].position, 41);
  assert.ok(plane.node.calls.some((call) => call.path === `/internal/v1/sessions/${sessionId}/progress` && call.body.position === 41));

  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "idle", position: 55 });
  const state = await plane.hub.state();
  assert.deepEqual([state.status, state.sessionId, state.deviceId, state.position, state.item.source], ["paused", sessionId, car.id, 55, movie]);
  assert.ok(state.leftAt, "marked as left with Back");
  assert.equal((await listHistory(plane.db, USER))[0].position, 55);
  assert.ok(plane.node.calls.some((call) => call.path === `/internal/v1/sessions/${sessionId}/stop`));
});

test("idle from a screen that keeps its player leaves the node's session running until the screen lets it go", async () => {
  const { plane, car } = await carPlane();
  await plane.hub.play({ source: movie });
  const { sessionId } = await plane.hub.state();
  const stops = () => plane.node.calls.filter((call) => call.path === `/internal/v1/sessions/${sessionId}/stop`).length;
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "playing", position: 10, duration: 600 });

  // Back, with the player kept behind the home screen: paused here, marked
  // left and kept, and the node's session goes on.
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "idle", keep: true, position: 55 });
  let state = await plane.hub.state();
  assert.deepEqual([state.status, state.sessionId, state.position, state.kept], ["paused", sessionId, 55, true]);
  const leftAt = state.leftAt;
  assert.ok(leftAt, "marked as left with Back");
  assert.equal((await listHistory(plane.db, USER))[0].position, 55);
  assert.equal(stops(), 0, "the session stays for the kept player");

  // A pause keeps both marks; the screen saying so again keeps the first leftAt.
  await plane.hub.control("pause");
  plane.advance(5_000);
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "idle", keep: true, position: 55 });
  state = await plane.hub.state();
  assert.deepEqual([state.kept, state.leftAt], [true, leftAt]);

  // Shown again: the player's own report clears both, on the same session.
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "playing", position: 55.2, duration: 600 });
  state = await plane.hub.state();
  assert.deepEqual([state.status, state.sessionId, state.kept, state.leftAt], ["playing", sessionId, undefined, undefined]);

  // Kept again, then let go (the page went away): now the session stops.
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "idle", keep: true, position: 70 });
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "idle", position: 70 });
  state = await plane.hub.state();
  assert.deepEqual([state.status, state.kept, Boolean(state.leftAt)], ["paused", undefined, true]);
  assert.equal(stops(), 1);

  // An agent's resume of a kept item clears the marks too.
  await plane.hub.play({ source: movie });
  const next = (await plane.hub.state()).sessionId;
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId: next, status: "idle", keep: true, position: 12 });
  await plane.hub.control("resume");
  state = await plane.hub.state();
  assert.deepEqual([state.status, state.kept, state.leftAt], ["playing", undefined, undefined]);
});

test("a device's rebuild of a session that was replaced is superseded", async () => {
  const { plane, car } = await carPlane();
  await plane.hub.play({ source: movie });
  const first = (await plane.hub.state()).sessionId;
  await plane.hub.play({ source: { plugin: "library", id: "2" } });
  await assert.rejects(plane.hub.play({ source: movie, device: car.id, startTime: 50, reason: "recovery", replaces: first }), { code: "superseded" });
  const current = (await plane.hub.state()).sessionId;
  const { state } = await plane.hub.play({ source: { plugin: "library", id: "2" }, device: car.id, startTime: 50, reason: "seek", replaces: current, autoplay: false });
  assert.equal(state.position, 50);
  assert.equal(plane.transport.sent.at(-1).message.reason, "seek");
  assert.equal((await listHistory(plane.db, USER)).find((entry) => entry.sourceKey === "library:2").playCount, 1, "a seek is not another play");
});

test("a paired connection is its own device; a removed device is refused and stopped", async () => {
  const { plane, car } = await carPlane();
  const { device } = await plane.hub.hello({ deviceId: "dev_someone_else", name: "Browser", kind: "browser", capabilities: TESLA }, { boundDeviceId: car.id });
  assert.equal(device.id, car.id);
  assert.deepEqual([device.name, device.kind], ["Model Y", "car"], "the owner's name and type for it stay");
  await assert.rejects(plane.hub.hello({ name: "Ghost" }, { boundDeviceId: "dev_removed" }), { code: "unauthorized" });

  await plane.hub.play({ source: movie });
  await plane.hub.forgetDevice(car.id);
  assert.deepEqual(plane.transport.closed, [{ deviceId: car.id, code: 4003, reason: "revoked" }]);
  assert.equal((await plane.hub.state()).status, "idle");
});

// --- A device that wakes up (Agent Note 2026-10-11-wake-request-ordering) ---

test("a device's own play waits only briefly for its hello, then is device_offline", async () => {
  const plane = createTestControlPlane({ helloWaitMs: 30 });
  const car = await upsertDevice(plane.db, USER, { name: "Model Y", kind: "car", capabilities: TESLA });
  const startedAt = Date.now();
  await assert.rejects(plane.hub.play({ source: movie, device: car.id, requester: car.id }), { code: "device_offline" });
  assert.ok(Date.now() - startedAt >= 25, "it waited for the hello");
  assert.deepEqual(plane.logs.filter((record) => record.event === "hello_wait").map((record) => record.outcome), ["timeout"]);
  const decision = plane.logs.find((record) => record.event === "decision");
  assert.deepEqual([decision.kind, decision.decision, decision.deviceId], ["hub", "device_offline", car.id]);
});

test("only a device playing on itself waits; agents and other devices get device_offline at once", async () => {
  const plane = createTestControlPlane({ helloWaitMs: 10_000 });
  const car = await upsertDevice(plane.db, USER, { name: "Model Y", kind: "car", capabilities: TESLA });
  const phone = await upsertDevice(plane.db, USER, { name: "Phone", kind: "phone", capabilities: {} });
  plane.transport.hello(phone.id);
  const startedAt = Date.now();
  await assert.rejects(plane.hub.play({ source: movie, device: car.id }), { code: "device_offline" });
  await assert.rejects(plane.hub.play({ source: movie, device: car.id, requester: phone.id }), { code: "device_offline" });
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(plane.transport.waiters.size, 0);
});

test("a device that was playing waits for its hello when it names no device", async () => {
  const { plane, car } = await carPlane();
  await plane.hub.play({ source: movie, startTime: 30 });
  const { sessionId } = await plane.hub.state();
  plane.transport.online.delete(car.id);
  await plane.hub.deviceDisconnected(car.id);
  const recovery = plane.hub.play({ source: movie, startTime: 30, reason: "recovery", replaces: sessionId, requester: car.id });
  setTimeout(() => plane.transport.hello(car.id), 20);
  const { state, device } = await recovery;
  assert.deepEqual([device.id, state.position, state.status], [car.id, 30, "loading"]);
});

test("the Hub logs state changes once, not every report", async () => {
  const { plane, car } = await carPlane();
  await plane.hub.play({ source: movie });
  const { sessionId } = await plane.hub.state();
  for (const position of [1, 6, 11]) {
    await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "playing", position, duration: 600 });
  }
  await plane.hub.deviceDisconnected(car.id);
  const states = plane.logs.filter((record) => record.event === "state");
  assert.deepEqual(states.map((record) => [record.cause, record.status]), [["play:play", "loading"], ["report", "playing"], ["disconnect", "paused"]]);
  assert.equal(states.at(-1).interrupted, true);
  assert.equal(states.at(-1).sessionId, sessionId);
});

test("a device's error is logged without its media token or ticket", async () => {
  const { plane, car } = await carPlane();
  await plane.hub.play({ source: movie });
  const { sessionId } = await plane.hub.state();
  await plane.hub.deviceMessage(car.id, {
    type: "error", sessionId, code: "HLS_SEGMENT_FETCH_FAILED",
    message: "GET https://yolo.example/m/sess.usr.123.c2lnbmF0dXJl/f/2 failed; wss://yolo.example/v1/realtime?ticket=t1ck3t",
  });
  const logged = plane.logs.find((record) => record.event === "device_error");
  assert.equal(logged.message, "GET https://yolo.example/m/<redacted>/f/2 failed; wss://yolo.example/v1/realtime?ticket=<redacted>");
});

// Owner decision 2026-10-12: a device that was playing when its connection
// dropped plays on when it comes back, however long it slept; one the owner
// paused stays paused. The Hub only marks which was which.
test("losing the active device pauses at its position, marked interrupted until the owner pauses", async () => {
  const { plane, car } = await carPlane();
  await plane.hub.play({ source: movie });
  const { sessionId } = await plane.hub.state();
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "playing", position: 40, duration: 600 });
  plane.advance(20_000);
  plane.transport.online.delete(car.id);
  await plane.hub.deviceDisconnected(car.id);
  const interrupted = await plane.hub.state();
  assert.deepEqual([interrupted.status, interrupted.position], ["paused", 60]);
  assert.equal((await listHistory(plane.db, USER))[0].position, 60);
  assert.ok(interrupted.interruptedAt > 0);

  // Back online: the owner pauses on purpose, then the car sleeps again.
  plane.transport.online.add(car.id);
  await plane.hub.control("pause");
  assert.equal((await plane.hub.state()).interruptedAt, undefined);
  plane.transport.online.delete(car.id);
  await plane.hub.deviceDisconnected(car.id);
  const paused = await plane.hub.state();
  assert.deepEqual([paused.status, paused.interruptedAt], ["paused", undefined]);
});

// Adaptive quality (Agent Note 2026-10-11-adaptive-quality): the device's own
// request sets its cap, which the Hub keeps for what that device plays next,
// for a while.
test("a device's quality cap reaches the node and carries over to its next item", async () => {
  const { plane, car, prepares } = await carPlane();
  await plane.hub.play({ source: movie });
  assert.equal(prepares().at(-1).limits, null, "no cap until the device asks");
  const { sessionId } = await plane.hub.state();
  await plane.hub.play({ source: movie, startTime: 60, reason: "quality", replaces: sessionId, requester: car.id, maxVideoKbps: 1000 });
  assert.deepEqual(prepares().at(-1).limits, { maxVideoKbps: 1000 });
  // An agent plays something else on the car: same connection, same cap.
  await plane.hub.play({ source: { plugin: "library", id: "43" } });
  assert.deepEqual(prepares().at(-1).limits, { maxVideoKbps: 1000 });
  // Agents cannot set it for the device; the device lifts it with null.
  await plane.hub.play({ source: movie, maxVideoKbps: 400 });
  assert.deepEqual(prepares().at(-1).limits, { maxVideoKbps: 400 }, "this one prepare");
  await plane.hub.play({ source: movie });
  assert.deepEqual(prepares().at(-1).limits, { maxVideoKbps: 1000 });
  const current = (await plane.hub.state()).sessionId;
  await plane.hub.play({ source: movie, reason: "quality", replaces: current, requester: car.id, maxVideoKbps: null });
  assert.equal(prepares().at(-1).limits, null);
  await plane.hub.play({ source: movie });
  assert.equal(prepares().at(-1).limits, null);
});

test("a remembered quality cap expires", async () => {
  const { plane, car, prepares } = await carPlane();
  let clock = 1_000_000;
  plane.hub.now = () => clock;
  await plane.hub.play({ source: movie, requester: car.id, maxVideoKbps: 700 });
  clock += 31 * 60_000;
  await plane.hub.play({ source: movie });
  assert.equal(prepares().at(-1).limits, null);
});

// LAN direct play (Agent Note 2026-10-12-lan-direct-play): the device's probe
// report, or its own request, decides the path the node prepares; the
// recovery after a LAN failure asks for the next path at the same position.
test("a device's path decides what the node prepares, a recovery moves down the paths, and with the relay off no path is refused", async () => {
  const { plane, car, prepares } = await carPlane();
  // The node serves the path asked for while its listener does.
  let serving = new Set(["lan", "wan"]);
  plane.node.routes["POST /internal/v1/prepare"] = (body) => ({
    sessionId: body.sessionId, delivery: { type: "hls", url: "/m/t/p/0.m3u8" }, title: "Film", duration: 600, startTime: body.startTime,
    network: serving.has(body.network) ? body.network : "relay", tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
  });
  let media = { paths: [], relayMode: "on" };
  plane.hub.media = async () => media;

  await plane.hub.play({ source: movie });
  assert.equal(prepares().at(-1).network, "relay", "a device that never said is on the relay");
  await plane.hub.deviceMessage(car.id, { type: "network", path: "wan", reason: "probe", probes: { lan: "timeout", wan: "ok" } });
  await plane.hub.play({ source: movie, startTime: 10 });
  assert.equal(prepares().at(-1).network, "wan");
  await plane.hub.deviceMessage(car.id, { type: "network", path: "lan", reason: "probe", probes: { lan: "ok", wan: "ok" } });
  await plane.hub.play({ source: movie, startTime: 20 });
  assert.equal(prepares().at(-1).network, "lan");
  // The device's own recovery names the next path.
  const { sessionId } = await plane.hub.state();
  await plane.hub.play({ source: movie, startTime: 42, reason: "recovery", replaces: sessionId, requester: car.id, network: "relay" });
  assert.deepEqual([prepares().at(-1).network, prepares().at(-1).startTime], ["relay", 42]);
  // The names of a player from before 0.5 name no path: a report with only
  // `lan`, a request for "tunnel", and the `lan` an old Hub stored.
  await plane.hub.deviceMessage(car.id, { type: "network", lan: true });
  assert.equal((await plane.hub.devicePath(car, {})).path, "none");
  await plane.hub.deviceMessage(car.id, { type: "network", path: "lan" });
  await plane.hub.play({ source: movie, startTime: 50, requester: car.id, network: "tunnel" });
  assert.equal(prepares().at(-1).network, "relay", "no path known, and the relay on: the relay");
  assert.equal((await plane.hub.devicePath(car, {})).path, "none");
  plane.storage.map.set(`network:${car.id}`, { lan: true, at: 1 });
  assert.equal((await plane.hub.devicePath(car, {})).path, "relay");
  // Others cannot move the device to another path; its next probe can.
  await plane.hub.play({ source: movie, network: "lan" });
  assert.equal(prepares().at(-1).network, "relay");

  // The relay off: a device on it, or with no path, is refused before the
  // node works, with what each path needs.
  media = { paths: [{ path: "lan", origin: "https://yolo-lan-1.example.com:9443", notAfter: Infinity }], relayMode: "off" };
  const before = prepares().length;
  await assert.rejects(plane.hub.play({ source: movie }), { code: "media_unreachable" });
  await plane.hub.deviceMessage(car.id, { type: "network", path: null, reason: "probe", probes: { lan: "timeout" } });
  await assert.rejects(plane.hub.play({ source: movie }), (error) => error.code === "media_unreachable"
    && /home network: no answer/.test(error.message) && /remote direct play: not set up/.test(error.message) && /relay is off/.test(error.message));
  assert.equal(prepares().length, before);
  // A listener that stopped serving falls to the relay on the node, which is off.
  await plane.hub.deviceMessage(car.id, { type: "network", path: "wan", reason: "probe", probes: { wan: "ok" } });
  serving = new Set(["lan"]);
  await assert.rejects(plane.hub.play({ source: movie }), { code: "media_unreachable" });
  assert.ok(plane.node.calls.some((call) => call.path.endsWith("/stop") && call.path.includes(prepares().at(-1).sessionId)), "the unusable session is stopped");
  assert.deepEqual(plane.logs.filter((record) => record.event === "stream").map((record) => [record.asked, record.network]),
    [["relay", "relay"], ["wan", "wan"], ["lan", "lan"], ["relay", "relay"], ["relay", "relay"], ["relay", "relay"], ["wan", "relay"]]);
});

// The relay's modes (Agent Note 2026-10-13-media-off-the-worker): automatic,
// the default, takes the relay only when no direct path works for the
// screen, when a stream starts and when one fails in the middle; off
// refuses with the reason and what fixes it.
test("automatic takes the relay only when no direct path works, at the start and in a recovery, and off refuses with the fix", async () => {
  const { plane, car, prepares } = await carPlane();
  let serving = new Set(["wan"]);
  plane.node.routes["POST /internal/v1/prepare"] = (body) => ({
    sessionId: body.sessionId, delivery: { type: "hls", url: "/m/t/p/0.m3u8" }, title: "Film", duration: 600, startTime: body.startTime,
    network: serving.has(body.network) ? body.network : "relay", tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
  });
  const wan = { path: "wan", origin: "https://yolo-wan-1.example.com:9444", notAfter: Infinity };
  let media = { paths: [wan], relayMode: "auto" };
  plane.hub.media = async () => media;

  // A direct path that works is the one the stream takes.
  await plane.hub.deviceMessage(car.id, { type: "network", path: "wan", reason: "probe", probes: { wan: "ok" } });
  await plane.hub.play({ source: movie, startTime: 10 });
  assert.equal(prepares().at(-1).network, "wan");
  // In the middle of the stream the remote path fails: the recovery comes by the relay at the same position.
  const { sessionId } = await plane.hub.state();
  await plane.hub.play({ source: movie, startTime: 42, reason: "recovery", replaces: sessionId, requester: car.id, network: "relay" });
  assert.deepEqual([prepares().at(-1).network, prepares().at(-1).startTime], ["relay", 42]);
  assert.equal((await plane.hub.state()).status, "loading");
  // No direct path at all: the relay.
  await plane.hub.deviceMessage(car.id, { type: "network", path: "relay", reason: "probe", probes: { wan: "timeout" } });
  await plane.hub.play({ source: movie, startTime: 50 });
  assert.equal(prepares().at(-1).network, "relay");
  // A screen whose last report found no path, from a welcome before the relay was allowed, gets the relay too.
  await plane.hub.deviceMessage(car.id, { type: "network", path: null, reason: "probe", probes: { wan: "timeout" } });
  await plane.hub.play({ source: movie, startTime: 60 });
  assert.equal(prepares().at(-1).network, "relay");
  // The remote listener stopped serving: the node's relay, which automatic allows.
  await plane.hub.deviceMessage(car.id, { type: "network", path: "wan", reason: "probe", probes: { wan: "ok" } });
  serving = new Set();
  await plane.hub.play({ source: movie, startTime: 70 });
  assert.deepEqual(plane.logs.filter((record) => record.event === "stream").at(-1).network, "relay");

  // Off, with no direct path: refused before the node works, with the
  // reason and each fix: the relay, and the router port.
  media = {
    paths: [wan], relayMode: "off", remote: { on: true, status: "unreachable" },
    forward: { port: 9444, internalPort: 9444, address: "192.168.1.20", gateway: "192.168.1.1" },
  };
  await plane.hub.deviceMessage(car.id, { type: "network", path: null, reason: "probe", probes: { wan: "timeout" } });
  const before = prepares().length;
  await assert.rejects(plane.hub.play({ source: movie }), (error) => {
    assert.equal(error.code, "media_unreachable");
    assert.match(error.message, /remote direct play: no answer/);
    assert.match(error.message, /relay is off/);
    assert.deepEqual(error.details.fixes.map((fix) => fix.action), ["relay", "forward"]);
    const forward = error.details.fixes.find((fix) => fix.action === "forward");
    assert.deepEqual([forward.port, forward.address, forward.gateway], [9444, "192.168.1.20", "192.168.1.1"]);
    assert.match(forward.text, /TCP port 9444/);
    assert.match(forward.text, /192\.168\.1\.20/);
    assert.match(forward.text, /UPnP/);
    return true;
  });
  assert.equal(prepares().length, before, "the node did no work");
  // Remote access never turned on: the fix says so.
  media = { paths: [], relayMode: "off", remote: { on: false, status: "off" } };
  await assert.rejects(plane.hub.play({ source: movie }), (error) => error.details.fixes.map((fix) => fix.action).join() === "relay,remote");
});

// The Hub sends a `load` once, over the connections the device has then.
// A screen that reconnects compares the welcome's state with the stream it
// plays, so the state must name a stream as soon as its `load` went out,
// and a `load` sent while a new connection's hello is answered must reach
// that connection or be named by its welcome.
const settle = () => new Promise((done) => setImmediate(done));
async function until(check, label) {
  for (let turn = 0; turn < 1_000; turn += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`Never happened: ${label}`);
}

test("the state names a play's stream as soon as its load went out, while history is still written", async () => {
  const { plane, car } = await carPlane();
  await plane.hub.play({ source: { plugin: "library", id: "1" } });
  let release;
  const written = new Promise((done) => { release = done; });
  const batch = plane.db.batch;
  plane.db.batch = async (statements) => {
    if (statements[0]?.sql.includes("INSERT INTO history")) await written;
    return batch(statements);
  };
  const playing = plane.hub.play({ source: movie });
  await until(() => plane.transport.sent.some(({ message }) => message.type === "load" && message.item.source.id === "42"), "the load went out");
  const { welcome } = await plane.hub.hello({ name: "Model Y", kind: "car" }, { boundDeviceId: car.id });
  release();
  const { state } = await playing;
  plane.db.batch = batch;
  assert.equal(welcome.state.sessionId, state.sessionId);
});

test("a history write that fails after a play is logged, and the stream plays", async () => {
  const { plane } = await carPlane();
  const batch = plane.db.batch;
  plane.db.batch = async (statements) => {
    if (statements[0]?.sql.includes("INSERT INTO history")) throw Object.assign(new Error("D1 unavailable"), { code: "D1_ERROR" });
    return batch(statements);
  };
  const { state } = await plane.hub.play({ source: movie });
  plane.db.batch = batch;
  assert.equal((await plane.hub.state()).sessionId, state.sessionId);
  const logged = plane.logs.find((record) => record.event === "history_write_failed");
  assert.deepEqual([logged?.sourceKey, logged?.code], ["library:42", "D1_ERROR"]);
});

test("a load sent while a new connection's hello is answered reaches it and is named by its welcome", async () => {
  const { plane, car } = await carPlane();
  await plane.hub.play({ source: { plugin: "library", id: "1" } });
  const order = [];
  const send = plane.transport.send.bind(plane.transport);
  plane.transport.send = (deviceId, message) => {
    order.push(message.type);
    return send(deviceId, message);
  };
  // The hello waits for the media paths (as it can wait on D1) while the play goes on.
  let answer;
  const answered = new Promise((done) => { answer = done; });
  const paths = { paths: [], relayMode: "auto" };
  let waiting = false;
  plane.hub.media = () => {
    waiting = true;
    plane.hub.media = async () => paths;
    return answered.then(() => paths);
  };
  const hello = plane.hub.hello({ name: "Model Y", kind: "car" }, { boundDeviceId: car.id, bind: () => order.push("bind") });
  await until(() => waiting, "the hello waits for the media paths");
  const { state } = await plane.hub.play({ source: movie });
  answer();
  const { welcome } = await hello;
  assert.deepEqual(order, ["bind", "load"], "the connection was the device's before the load went out");
  assert.equal(welcome.state.sessionId, state.sessionId);
});

// Two windows of one device reconnect together: the second binds during
// the first one's hello and tells it `deactivate`. The first then must get
// no welcome, or it would act on it (resume a stream under the device's id
// that the second window plays).
test("a connection another window of the device replaced during its hello gets no welcome", async () => {
  const { plane, car } = await carPlane();
  await plane.hub.play({ source: movie });
  let bound = null;
  const window = (name) => ({ bind: () => { bound = name; }, isBound: () => bound === name });
  let answer;
  const answered = new Promise((done) => { answer = done; });
  const paths = { paths: [], relayMode: "auto" };
  let waiting = false;
  plane.hub.media = () => {
    waiting = true;
    plane.hub.media = async () => paths;
    return answered.then(() => paths);
  };
  const first = plane.hub.hello({ name: "Model Y", kind: "car" }, { boundDeviceId: car.id, ...window("first") });
  await until(() => waiting, "the first window's hello waits");
  const second = await plane.hub.hello({ name: "Model Y", kind: "car" }, { boundDeviceId: car.id, ...window("second") });
  answer();
  const replaced = await first;
  assert.equal(replaced.welcome, null);
  assert.equal(replaced.device.id, car.id);
  assert.equal(second.welcome.type, "welcome");
  assert.equal(second.welcome.state.sessionId, (await plane.hub.state()).sessionId);
});

test("a progress write that fails when another item starts is logged, and the new item still plays", async () => {
  const { plane, car } = await carPlane();
  await plane.hub.play({ source: movie });
  const { sessionId } = await plane.hub.state();
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "playing", position: 30, duration: 600 });
  const prepare = plane.db.prepare;
  const failing = { run: async () => { throw Object.assign(new Error("D1 unavailable"), { code: "D1_ERROR" }); } };
  plane.db.prepare = (sql) => (sql.includes("UPDATE history SET position") ? { bind: () => failing } : prepare(sql));
  const { state } = await plane.hub.play({ source: { plugin: "library", id: "43" } });
  plane.db.prepare = prepare;
  assert.equal(state.item.source.id, "43");
  const logged = plane.logs.find((record) => record.event === "progress_write_failed");
  assert.deepEqual([logged?.sourceKey, logged?.code], ["library:42", "D1_ERROR"]);
});

test("realtime tickets live in the Hub's own storage, work once, and expire after 30 seconds", async () => {
  const plane = createTestControlPlane();
  const { secret, expiresAt } = await plane.hub.issueTicket("dev_car");
  assert.equal(expiresAt, 1_000_000 + 30_000);
  // Storage holds a hash of the ticket, never the ticket.
  assert.equal(JSON.stringify([...plane.storage.map.values()]).includes(secret), false);
  assert.deepEqual(await plane.hub.redeemTicket(secret), { deviceId: "dev_car" });
  assert.equal(await plane.hub.redeemTicket(secret), null);
  const late = await plane.hub.issueTicket();
  plane.advance(30_001);
  assert.equal(await plane.hub.redeemTicket(late.secret), null);
  assert.equal(await plane.hub.redeemTicket(""), null);
  // Expired tickets are dropped when the next one is issued.
  await plane.hub.issueTicket();
  assert.equal(Object.keys(plane.storage.map.get("tickets")).length, 1);
});

// Remote direct play at the home's own address (Agent Note 2026-10-13-media-off-the-worker):
// the Hub marks the path for a screen that connects from the home's public
// address, whose probe then tests the router's NAT loopback; a change of
// the paths reaches every connected screen as its own welcome would.
test("a screen at the home's address is told so, reports whether the router loops back, and hears when the paths change", async () => {
  const plane = createTestControlPlane();
  const wan = { path: "wan", origin: "https://73.63.154.63:9444", notAfter: Infinity };
  plane.hub.media = async () => ({ paths: [wan], relayMode: "off", homeAddress: "73.63.154.63", lanNeedsDomain: true });

  const atHome = await plane.hub.hello({ name: "Model Y", kind: "car" }, { address: "73.63.154.63" });
  assert.deepEqual(atHome.welcome.media, { paths: [{ ...wan, home: true }], relay: false, relayMode: "off", domain: false }, "the paths, the relay, and that there is no domain reach a device; the home's address does not");
  const away = await plane.hub.hello({ name: "Phone", kind: "browser" }, { address: "198.51.100.7" });
  assert.deepEqual(away.welcome.media, { paths: [wan], relay: false, relayMode: "off", domain: false });

  await plane.hub.deviceMessage(atHome.device.id, { type: "network", path: null, reason: "probe", probes: { wan: "timeout" }, hairpin: "failed" });
  assert.equal(plane.logs.filter((record) => record.event === "network").at(-1).hairpin, "failed");
  plane.transport.online.add(atHome.device.id);
  await assert.rejects(plane.hub.play({ source: movie }), (error) => error.code === "media_unreachable" && /home network: needs a domain/.test(error.message));

  await plane.hub.broadcastMedia();
  const message = plane.transport.broadcasts.at(-1);
  assert.deepEqual(message({ address: "73.63.154.63" }), { v: 1, type: "media", media: { paths: [{ ...wan, home: true }], relay: false, relayMode: "off", domain: false } });
  assert.deepEqual(message({ address: null }).media.paths, [wan]);
});
