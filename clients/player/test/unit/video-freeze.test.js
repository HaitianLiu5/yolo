import assert from "node:assert/strict";
import test from "node:test";

import { createFreezeWatch } from "../../src/video-freeze.js";

const frame = (videoCurrentTimeMs, audioCurrentTimeMs) => ({ videoCodec: "avc1", videoFrameRenderCount: 100, videoCurrentTimeMs, audioCurrentTimeMs });

test("a picture that stops for 8 seconds while the sound runs 5 seconds ahead is a freeze, said once", () => {
  const watch = createFreezeWatch();
  const watching = true;
  assert.equal(watch.check(frame(10_000, 10_000), { watching, now: 1_000 }), null);
  // The sound goes on, the picture stays: not yet 8 seconds.
  assert.equal(watch.check(frame(10_000, 15_500), { watching, now: 8_000 }), null);
  assert.deepEqual(watch.check(frame(10_000, 18_200), { watching, now: 9_200 }), { videoCurrentTimeMs: 10_000, audioCurrentTimeMs: 18_200, frozenForMs: 8_200, driftMs: 8_200 });
  assert.equal(watch.check(frame(10_000, 20_000), { watching, now: 11_000 }), null);
  // A frame shown again ends it; the next freeze is said again.
  assert.equal(watch.check(frame(20_100, 20_100), { watching, now: 12_000 }), null);
  assert.ok(watch.check(frame(20_100, 30_000), { watching, now: 20_500 }));
});

test("a picture held with its sound, a paused or hidden page, or a stream without picture is no freeze", () => {
  const watch = createFreezeWatch();
  watch.check(frame(10_000, 10_000), { watching: true, now: 1_000 });
  // Both stopped (a stall): no drift.
  assert.equal(watch.check(frame(10_000, 10_000), { watching: true, now: 20_000 }), null);
  // Not watching starts the count again.
  assert.equal(watch.check(frame(10_000, 30_000), { watching: false, now: 30_000 }), null);
  assert.equal(watch.check(frame(10_000, 30_000), { watching: true, now: 35_000 }), null);
  assert.equal(watch.check({ videoCodec: null, videoCurrentTimeMs: 0, audioCurrentTimeMs: 60_000 }, { watching: true, now: 90_000 }), null);
  assert.equal(watch.check(null, { watching: true, now: 99_000 }), null);
});

test("a new stream starts with nothing seen", () => {
  const watch = createFreezeWatch();
  watch.check(frame(10_000, 10_000), { watching: true, now: 1_000 });
  watch.reset();
  // The first check after a reset only notes where the picture is.
  assert.equal(watch.check(frame(5_000, 20_000), { watching: true, now: 50_000 }), null);
  assert.ok(watch.check(frame(5_000, 20_000), { watching: true, now: 58_000 }));
});
