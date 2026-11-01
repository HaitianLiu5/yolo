import assert from "node:assert/strict";
import { test } from "node:test";
import { createV1App } from "../../src/api/v1.js";
import { HubCore } from "../../src/hub/hub-core.js";
import { createServices } from "../../src/services.js";
import { setDeviceProfile } from "../../src/store/devices.js";
import { listHistory } from "../../src/store/history.js";
import { saveTrackPreferences } from "../../src/store/preferences.js";
import { createProfile, resolveProfile } from "../../src/store/profiles.js";
import { addQueueItems, listQueue } from "../../src/store/queue.js";
import { createTestControlPlane, onlineScreen, USER } from "../helpers/fakes.js";

// Every screen plays on its own, and any screen continues another's in one
// tap (Agent Note 2026-10-31-screen-sessions): the note's acceptance
// scenarios as far as the Hub decides them. What a screen shows of them is
// proven in test/e2e.

const PLAYS = { renderer: "canvas-webcodecs", delivery: ["hls", "mp4"], video: ["avc1"], audio: ["mp4a"], maxHeight: 1080, subtitles: "client-vtt" };
const item = (id) => ({ plugin: "library", id });

// A plane whose sockets say what each screen was sent: `sent(deviceId)`,
// and broadcasts as a connection of `protocols[deviceId]` (2 by default)
// would get them.
async function household({ protocols = {} } = {}) {
  const plane = createTestControlPlane();
  const outbox = [];
  plane.transport.send = (deviceId, message) => {
    if (!plane.transport.online.has(deviceId)) return false;
    outbox.push({ deviceId, message });
    return true;
  };
  plane.transport.broadcast = (message) => {
    for (const deviceId of plane.transport.online) {
      const shaped = typeof message === "function" ? message({ deviceId, protocol: protocols[deviceId] ?? 2 }) : message;
      if (shaped) outbox.push({ deviceId, message: shaped, broadcast: true });
    }
  };
  const phone = await onlineScreen(plane, { name: "Phone", kind: "phone", capabilities: PLAYS });
  const tv = await onlineScreen(plane, { name: "Living room TV", kind: "tv", capabilities: PLAYS });
  const car = await onlineScreen(plane, { name: "Model Y", kind: "car", capabilities: PLAYS });
  const family = await resolveProfile(plane.db, USER, "family");
  await setDeviceProfile(plane.db, USER, tv.id, family.id);
  const sent = (deviceId, type) => outbox.filter((entry) => entry.deviceId === deviceId && !entry.broadcast && (!type || entry.message.type === type)).map((entry) => entry.message);
  const heard = (deviceId, type) => outbox.filter((entry) => entry.deviceId === deviceId && entry.broadcast && entry.message.type === type).map((entry) => entry.message);
  const prepares = () => plane.node.calls.filter((call) => call.path === "/internal/v1/prepare").map((call) => call.body);
  // A screen's report that it plays, as the player sends every 5 seconds.
  const report = async (device, position, status = "playing") => plane.hub.deviceMessage(device.id, {
    type: "report", sessionId: (await plane.hub.state(device.id)).sessionId, status, position,
  });
  const services = (requester) => createServices({ db: plane.db, userId: USER, hub: plane.hub, node: plane.node, log: () => {}, requester });
  return { plane, phone, tv, car, family, sent, heard, prepares, report, services };
}

const keys = async (db, owner) => (await listHistory(db, owner)).map((entry) => entry.sourceKey);

