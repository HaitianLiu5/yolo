import assert from "node:assert/strict";
import test from "node:test";

import { createHeldStallWatch } from "../../src/held-stall.js";

const held = (audioCurrentTimeMs, on = {}) => ({
  audioCurrentTimeMs, hlsActiveDownloads: 0, hlsPendingSegments: 0, hlsQueuedSegments: 0, hlsRetryWaitingSegments: 0, ...on,
});

test("a stream held for 20 seconds with nothing on its way is a held stall, said once", () => {
  const watch = createHeldStallWatch();
  const watching = true;
  assert.equal(watch.check(held(5_000), { watching, now: 1_000 }), null);
  assert.equal(watch.check(held(5_000), { watching, now: 2_000 }), null);
  assert.equal(watch.check(held(5_000), { watching, now: 21_000 }), null);
  assert.deepEqual(watch.check(held(5_000), { watching, now: 22_000 }), { positionMs: 5_000, heldForMs: 20_000 });
  assert.equal(watch.check(held(5_000), { watching, now: 23_000 }), null);
});

test("a download on its way, a moving position, or a stream not held starts the count again", () => {
  for (const [stats, watching] of [
    [held(5_000, { hlsActiveDownloads: 1 }), true],
    [held(5_000, { hlsRetryWaitingSegments: 1 }), true],
    [held(6_000), true],
    [held(5_000), false],
  ]) {
    const watch = createHeldStallWatch();
    const at = stats.audioCurrentTimeMs;
    watch.check(held(5_000), { watching: true, now: 1_000 });
    assert.equal(watch.check(stats, { watching, now: 15_000 }), null);
    assert.equal(watch.check(held(at), { watching: true, now: 20_000 }), null);
    assert.equal(watch.check(held(at), { watching: true, now: 35_000 }), null);
    assert.ok(watch.check(held(at), { watching: true, now: 40_000 }));
  }
});

test("another engine's stream, with no read-ahead to report, is not watched; a new stream starts with nothing seen", () => {
  const watch = createHeldStallWatch();
  assert.equal(watch.check({ audioCurrentTimeMs: 5_000, hlsActiveDownloads: null }, { watching: true, now: 1_000 }), null);
  assert.equal(watch.check({ audioCurrentTimeMs: 5_000, hlsActiveDownloads: null }, { watching: true, now: 60_000 }), null);
  assert.equal(watch.check(null, { watching: true, now: 90_000 }), null);
  watch.check(held(5_000), { watching: true, now: 100_000 });
  watch.check(held(5_000), { watching: true, now: 101_000 });
  watch.reset();
  assert.equal(watch.check(held(5_000), { watching: true, now: 125_000 }), null);
});
