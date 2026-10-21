import assert from "node:assert/strict";
import { test } from "node:test";
import { YoloError } from "@useyolo/core";
import { createTestControlPlane, onlineScreen, USER } from "../helpers/fakes.js";
import { listHistory, recordPlay } from "../../src/store/history.js";
import { getTrackPreferences, saveTrackPreferences } from "../../src/store/preferences.js";
import { addQueueItems } from "../../src/store/queue.js";
import { HubCore } from "../../src/hub/hub-core.js";

// What the Hub decides that the e2e stack does not show: the media path and
// the relay's modes, previous and next through history, who may be a
// device, an item found under a new id, and secrets in logs. Playback, commands, resume, and reconnects are proven in
// test/e2e.

const movie = { plugin: "library", id: "42" };
const TESLA = { renderer: "canvas-webcodecs", delivery: ["hls", "mp4"], video: ["avc1"], audio: ["mp4a"], maxHeight: 720, subtitles: "client-vtt" };

async function carPlane() {
  const plane = createTestControlPlane();
  const car = await onlineScreen(plane, { name: "Model Y", capabilities: TESLA });
  const prepares = () => plane.node.calls.filter((call) => call.path === "/internal/v1/prepare").map((call) => call.body);
  return { plane, car, prepares };
}

test("the screen's own probe picks the path, the relay comes last, and with the relay off no path is refused before the node works", async () => {
  const { plane, car, prepares } = await carPlane();
  const prepare = plane.node.routes["POST /internal/v1/prepare"];
  plane.node.routes["POST /internal/v1/prepare"] = (body) => ({ ...prepare(body), network: body.network });
  const lan = { path: "lan", origin: "https://yolo-lan-1.example.com:9443", notAfter: Infinity };
  let media = { paths: [lan], relayMode: "auto" };
  plane.hub.media = async () => media;
  const probe = (path, probes) => plane.hub.deviceMessage(car.id, { type: "network", path, reason: "probe", probes });

  await plane.hub.play({ source: movie });
  assert.equal(prepares().at(-1).network, "relay", "a screen that never probed");
  await probe("lan", { lan: "ok" });
  await plane.hub.play({ source: movie, startTime: 10 });
  assert.equal(prepares().at(-1).network, "lan");
  await plane.hub.play({ source: movie, network: "wan" });
  assert.equal(prepares().at(-1).network, "lan", "an agent cannot move the screen to another path");
  const { sessionId } = await plane.hub.state();
  await plane.hub.play({ source: movie, startTime: 42, reason: "recovery", replaces: sessionId, requester: car.id, network: "relay" });
  assert.deepEqual([prepares().at(-1).network, prepares().at(-1).startTime], ["relay", 42], "the screen's recovery moves down the paths");

  media = { paths: [lan], relayMode: "off", remote: { on: false, status: "off" } };
  await probe(null, { lan: "timeout" });
  const before = prepares().length;
  await assert.rejects(plane.hub.play({ source: movie }), (error) => error.code === "media_unreachable" && /home network: no answer/.test(error.message)
    && /relay is off/.test(error.message) && error.details.fixes.map((fix) => fix.action).join() === "relay,remote");
  assert.equal(prepares().length, before, "the node did no work");
});

test("an item its source no longer knows plays under the one new id with its title and length; history and the track choice follow", async () => {
  const { plane, prepares } = await carPlane();
  const prepare = plane.node.routes["POST /internal/v1/prepare"];
  plane.node.routes["POST /internal/v1/prepare"] = (body) => {
    if (body.source.id === "42") throw new YoloError("not_found", "Library item not found");
    return prepare(body);
  };
  let results = [];
  plane.node.routes["GET /internal/v1/library/search"] = () => ({ results });
  await recordPlay(plane.db, USER, { source: movie, title: "Movie 42", duration: 600, position: 120 });
  await saveTrackPreferences(plane.db, USER, "library:42", { subtitles: [{ language: "zho" }], audio: null });

  results = [
    { id: "library:43", title: " movie  42", duration: 601.5 },
    { id: "web:9", title: "Movie 42", duration: 600 },
    { id: "library:44", title: "Movie 42", duration: 640 },
    { id: "library:45", title: "Movie 42 (Extended)", duration: 600 },
  ];
  const { state } = await plane.hub.play({ source: movie });
  assert.deepEqual(state.item.source, { plugin: "library", id: "43" });
  assert.deepEqual(prepares().map((body) => [body.source.id, body.startTime]), [["42", 120], ["43", 120]], "it resumes where the old id was left");
  assert.deepEqual((await listHistory(plane.db, USER)).map((entry) => [entry.sourceKey, entry.playCount]), [["library:43", 2]]);
  assert.deepEqual((await getTrackPreferences(plane.db, USER, "library:43")).saved, { subtitles: [{ language: "zho" }], audio: null });

  // Two matches, only another source's, or a length off by more than 2
  // seconds: nothing plays, and the answer says the video is gone.
  for (const found of [
    [{ id: "library:43", title: "Movie 42", duration: 600 }, { id: "library:46", title: "Movie 42", duration: 599 }],
    [{ id: "web:9", title: "Movie 42", duration: 600 }],
    [{ id: "library:44", title: "Movie 42", duration: 602.5 }],
  ]) {
    results = found;
    await assert.rejects(plane.hub.play({ source: movie, item: { title: "Movie 42", duration: 600 } }),
      (error) => error.code === "not_found" && /no longer in the library/.test(error.message));
  }
  assert.deepEqual((await plane.hub.state()).item.source, { plugin: "library", id: "43" }, "what plays stays");
});