test("family on the TV and the owner on the phone play at once; each writes its own history; the owner's agent pauses only the phone", async () => {
  const { plane, phone, tv, car, family, sent, report, services } = await household();
  plane.transport.online.delete(car.id);
  await services(tv.id).play({ itemId: "library:film" });
  await services(phone.id).play({ itemId: "library:ep1" });
  await report(tv, 60);
  await report(phone, 30);

  const [onTv, onPhone] = [await plane.hub.state(tv.id), await plane.hub.state(phone.id)];
  assert.deepEqual([onTv.item.source.id, onTv.status, onTv.profile.id], ["film", "playing", family.id]);
  assert.deepEqual([onPhone.item.source.id, onPhone.status, onPhone.profile.id], ["ep1", "playing", "owner"]);
  assert.deepEqual([...sent(tv.id, "deactivate"), ...sent(phone.id, "deactivate")], [], "another screen's play deactivates no one");
  assert.deepEqual(await keys(plane.db, USER), ["library:ep1"]);
  assert.deepEqual(await keys(plane.db, { userId: USER, profileId: family.id }), ["library:film"]);

  // An agent's pause with no device: the owner's one session in use.
  await services(null).control("pause");
  assert.deepEqual([(await plane.hub.state(phone.id)).status, (await plane.hub.state(tv.id)).status], ["paused", "playing"]);
  assert.equal(sent(phone.id, "pause").length, 1);
  assert.equal(sent(tv.id, "pause").length, 0);

  // A play on each screen at once: neither supersedes the other.
  const slow = plane.node.routes["POST /internal/v1/prepare"];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  plane.node.routes["POST /internal/v1/prepare"] = async (body) => {
    if (body.source.id === "slow") await gate;
    return slow(body);
  };
  const onTvSlow = services(tv.id).play({ itemId: "library:slow" });
  await services(phone.id).play({ itemId: "library:ep2" });
  release();
  assert.equal((await onTvSlow).state.item.source.id, "slow");
});

