import assert from "node:assert/strict";
import test from "node:test";
import { resumeDecision } from "../../src/resume-decision.js";

const source = { plugin: "ytdlp", id: "https://example.com/v" };
const hub = (fields) => ({ deviceId: "dev_car", sessionId: "ses_1", item: { source }, position: 754.2, ...fields });

test("a page that wakes while its item was playing plays on at the saved position", () => {
  for (const status of ["playing", "buffering", "loading"]) {
    assert.deepEqual(resumeDecision(hub({ status }), "dev_car"), {
      source, sessionId: "ses_1", position: 754.2, autoplay: true, why: "playing",
    });
  }
});

test("an interrupted item plays on however long the car slept", () => {
  // The Hub keeps the place as paused when the car's connection drops, and
  // marks when. There is no time limit: 3 minutes and 9 hours look alike.
  for (const sleptMs of [3 * 60_000, 9 * 60 * 60_000]) {
    const decision = resumeDecision(hub({ status: "paused", interruptedAt: Date.now() - sleptMs }), "dev_car");
    assert.equal(decision.autoplay, true);
    assert.equal(decision.why, "interrupted");
  }
});

test("an item the owner paused before leaving stays paused", () => {
  const decision = resumeDecision(hub({ status: "paused" }), "dev_car");
  assert.deepEqual([decision.autoplay, decision.why, decision.position], [false, "paused", 754.2]);
});

test("nothing is resumed for another device, a stopped item, or without a session", () => {
  assert.equal(resumeDecision(hub({ status: "playing" }), "dev_phone"), null);
  assert.equal(resumeDecision(hub({ status: "idle" }), "dev_car"), null);
  assert.equal(resumeDecision(hub({ status: "playing", sessionId: null }), "dev_car"), null);
  assert.equal(resumeDecision({ ...hub({ status: "playing" }), item: null }, "dev_car"), null);
  assert.equal(resumeDecision(null, "dev_car"), null);
  assert.equal(resumeDecision(hub({ status: "playing" }), null), null);
});
