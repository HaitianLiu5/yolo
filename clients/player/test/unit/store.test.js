import assert from "node:assert/strict";
import test from "node:test";

import { state } from "../../src/state.js";
import { continueCandidates, inUse, nextAvailable, previousAvailable, share, subscribe, upNextFor } from "../../src/store.js";

test("a share redraws each view that shows what it wrote, once", () => {
  const drawn = [];
  subscribe(["queue"], () => drawn.push("queue row"));
  subscribe(["hub", "queue"], ({ remember = true } = {}) => drawn.push(`bar ${remember}`));
  share({ queue: [{ id: "q1" }] });
  assert.deepEqual(state.queue, [{ id: "q1" }]);
  assert.deepEqual(drawn, ["queue row", "bar true"]);

  drawn.length = 0;
  // The hub and the queue in one welcome: the bar draws once.
  share({ hub: { status: "playing" }, queue: [] }, { remember: false });
  assert.deepEqual(drawn, ["queue row", "bar false"]);

  drawn.length = 0;
  share({ playlists: [] });
  assert.deepEqual(drawn, []);
  assert.throws(() => share({ devices: [] }), /not shared state/);
});

test("what the Hub names up next is the next of the stream it plays, no other", () => {
  const upNext = { from: "queue", item: { source: { plugin: "library", id: "2" } } };
  const hub = { sessionId: "s1", upNext };
  assert.equal(upNextFor("s1", hub), upNext);
  assert.equal(upNextFor("s0", hub), null);
  assert.equal(upNextFor(null, { sessionId: null, upNext }), null);
});

test("one view's failure leaves the others drawn", (t) => {
  t.mock.method(console, "error", () => {});
  let drawn = false;
  subscribe(["playlists"], () => { throw new Error("gone"); });
  subscribe(["playlists"], () => { drawn = true; });
  share({ playlists: [{ id: "p1" }] });
  assert.equal(drawn, true);
});

const item = (id) => ({ source: { plugin: "plex", id } });

test("next goes forward through the walk of the item playing, then to the queue", () => {
  assert.equal(nextAvailable({ hub: { item: item("1") }, queue: [] }), false);
  assert.equal(nextAvailable({ hub: { item: item("1") }, queue: [{ id: "q1" }] }), true);
  const walking = { item: item("1"), walk: { back: 1, forward: 2 } };
  assert.equal(nextAvailable({ hub: walking, queue: [] }), true);
  // A screen on another item than the Hub's has no walk to go on.
  assert.equal(nextAvailable({ hub: walking, queue: [], current: "plex:2" }), false);
  // The Hub names what is up next: the item's run, with the queue empty.
  const upNext = { item: item("1"), upNext: { from: "sequence", item: { source: item("2").source } } };
  assert.equal(nextAvailable({ hub: upNext, queue: [] }), true);
  assert.equal(nextAvailable({ hub: upNext, queue: [], current: "plex:9" }), false);
});

test("previous walks back, or without a walk plays the latest other item in history", () => {
  const walking = { item: item("1"), walk: { back: 0, forward: 1 } };
  assert.equal(previousAvailable({ hub: walking, recentHistory: ["plex:9"] }), false);
  assert.equal(previousAvailable({ hub: { item: item("1") }, recentHistory: ["plex:1"] }), false);
  assert.equal(previousAvailable({ hub: { item: item("1") }, recentHistory: ["plex:1", "plex:9"] }), true);
  assert.equal(previousAvailable({ hub: null, current: "plex:1", recentHistory: null }), false);
});

// Every screen plays on its own (Agent Note 2026-10-31-screen-sessions).
test("Continue from another screen offers the owner's and this screen's profile's sessions, newest first, a parked car's too", () => {
  const session = (deviceId, fields = {}) => ({
    deviceId, sessionId: `s-${deviceId}`, status: "paused", position: 100, updatedAt: 10, profile: { id: "owner", name: "Owner" },
    item: { source: { plugin: "plex", id: deviceId }, title: deviceId, duration: 1200 }, ...fields,
  });
  const sessions = {
    car: session("car", { updatedAt: 30 }),
    phone: session("phone", { status: "playing", updatedAt: 20 }),
    kids: session("kids", { profile: { id: "prf_kids", name: "Kids" }, updatedAt: 40 }),
    done: session("done", { position: 1190, updatedAt: 50 }),
    here: session("here", { updatedAt: 60 }),
  };
  const ids = (options) => continueCandidates({ sessions, self: "here", ...options }).map((entry) => entry.deviceId);
  assert.deepEqual(ids({ profile: { id: "owner" } }), ["car", "phone"], "not Kids', not a finished one, not this screen's own");
  assert.deepEqual(ids({ profile: { id: "prf_kids" } }), ["kids", "car", "phone"], "a Kids screen offers Kids' and the owner's");
  assert.deepEqual(ids({ profile: { id: "owner" }, max: 1 }), ["car"]);

  const online = [{ id: "phone", online: true }, { id: "car", online: false }];
  assert.equal(inUse(sessions.phone, { devices: online }), true);
  assert.equal(inUse(sessions.car, { devices: online }), false, "a parked car's session is not in use");
  assert.equal(inUse({ ...sessions.phone, handedTo: { deviceId: "car" } }, { devices: online }), false);
});
