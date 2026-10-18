import assert from "node:assert/strict";
import test from "node:test";

import { growingWindow, mergeWindow, pollDue, windowUrl } from "../../src/growing-subtitles.js";

// A growing AI track (Agent Note 2026-10-18-ai-subtitles) is read again for a
// window around the position; each answer replaces what it covers and keeps
// the cues the screen already has elsewhere.

const cue = (start, end, text) => ({ start, end, text });

test("a growing track asks for a window ahead of the position and keeps cues outside each answer", () => {
  const window = growingWindow(100);
  assert.deepEqual(window, { start: 90, end: 190 });
  assert.equal(windowUrl("https://node.test/m/tok/sub/2.vtt?x=1", window), "https://node.test/m/tok/sub/2.vtt?x=1&start=90.0&end=190.0");
  assert.deepEqual(growingWindow(3), { start: 0, end: 93 });

  const cues = [cue(10, 12, "earlier"), cue(95, 97, "stale"), cue(185, 192, "edge"), cue(300, 302, "later")];
  // The answer reaches past the window's end, so the cue it spans is replaced too.
  const fresh = [cue(185, 193, "edge, longer"), cue(96, 98, "fixed")];
  assert.deepEqual(mergeWindow(cues, fresh, window).map((each) => each.text), ["earlier", "fixed", "edge, longer", "later"]);
  // An empty answer clears the window.
  assert.deepEqual(mergeWindow(cues, [], window).map((each) => each.text), ["earlier", "later"]);

  assert.equal(pollDue(null, 0, 0), true);
  assert.equal(pollDue({ at: 1_000, time: 50 }, 52, 3_000), false);
  assert.equal(pollDue({ at: 1_000, time: 50 }, 54, 5_000), true);
  assert.equal(pollDue({ at: 1_000, time: 50 }, 400, 1_500), true);
});
