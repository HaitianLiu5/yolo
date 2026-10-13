import assert from "node:assert/strict";
import test from "node:test";

import { getPlaybackEndReason } from "../../src/engine/playback-end.js";

test("finishes when the advertised duration boundary is reached", () => {
  assert.equal(getPlaybackEndReason({
    duration: 433,
    mediaTime: 432.981,
    hasAudio: true,
    hasVideo: true,
    audioEnded: false,
    videoEnded: false,
    audioBufferedSeconds: 1,
    videoBufferedSeconds: 1,
  }), "duration-boundary");
});

test("live playback ignores the temporary playlist duration boundary", () => {
  assert.equal(getPlaybackEndReason({
    duration: 1784504669.105,
    mediaTime: 1784504669.105,
    hasAudio: true,
    hasVideo: true,
    audioEnded: false,
    videoEnded: false,
    audioBufferedSeconds: 3,
    videoBufferedSeconds: 0.2,
    ignoreDurationBoundary: true,
  }), null);
});

test("finishes a rounded duration only once both decoded sources drain", () => {
  const tail = {
    duration: 433, mediaTime: 432.95691609977325, hasAudio: true, hasVideo: true,
    audioEnded: true, videoEnded: true, audioBufferedSeconds: 0.002, videoBufferedSeconds: 0,
  };
  assert.equal(getPlaybackEndReason(tail), "sources-drained");
  assert.equal(getPlaybackEndReason({ ...tail, videoEnded: false }), null, "the video decoder can still produce frames");
  assert.equal(getPlaybackEndReason({ ...tail, videoBufferedSeconds: 0.2 }), null, "a decoded tail still plays");
});
