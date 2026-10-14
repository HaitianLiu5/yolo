import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTimestamp, parseTimestamp, YoloError } from "@useyolo/core";
import { createTestControlPlane, onlineScreen } from "../helpers/setup.js";

// get_frame (Agent Note 2026-10-13-video-frames): how a time is read, and
// which item, time, and session the node is asked for when the agent leaves
// them out.

test("a time is seconds, mm:ss, or hh:mm:ss", () => {
  assert.equal(parseTimestamp(754), 754);
  assert.equal(parseTimestamp("754.5"), 754.5);
  assert.equal(parseTimestamp("12:34"), 754);
  assert.equal(parseTimestamp("1:02:03.5"), 3723.5);
  assert.equal(parseTimestamp(" 0:00:07.500 "), 7.5);
  assert.equal(parseTimestamp("90:00"), 5400);
  for (const bad of [-1, Number.NaN, "", "abc", "-3", "1:75", "1:60:00", "1:2:3:4"]) {
    assert.throws(() => parseTimestamp(bad), { code: "invalid_request" }, String(bad));
  }
  assert.equal(formatTimestamp(754), "12:34");
  assert.equal(formatTimestamp(3723.5, { millis: true }), "1:02:03.500");
});

function frameNode(plane) {
  const asked = [];
  plane.node.routes["POST /internal/v1/frame"] = (body) => {
    asked.push(body);
    return { image: "AAAA", mimeType: "image/jpeg", width: 1280, height: 720, time: body.time, title: "A video", duration: 600, input: "hls", plugin: body.source.plugin };
  };
  return asked;
}

test("get_frame defaults to what plays now, at the Hub's position, in its session", async () => {
  const plane = createTestControlPlane();
  const asked = frameNode(plane);
  await assert.rejects(plane.services.frame({}), { code: "invalid_request", message: /Nothing is playing/ });

  await onlineScreen(plane);
  const { state } = await plane.services.play({ url: "https://video.test/a", startAt: 100 });
  await plane.hub.deviceMessage(state.deviceId, { type: "report", sessionId: state.sessionId, status: "playing", position: 100 });
  plane.advance(12_000);
  const frame = await plane.services.frame({});
  assert.equal(frame.time, 112);
  assert.deepEqual(asked.at(-1), { source: state.item.source, time: 112, width: 1280, sessionId: state.sessionId });

  // The playing item named explicitly is the same item, in the same session.
  await plane.services.frame({ url: "https://video.test/a", time: "2:00", width: 640 });
  assert.deepEqual(asked.at(-1), { source: state.item.source, time: 120, width: 640, sessionId: state.sessionId });
  await assert.rejects(plane.services.frame({ time: "10:01" }), { code: "invalid_request", message: /past the end/ });
});

test("get_frame of another item needs a time and no session", async () => {
  const plane = createTestControlPlane();
  const asked = frameNode(plane);
  await assert.rejects(plane.services.frame({ itemId: "library:9" }), { code: "invalid_request", message: /time is required/ });
  await plane.services.frame({ itemId: "library:9", time: "1:00" });
  assert.deepEqual(asked.at(-1), { source: { plugin: "library", id: "9" }, time: 60, width: 1280, sessionId: null });
  await assert.rejects(plane.services.frame({ itemId: "library:9", time: "soon" }), { code: "invalid_request" });
});

test("get_frame is rate limited per agent and says when the node is too old", async () => {
  let allowed = false;
  const plane = createTestControlPlane({ allowFrame: async () => allowed });
  await assert.rejects(plane.services.frame({ itemId: "library:9", time: 5 }), { code: "rate_limited" });
  allowed = true;
  plane.node.routes["POST /internal/v1/frame"] = () => {
    throw new YoloError("not_found", "No such endpoint");
  };
  await assert.rejects(plane.services.frame({ itemId: "library:9", time: 5 }), { code: "not_found", message: /upgrade/ });
});