test("a newly paired screen continues the phone's episode in one tap: its position, subtitles, queue, and what follows; the phone pauses with handedTo", async () => {
  const { plane, phone, sent, prepares, report, services } = await household();
  plane.node.routes["GET /internal/v1/sequence"] = (query) => {
    const { id } = JSON.parse(query.source);
    return id === "ep3" ? { sequence: { title: "The Show", items: ["ep3", "ep4", "ep5"].map((episode) => ({ source: item(episode), title: episode })) } } : { sequence: null };
  };
  await saveTrackPreferences(plane.db, USER, "library:ep3", { subtitles: [{ language: "zho", name: "", format: "text" }], audio: null });
  await services(phone.id).play({ itemId: "library:ep3" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await services(phone.id).addToQueue({ itemId: "library:q1" });
  await services(phone.id).addToQueue({ itemId: "library:q2" });
  await report(phone, 300);
  plane.advance(10_000);

  const browser = await onlineScreen(plane, { name: "Computer", kind: "browser", capabilities: PLAYS });
  plane.node.routes["POST /internal/v1/warm"] = () => ({ warming: 1 });
  await services(browser.id).warm({ sources: [{ source: item("ep3"), startTime: 310 }] });
  const warmed = plane.node.calls.findLast((call) => call.path === "/internal/v1/warm").body;
  assert.deepEqual(warmed.startTimes, { "library:ep3": 310 }, "the card's item is warmed where it would start");

  const { state, from } = await services(browser.id).transfer({ device: browser.id, from: phone.id });
  assert.equal(from.id, phone.id);
  const prepared = prepares().at(-1);
  assert.deepEqual([prepared.source.id, prepared.startTime, prepared.reason], ["ep3", 310, "transfer"]);
  assert.deepEqual(prepared.tracks.preferences.saved.subtitles, [{ language: "zho", name: "", format: "text" }], "the phone's subtitles");
  assert.deepEqual([state.deviceId, state.profile.id, state.handedFrom], [browser.id, "owner", { deviceId: phone.id }]);
  const left = await plane.hub.state(phone.id);
  assert.deepEqual([left.status, left.handedTo.deviceId, left.item.source.id, Math.round(left.position)], ["paused", browser.id, "ep3", 310]);
  assert.equal(sent(phone.id, "pause").at(-1).sessionId, left.sessionId);
  assert.ok(plane.node.calls.some((call) => call.path === `/internal/v1/sessions/${left.sessionId}/stop`), "the phone's stream stops");
  assert.deepEqual((await listQueue(plane.db, USER, browser.id)).map((entry) => entry.source.id), ["q1", "q2"], "the queue came along");
  assert.deepEqual(await listQueue(plane.db, USER, phone.id), []);

  // A handed session is not in use: the agents' default is the new screen.
  assert.equal((await plane.hub.getState()).deviceId, browser.id);
  await services(browser.id).control("next");
  assert.equal((await plane.hub.state(browser.id)).item.source.id, "q1");
  await services(browser.id).control("next");
  await services(browser.id).control("next");
  assert.equal((await plane.hub.state(browser.id)).item.source.id, "ep4", "then the run it came with");

  // The phone's welcome names the handover, so it does not resume.
  const { welcome } = await plane.hub.hello({ protocol: 2 }, { boundDeviceId: phone.id });
  assert.deepEqual([welcome.state.status, welcome.state.handedTo.deviceId], ["paused", browser.id]);
  assert.ok(welcome.sessions.some((session) => session.deviceId === browser.id && session.inUse));
});

test("a parked car's session continues on the family TV as the owner's, and the car does not resume it", async () => {
  const { plane, car, tv, family, services, report } = await household();
  await services(car.id).play({ itemId: "library:ep5" });
  await report(car, 390);
  plane.transport.online.delete(car.id);
  await plane.hub.deviceDisconnected(car.id);

  const { sessions } = await plane.hub.sessions();
  assert.deepEqual(sessions.map((session) => [session.device.name, session.item.source.id, Math.round(session.position), session.inUse]), [["Model Y", "ep5", 390, false]]);
  await services(tv.id).transfer({ device: tv.id, from: car.id });
  const onTv = await plane.hub.state(tv.id);
  assert.deepEqual([onTv.item.source.id, onTv.profile.id], ["ep5", "owner"]);
  assert.deepEqual(await keys(plane.db, USER), ["library:ep5"]);
  assert.deepEqual(await keys(plane.db, { userId: USER, profileId: family.id }), []);

  // The next item the family plays there is Family's.
  await services(tv.id).play({ itemId: "library:cartoon" });
  assert.equal((await plane.hub.state(tv.id)).profile.id, family.id);
  assert.deepEqual(await keys(plane.db, { userId: USER, profileId: family.id }), ["library:cartoon"]);

  plane.transport.online.add(car.id);
  const { welcome } = await plane.hub.hello({ protocol: 2 }, { boundDeviceId: car.id });
  assert.deepEqual([welcome.state.handedTo.deviceId, welcome.state.status], [tv.id, "paused"]);
});

test("moving to a screen someone else is using asks first; confirming plays there and keeps the film's place in Family's history", async () => {
  const { plane, phone, tv, family, services, report } = await household();
  await services(tv.id).play({ itemId: "library:film" });
  await report(tv, 500);
  await services(phone.id).play({ itemId: "library:ep1" });
  await report(phone, 400);

  await assert.rejects(services(phone.id).transfer({ device: tv.id, from: phone.id }), (error) => error.code === "screen_busy"
    && error.details.profile.name === "Family" && error.details.item.title === "Movie film" && error.details.name === "Living room TV");
  assert.equal((await plane.hub.state(tv.id)).item.source.id, "film", "cancel changes nothing");

  await services(phone.id).transfer({ device: tv.id, from: phone.id, replace: true });
  assert.deepEqual([(await plane.hub.state(tv.id)).item.source.id, (await plane.hub.state(tv.id)).profile.id], ["ep1", "owner"]);
  const [film] = await listHistory(plane.db, { userId: USER, profileId: family.id });
  assert.deepEqual([film.sourceKey, Math.round(film.position)], ["library:film", 500]);

  // From the TV itself, a takeover never asks: the person is there.
  await services(phone.id).play({ itemId: "library:ep2" });
  await report(phone, 10);
  await services(tv.id).transfer({ device: tv.id, from: phone.id });
  assert.equal((await plane.hub.state(tv.id)).item.source.id, "ep2");

  // An agent's play on a named screen someone else uses asks too.
  await services(tv.id).play({ itemId: "library:film2" });
  await assert.rejects(services(null).play({ itemId: "library:x", device: "Living room TV" }), { code: "screen_busy" });
  await services(null).play({ itemId: "library:x", device: "Living room TV", replace: true });
});

test("the default rule: the asking screen, else the owner's one session in use, else ask; Family's screens are never a default", async () => {
  const { plane, phone, tv, car, services, report } = await household();
  // An Ask from the car plays in the car while the TV plays on.
  await services(tv.id).play({ itemId: "library:film" });
  await services(car.id).play({ itemId: "library:song" });
  assert.equal((await plane.hub.state(tv.id)).item.source.id, "film");
  await services(phone.id).play({ itemId: "library:ep1" });
  await report(phone, 5);
  await report(car, 5);

  await assert.rejects(services(null).play({ itemId: "library:x" }), (error) => error.code === "device_ambiguous"
    && error.details.screens.map((screen) => screen.name).sort().join() === "Model Y,Phone");
  await assert.rejects(services(null).control("pause"), { code: "device_ambiguous" });
  const status = await services(null).status();
  assert.match(status.target.ambiguous, /Model Y/);
  assert.equal(status.sessions.length, 3);

  // With only the family TV in use: a play goes to the owner's only online screen.
  await services(null).control("stop", { device: phone.id });
  await services(null).control("stop", { device: car.id });
  plane.transport.online.delete(car.id);
  await assert.rejects(services(null).control("pause"), { code: "nothing_playing" });
  const { device } = await services(null).play({ itemId: "library:x" });
  assert.equal(device.id, phone.id);
  assert.equal((await plane.hub.state(tv.id)).item.source.id, "film");
  plane.transport.online.delete(phone.id);
  await assert.rejects(services(null).play({ itemId: "library:y" }), (error) => error.code === "device_ambiguous" && /other profiles/.test(error.message));
  assert.equal((await plane.hub.state(tv.id)).item.source.id, "film");
});

test("the now-playing bar pauses another screen's session and only that one", async () => {
  const { plane, phone, tv, services, sent } = await household();
  await services(tv.id).play({ itemId: "library:film" });
  await services(phone.id).play({ itemId: "library:ep1" });
  await services(phone.id).control("pause", { device: tv.id });
  assert.deepEqual([(await plane.hub.state(tv.id)).status, (await plane.hub.state(phone.id)).status], ["paused", "loading"]);
  assert.deepEqual([sent(tv.id, "pause").length, sent(phone.id, "pause").length], [1, 0]);
  await services(phone.id).seek(30, { device: tv.id });
  assert.equal(sent(tv.id, "seek").at(-1).position, 30);
});

test("a protocol-1 screen hears only its own session and queue, plays beside the others, and a takeover from it is a pause", async () => {
  // The TV speaks protocol 1, as an Apple TV build before protocol 2 does.
  const made = await household();
  const broadcast = made.plane.transport.broadcast;
  made.plane.transport.broadcast = (message) => broadcast(typeof message === "function"
    ? (entry) => message({ ...entry, protocol: entry.deviceId === made.tv.id ? 1 : 2 })
    : message);
  const { plane, phone, tv, heard, sent, services, report } = made;
  const { welcome } = await plane.hub.hello({ protocol: 1 }, { boundDeviceId: tv.id });
  assert.deepEqual([welcome.sessions, welcome.profiles], [undefined, undefined]);
  await services(tv.id).play({ itemId: "library:film" });
  await services(phone.id).play({ itemId: "library:ep1" });
  await report(tv, 20);
  assert.equal((await plane.hub.state(tv.id)).status, "playing", "it plays beside the phone");
  assert.ok(heard(tv.id, "state").every((message) => message.state.deviceId === tv.id), "the TV hears only its own state");
  assert.ok(heard(phone.id, "state").some((message) => message.state.deviceId === tv.id), "the phone hears the TV's");
  await services(phone.id).addToQueue({ itemId: "library:q" });
  assert.deepEqual(heard(tv.id, "queue"), []);
  assert.equal(heard(phone.id, "queue").at(-1).deviceId, phone.id);

  await services(phone.id).transfer({ device: phone.id, from: tv.id });
  assert.equal(sent(tv.id, "pause").length, 1);
  assert.deepEqual(sent(tv.id, "deactivate"), []);
  assert.equal(heard(tv.id, "state").at(-1).state.handedTo.deviceId, phone.id);
});

test("a third profile: Kids' tablet writes and reads Kids' history, apart from Family's and the owner's", async () => {
  const { plane, phone, tv, services } = await household();
  const kids = await createProfile(plane.db, USER, { name: "Kids" });
  const tablet = await onlineScreen(plane, { name: "Bedroom tablet", kind: "browser", capabilities: PLAYS });
  await services(null).renameDevice("Bedroom tablet", { profile: "Kids" });
  await services(tablet.id).play({ itemId: "library:cartoon" });
  await services(tv.id).play({ itemId: "library:film" });
  await services(phone.id).play({ itemId: "library:ep1" });

  const app = (deviceId) => createV1App({ getContext: () => ({ services: services(deviceId), scopes: ["read", "control", "manage"], userId: USER, deviceId }) });
  const history = async (deviceId, query = "") => (await (await app(deviceId).request(`/v1/history${query}`)).json()).map((entry) => entry.sourceKey);
  assert.deepEqual(await history(tablet.id), ["library:cartoon"]);
  assert.deepEqual(await history(tv.id), ["library:film"]);
  assert.deepEqual(await history(phone.id), ["library:ep1"]);
  assert.deepEqual(await history(phone.id, "?profile=Kids"), ["library:cartoon"]);
  assert.deepEqual(await keys(plane.db, { userId: USER, profileId: kids.id }), ["library:cartoon"]);

  // Removing a profile takes its history and sets its screens back to the owner's.
  await services(null).deleteProfile(kids.id);
  assert.deepEqual(await keys(plane.db, { userId: USER, profileId: kids.id }), []);
  assert.equal((await services(null).devices()).devices.find((device) => device.id === tablet.id).profile, "owner");
});

test("the single session of the release before moves to the screen that played it, with its walk, run, and queue", async () => {
  const plane = createTestControlPlane();
  const car = await onlineScreen(plane, { name: "Model Y", capabilities: PLAYS });
  const legacy = {
    status: "paused", deviceId: car.id, item: { source: item("ep2"), title: "Episode 2", duration: 1200 }, position: 600, positionAt: 5,
    tracks: { subtitles: [], audio: null }, sessionId: "ses_old", walk: { back: 1, forward: 0 },
  };
  await plane.storage.put("state", legacy);
  await plane.storage.put("walk", { key: "library:ep2", back: [{ source: item("ep1") }], forward: [] });
  await plane.storage.put("run", { key: "library:ep2", title: "Show", items: [{ source: item("ep3") }] });
  plane.db.raw.prepare("INSERT INTO queue_items (id, user_id, source, title, metadata, position, added_at) VALUES ('itm_old', ?, ?, 'Old', '{}', 1, 0)")
    .run(USER, JSON.stringify(item("q")));

  await plane.hub.migrateStorage();
  const state = await plane.hub.state(car.id);
  assert.deepEqual([state.sessionId, state.profile.id, state.position], ["ses_old", "owner", 600]);
  assert.deepEqual([await plane.storage.get("state"), await plane.storage.get("walk"), await plane.storage.get("run")], [undefined, undefined, undefined]);
  assert.equal((await plane.storage.get(`run:${car.id}`)).items[0].source.id, "ep3");
  assert.deepEqual((await listQueue(plane.db, USER, car.id)).map((entry) => entry.id), ["itm_old"]);
  assert.equal((await plane.hub.upNextList({ device: car.id })).items[0].from, "queue");

  // Once done, a Hub that starts again changes nothing; a rollback's state moves again.
  await plane.hub.migrateStorage();
  assert.equal((await plane.hub.state(car.id)).sessionId, "ses_old");
  await plane.storage.put("state", { ...legacy, sessionId: "ses_rolled_back" });
  await addQueueItems(plane.db, USER, null, [{ source: item("r"), title: "R" }]);
  await new HubCore({ userId: USER, storage: plane.storage, db: plane.db, node: plane.node, transport: plane.transport, log: () => {} }).migrateStorage();
  assert.equal((await plane.hub.state(car.id)).sessionId, "ses_rolled_back");
  assert.deepEqual((await listQueue(plane.db, USER, car.id)).map((entry) => entry.source.id), ["q", "r"]);
});