test("previous walks back through history one item a press and next forward again before the queue; the walk outlives the Hub's memory, anything else played ends it, and a screen's own press plays there", async () => {
  const { plane, car } = await carPlane();
  const playing = async () => (await plane.hub.state()).item.source.id;
  const walk = async () => (await plane.hub.state()).walk ?? null;
  for (const id of ["1", "2", "3"]) await plane.hub.play({ source: { plugin: "library", id } });
  await addQueueItems(plane.db, USER, [{ source: { plugin: "library", id: "9" }, title: "Movie 9" }]);

  await plane.hub.control("previous");
  assert.deepEqual([await playing(), await walk()], ["2", { back: 1, forward: 1 }]);
  await plane.hub.control("previous");
  assert.deepEqual([await playing(), await walk()], ["1", { back: 0, forward: 2 }], "further back, though playing wrote history");
  await assert.rejects(plane.hub.previous(), { code: "not_found" });

  // The Hub wakes from hibernation with nothing in memory, and a seek's new stream keeps the walk.
  plane.hub = new HubCore({ userId: USER, storage: plane.storage, db: plane.db, node: plane.node, transport: plane.transport, now: () => 1_000_000, log: () => {} });
  const { sessionId } = await plane.hub.state();
  await plane.hub.play({ source: { plugin: "library", id: "1" }, startTime: 30, reason: "seek", replaces: sessionId, requester: car.id });
  await plane.hub.control("next");
  assert.deepEqual([await playing(), await walk()], ["2", { back: 1, forward: 1 }]);
  await plane.hub.control("next");
  assert.deepEqual([await playing(), await walk()], ["3", { back: 2, forward: 0 }]);
  await plane.hub.control("next");
  assert.deepEqual([await playing(), await walk()], ["9", null], "then the queue");

  // Something played otherwise ends the walk: next takes the queue, not where previous came from.
  await plane.hub.control("previous");
  assert.equal(await playing(), "3");
  await plane.hub.play({ source: { plugin: "library", id: "4" } });
  assert.equal(await walk(), null);
  await assert.rejects(plane.hub.next(), { code: "not_found" });

  // The active screen went offline and two others are online: an agent's
  // previous cannot choose, a screen's own plays on that screen.
  const computer = await onlineScreen(plane, { name: "Computer", kind: "browser", capabilities: TESLA });
  await onlineScreen(plane, { name: "TV", kind: "tv", capabilities: TESLA });
  plane.transport.online.delete(car.id);
  await assert.rejects(plane.hub.control("previous"), { code: "invalid_request" });
  const { device } = await plane.hub.control("previous", { device: computer.id, requester: computer.id });
  assert.deepEqual([device.id, (await plane.hub.state()).deviceId], [computer.id, computer.id]);
});

test("a connection is the device its credential names; a removed device is refused and closed; a remote never plays", async () => {
  const { plane, car } = await carPlane();
  const { device } = await plane.hub.hello({ deviceId: "dev_someone_else", name: "Browser", kind: "browser" }, { boundDeviceId: car.id });
  assert.deepEqual([device.id, device.name, device.kind], [car.id, "Model Y", "car"], "the owner's name and type stay");
  await assert.rejects(plane.hub.hello({ name: "Ghost" }, { boundDeviceId: "dev_removed" }), { code: "unauthorized" });

  const phone = await onlineScreen(plane, { name: "iPhone", kind: "phone", capabilities: { renderer: "remote" } });
  assert.equal((await plane.hub.play({ source: movie })).device.id, car.id, "two online, one a remote: the car plays");
  await assert.rejects(plane.hub.play({ source: movie, device: phone.id }), { code: "invalid_request" });
  await assert.rejects(plane.hub.transfer(phone.id), { code: "invalid_request" });

  await plane.hub.forgetDevice(car.id);
  assert.deepEqual(plane.transport.closed, [{ deviceId: car.id, code: 4003, reason: "revoked" }]);
  assert.equal((await plane.hub.state()).status, "idle");
});

test("realtime tickets are stored hashed, work once, and expire after 30 seconds; a device's error is logged without its tokens", async () => {
  const { plane, car } = await carPlane();
  const { secret, expiresAt } = await plane.hub.issueTicket("dev_car");
  assert.equal(expiresAt, 1_000_000 + 30_000);
  assert.equal(JSON.stringify([...plane.storage.map.values()]).includes(secret), false);
  assert.deepEqual(await plane.hub.redeemTicket(secret), { deviceId: "dev_car" });
  assert.equal(await plane.hub.redeemTicket(secret), null);
  const late = await plane.hub.issueTicket();
  plane.advance(30_001);
  assert.equal(await plane.hub.redeemTicket(late.secret), null);

  await plane.hub.play({ source: movie });
  await plane.hub.deviceMessage(car.id, {
    type: "error", sessionId: (await plane.hub.state()).sessionId, code: "HLS_SEGMENT_FETCH_FAILED",
    message: "GET https://yolo.example/m/sess.usr.123.c2ln/f/2 failed; wss://yolo.example/v1/realtime?ticket=t1ck3t",
  });
  assert.equal(plane.logs.find((record) => record.event === "device_error").message,
    "GET https://yolo.example/m/<redacted>/f/2 failed; wss://yolo.example/v1/realtime?ticket=<redacted>");
});
