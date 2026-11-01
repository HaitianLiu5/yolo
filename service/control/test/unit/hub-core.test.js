import assert from "node:assert/strict";
import { test } from "node:test";
import { YoloError } from "@useyolo/core";
import { createTestControlPlane, onlineScreen, USER } from "../helpers/fakes.js";
import { listHistory, recordPlay } from "../../src/store/history.js";
import { getTrackPreferences, saveTrackPreferences } from "../../src/store/preferences.js";
import { addQueueItems, clearQueue } from "../../src/store/queue.js";
import { HubCore } from "../../src/hub/hub-core.js";

// What the Hub decides that the e2e stack does not show: the media path and
// the relay's modes, the rate a screen's stream starts at on each path,
// previous and next through history, who may be a
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
  const { sessionId } = await plane.hub.state(car.id);
  await plane.hub.play({ source: movie, startTime: 42, reason: "recovery", replaces: sessionId, requester: car.id, network: "relay" });
  assert.deepEqual([prepares().at(-1).network, prepares().at(-1).startTime], ["relay", 42], "the screen's recovery moves down the paths");

  media = { paths: [lan], relayMode: "off", remote: { on: false, status: "off" } };
  await probe(null, { lan: "timeout" });
  const before = prepares().length;
  await assert.rejects(plane.hub.play({ source: movie }), (error) => error.code === "media_unreachable" && /home network: no answer/.test(error.message)
    && /relay is off/.test(error.message) && error.details.fixes.map((fix) => fix.action).join() === "relay,remote");
  assert.equal(prepares().length, before, "the node did no work");
});

test("a screen's stream starts at the rate it kept for that path, days later and when an agent starts it; without one, the relay and remote direct play start at 1500 kbps and the LAN at its ceiling", async () => {
  const { plane, car, prepares } = await carPlane();
  const prepare = plane.node.routes["POST /internal/v1/prepare"];
  plane.node.routes["POST /internal/v1/prepare"] = (body) => ({ ...prepare(body), network: body.network });
  const asked = () => [prepares().at(-1).network, prepares().at(-1).limits?.maxVideoKbps ?? null];
  const probe = (path) => plane.hub.deviceMessage(car.id, { type: "network", path, reason: "probe", probes: {} });
  const own = async (fields) => plane.hub.play({
    source: movie, reason: "quality", replaces: (await plane.hub.state(car.id)).sessionId, requester: car.id, startTime: 10, ...fields,
  });

  await plane.hub.play({ source: movie });
  assert.deepEqual(asked(), ["relay", 1500], "the relay's start");
  await plane.hub.play({ source: movie, device: car.id, requester: car.id, network: "wan" });
  assert.deepEqual(asked(), ["wan", 1500], "remote direct play's start");
  await probe("lan");
  await plane.hub.play({ source: movie });
  assert.deepEqual(asked(), ["lan", null], "the LAN at its ceiling");

  // The screen's own step down on the relay is kept for the relay only.
  await own({ network: "relay", maxVideoKbps: 1000 });
  assert.deepEqual(asked(), ["relay", 1000]);
  await probe("lan");
  await plane.hub.play({ source: movie });
  assert.deepEqual(asked(), ["lan", null]);
  plane.advance(3 * 24 * 60 * 60_000);
  await probe("relay");
  await plane.hub.play({ source: movie });
  assert.deepEqual(asked(), ["relay", 1000], "an agent's play three days later");

  // A step up the screen kept without a request: its report's health.rate.
  const report = async (rate) => plane.hub.deviceMessage(car.id, {
    type: "report", sessionId: (await plane.hub.state(car.id)).sessionId, status: "playing", position: 12, health: { engine: "canvas", rate },
  });
  await report({ path: "relay", kbps: 2200 });
  await report({ path: "wan", kbps: null });
  await report({ path: "relay", kbps: "fast" });
  await plane.hub.play({ source: { plugin: "library", id: "43" } });
  assert.deepEqual(asked(), ["relay", 2200], "the next item");
  await plane.hub.play({ source: movie, device: car.id, requester: car.id, network: "wan" });
  assert.deepEqual(asked(), ["wan", null], "no cap kept for remote direct play");
});

