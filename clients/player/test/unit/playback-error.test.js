import assert from "node:assert/strict";
import test from "node:test";

import { DEAD_END_TEXT, describePlaybackError, FAILED_TEXT, GONE_TEXT } from "../../src/playback-error.js";

// An error the player wraps around Yolo's refusal, as stream requests do.
const wrapped = (refusal) => Object.assign(new Error("Stream request failed", { cause: refusal }), { apiCode: refusal.code });
const refusal = (code, message, details) => Object.assign(new Error(message), { name: "ApiError", code, ...(details ? { details } : {}) });

test("an error nothing explains says one sentence, and Try again can help", () => {
  for (const error of [new Error("decoder died"), "a string", null]) {
    assert.deepEqual(describePlaybackError(error), { kind: "failed", text: FAILED_TEXT, reason: "", fixes: [], retry: true });
  }
});

test("a screen no media path reaches says why and each fix, from Yolo's details or its own", () => {
  const fixes = [{ action: "relay", text: "Turn the relay to Automatic" }, { text: "Check the node" }, { action: "x", text: 3 }];
  const explained = describePlaybackError(wrapped(refusal("media_unreachable", "No path. Turn the relay on", { reason: "The LAN path failed", fixes })));
  assert.equal(explained.kind, "dead_end");
  assert.equal(explained.text, DEAD_END_TEXT);
  assert.equal(explained.reason, "The LAN path failed");
  assert.deepEqual(explained.fixes, [{ action: "relay", text: "Turn the relay to Automatic" }, { action: "", text: "Check the node" }]);
  assert.equal(explained.retry, true);

  // A refusal without details: the first sentence of its message, and the fixes every screen has.
  const bare = describePlaybackError(refusal("media_unreachable", "The node's LAN listener is not serving now. Turn the relay to Automatic"));
  assert.equal(bare.reason, "The node's LAN listener is not serving now");
  assert.deepEqual(bare.fixes.map((fix) => fix.action), ["relay", "remote"]);
});

test("an item its source no longer has says so, and Try again cannot help", () => {
  const gone = describePlaybackError(wrapped(refusal("not_found", "Item not found")));
  assert.deepEqual(gone, { kind: "gone", text: GONE_TEXT, reason: "", fixes: [], retry: false });
  // A dead end wins: the item may be there, but no path reaches this screen.
  const both = describePlaybackError(Object.assign(new Error("x", { cause: refusal("not_found", "Item not found") }), { code: "media_unreachable" }));
  assert.equal(both.kind, "dead_end");
});

test("on a share link's page a gone item is the link's, in Yolo's words for the friend", () => {
  const expired = wrapped(refusal("not_found", "This link has expired."));
  assert.equal(describePlaybackError(expired, { share: true }).text, "This link has expired.");
  assert.equal(describePlaybackError(expired).text, GONE_TEXT);
  assert.equal(describePlaybackError(Object.assign(new Error(""), { code: "not_found" }), { share: true }).text, GONE_TEXT);
});
