import assert from "node:assert/strict";
import test from "node:test";

import { state } from "../../src/state.js";

// A tab's sessionStorage, which a page loaded again in the tab reads.
const tab = new Map();
globalThis.sessionStorage = { getItem: (key) => tab.get(key) ?? null, setItem: (key, value) => tab.set(key, value), removeItem: (key) => tab.delete(key) };
const unheard = await import("../../src/unheard.js");

const here = { deviceId: "dev_car" };
state.deviceId = "dev_car";

test("the owner's pause stands while Yolo's state still has the stream playing here, until Yolo has it paused", () => {
  state.sessionId = "ses_1";
  unheard.notePausedHere(12.5);
  assert.deepEqual(unheard.pausedHereFor({ ...here, sessionId: "ses_1", status: "playing" }), { sessionId: "ses_1", position: 12.5 });
  // Interrupted by a dead connection counts as playing; another device's or stream's state says nothing.
  assert.ok(unheard.pausedHereFor({ ...here, sessionId: "ses_1", status: "paused", interruptedAt: 1 }));
  assert.equal(unheard.pausedHereFor({ deviceId: "dev_tv", sessionId: "ses_1", status: "playing" }), null);
  assert.equal(unheard.pausedHereFor({ ...here, sessionId: "ses_1", status: "paused" }), null);
  unheard.noteHeard({ ...here, sessionId: "ses_1", status: "playing" });
  assert.ok(unheard.pausedHereFor({ ...here, sessionId: "ses_1", status: "playing" }), "not heard while Yolo has it playing");
  unheard.noteHeard({ ...here, sessionId: "ses_1", status: "paused" });
  assert.equal(unheard.pausedHereFor({ ...here, sessionId: "ses_1", status: "playing" }), null);
});

test("a stream left without its player stands until Yolo marks it left or names another, and a reload in the tab still knows it", async () => {
  unheard.noteLeft("ses_2", 40);
  assert.equal(unheard.streamLeftFor("ses_2"), true);
  unheard.noteHeard({ ...here, sessionId: "ses_2", status: "playing" });
  assert.deepEqual(unheard.leftStream(), { sessionId: "ses_2", position: 40 });
  const reloaded = await import("../../src/unheard.js?reload");
  assert.equal(reloaded.streamLeftFor("ses_2"), true);
  unheard.noteHeard({ ...here, sessionId: "ses_2", status: "idle", leftAt: 1 });
  assert.equal(unheard.streamLeftFor("ses_2"), false);
  assert.equal(tab.has("yolo.leftStream"), false);
});

test("an end is the stream on screen's until Yolo hears it, and goes when anything plays", () => {
  const player = {};
  state.player = player;
  state.sessionId = "ses_3";
  const end = unheard.noteFinished(player);
  assert.equal(unheard.finishedOnScreen(), true);
  end.heard = true;
  assert.equal(unheard.finishedOnScreen(), false);
  assert.equal(unheard.finishedHere(), true);
  state.player = {};
  assert.equal(unheard.finishedHere(), false, "another player's stream");
  state.player = player;
  unheard.forgetFinished();
  assert.equal(unheard.finishedHere(), false);
});