test("an item its source no longer knows plays under the one new id with its title and length; history and the track choice follow", async () => {
  const { plane, car, prepares } = await carPlane();
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
  assert.deepEqual((await plane.hub.state(car.id)).item.source, { plugin: "library", id: "43" }, "what plays stays");
});

test("previous walks back through history one item a press and next forward again before the queue; the walk outlives the Hub's memory, anything else played ends it, and a screen's own press plays there", async () => {
  const { plane, car } = await carPlane();
  const playing = async () => (await plane.hub.state(car.id)).item.source.id;
  const walk = async () => (await plane.hub.state(car.id)).walk ?? null;
  for (const id of ["1", "2", "3"]) await plane.hub.play({ source: { plugin: "library", id } });
  await addQueueItems(plane.db, USER, car.id, [{ source: { plugin: "library", id: "9" }, title: "Movie 9" }]);

  await plane.hub.control("previous");
  assert.deepEqual([await playing(), await walk()], ["2", { back: 1, forward: 1 }]);
  await plane.hub.control("previous");
  assert.deepEqual([await playing(), await walk()], ["1", { back: 0, forward: 2 }], "further back, though playing wrote history");
  await assert.rejects(plane.hub.previous(), { code: "not_found" });

  // The Hub wakes from hibernation with nothing in memory, and a seek's new stream keeps the walk.
  plane.hub = new HubCore({ userId: USER, storage: plane.storage, db: plane.db, node: plane.node, transport: plane.transport, now: () => 1_000_000, log: () => {} });
  const { sessionId } = await plane.hub.state(car.id);
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

  // The screen that played went offline and two others are online: an
  // agent's previous has no session to go back from, a screen's own plays
  // on that screen.
  const computer = await onlineScreen(plane, { name: "Computer", kind: "browser", capabilities: TESLA });
  await onlineScreen(plane, { name: "TV", kind: "tv", capabilities: TESLA });
  plane.transport.online.delete(car.id);
  await assert.rejects(plane.hub.control("previous"), { code: "nothing_playing" });
  const { device } = await plane.hub.control("previous", { requester: computer.id });
  assert.deepEqual([device.id, (await plane.hub.state(computer.id)).item.source.id], [computer.id, "4"]);
});

test("what plays next: the queue first, then the run of the item played directly, which a queue item keeps, resolved ahead for the screen; a dismissed one stops the item, with the rest left to choose from", async () => {
  const { plane, car } = await carPlane();
  const episode = (id) => ({ plugin: "library", id });
  // A show of four episodes; part 3's name the source's listing lacks.
  const SHOW = ["1", "2", "3", "4"].map((id) => ({ source: episode(id), title: id === "3" ? null : `Episode ${id}`, thumbnail: null, duration: 1200 }));
  plane.node.routes["POST /internal/v1/warm"] = ({ sources }) => ({ warming: sources.length });
  const warmed = () => plane.node.calls.filter((call) => call.path === "/internal/v1/warm").map((call) => call.body.sources[0].id);
  plane.node.routes["GET /internal/v1/sequence"] = (query) => {
    const { id } = JSON.parse(query.source);
    const at = SHOW.findIndex((entry) => entry.source.id === id);
    return { sequence: at < 0 ? null : { title: "The Show", items: SHOW.slice(at) } };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const state = () => plane.hub.state(car.id);
  const playing = async () => (await state()).item?.source.id ?? null;

  await plane.hub.play({ source: episode("1") });
  await settle();
  assert.deepEqual((await state()).upNext, { from: "sequence", title: "The Show", item: SHOW[1] });
  assert.deepEqual(warmed(), ["2"], "what plays next is resolved ahead, once");

  // The queue's head goes first; the run waits behind it.
  await addQueueItems(plane.db, USER, car.id, [{ source: { plugin: "library", id: "9" }, title: "Movie 9" }]);
  await plane.hub.broadcastQueue(car.id);
  assert.equal((await state()).upNext.from, "queue");
  await plane.hub.deviceMessage(car.id, { type: "ended", sessionId: (await state()).sessionId });
  assert.equal(await playing(), "9");
  await settle();
  assert.deepEqual((await state()).upNext.item.source, episode("2"), "the queue item kept the run");

  await plane.hub.control("next");
  assert.equal(await playing(), "2");
  await settle();
  // Part 3 is named by the source's describe() before it shows.
  assert.equal((await state()).upNext.item.title, "Movie 3");

  // Dismissed on the screen: the item stops, and nothing else plays. What
  // would have followed it is still there for the end screen.
  await plane.hub.deviceMessage(car.id, { type: "ended", sessionId: (await state()).sessionId, advance: false });
  assert.deepEqual([(await state()).status, await playing()], ["idle", null]);
  await addQueueItems(plane.db, USER, car.id, [{ source: { plugin: "library", id: "8" }, title: "Movie 8" }]);
  const after = await plane.hub.upNextList({ after: "library:2", device: car.id });
  assert.equal(after.title, "The Show");
  assert.deepEqual(after.items.map(({ from, item }) => [from, item.source.id, item.title]), [["queue", "8", "Movie 8"], ["sequence", "3", "Movie 3"], ["sequence", "4", "Episode 4"]]);
  assert.match(after.items[0].queueItemId, /\S/);
  assert.deepEqual((await plane.hub.upNextList({ after: "library:1", device: car.id })).items.map(({ from }) => from), ["queue"], "another item's run is not this one's");
  await clearQueue(plane.db, USER, car.id);

  // A movie played directly has no run; an older node without the route reads the same.
  await plane.hub.play({ source: { plugin: "library", id: "42" } });
  await settle();
  assert.equal((await state()).upNext, undefined);
  delete plane.node.routes["GET /internal/v1/sequence"];
  await plane.hub.play({ source: episode("1") });
  await settle();
  assert.equal((await state()).upNext, undefined);
  await assert.rejects(plane.hub.next(), { code: "not_found" });
});

test("a connection is the device its credential names; a removed device is refused and closed; a remote never plays", async () => {
  const { plane, car } = await carPlane();
  const { device } = await plane.hub.hello({ deviceId: "dev_someone_else", name: "Browser", kind: "browser" }, { boundDeviceId: car.id });
  assert.deepEqual([device.id, device.name, device.kind], [car.id, "Model Y", "car"], "the owner's name and type stay");
  await assert.rejects(plane.hub.hello({ name: "Ghost" }, { boundDeviceId: "dev_removed" }), { code: "unauthorized" });

  const phone = await onlineScreen(plane, { name: "iPhone", kind: "phone", capabilities: { renderer: "remote" } });
  assert.equal((await plane.hub.play({ source: movie })).device.id, car.id, "two online, one a remote: the car plays");
  await assert.rejects(plane.hub.play({ source: movie, device: phone.id }), { code: "invalid_request" });
  await assert.rejects(plane.hub.transfer({ device: phone.id }), { code: "invalid_request" });

  await plane.hub.forgetDevice(car.id);
  assert.deepEqual(plane.transport.closed, [{ deviceId: car.id, code: 4003, reason: "revoked" }]);
  assert.equal((await plane.hub.state(car.id)).status, "idle");
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
    type: "error", sessionId: (await plane.hub.state(car.id)).sessionId, code: "HLS_SEGMENT_FETCH_FAILED",
    message: "GET https://yolo.example/m/sess.usr.123.c2ln/f/2 failed; wss://yolo.example/v1/realtime?ticket=t1ck3t",
  });
  assert.equal(plane.logs.find((record) => record.event === "device_error").message,
    "GET https://yolo.example/m/<redacted>/f/2 failed; wss://yolo.example/v1/realtime?ticket=<redacted>");
});
