import assert from "node:assert/strict";
import test from "node:test";

import { bufferState, droppedFrames, readStats, summarizeStats } from "../../src/telemetry/engine-stats.js";

// What the canvas engine's getStats() gives for an HLS stream, in part.
const canvasHls = {
  engine: "mediabunny",
  audioCurrentTime: 61_000,
  videoCurrentTime: 60_960,
  videoFrameRenderCount: 1_440,
  videoFrameDropCount: 3,
  audiocodec: "mp4a.40.2",
  videocodec: "avc1.640028",
  audioBufferedMs: 100,
  videoBufferedMs: 2_500,
  audioStutter: 2,
  hlsBufferedAheadSeconds: 24.5,
  hlsBufferCacheUtilization: 0.123456,
  hlsPlaylists: Array.from({ length: 10 }, (_, index) => ({ name: `video-${index}-${"x".repeat(60)}.m3u8`, current: index, segments: 300n })),
  hlsEvictions: { behind: 4, ahead: 0, bytes: 1_024 },
};

test("an engine that gives no stats, or fails to, has none", () => {
  assert.equal(readStats(null), null);
  assert.equal(readStats({}), null);
  assert.equal(readStats({ getStats: () => { throw new Error("closed"); } }), null);
  assert.deepEqual(readStats({ getStats: () => canvasHls }), canvasHls);
  assert.equal(summarizeStats(null), null);
});

test("the summary names times in milliseconds and the codecs as the log has them", () => {
  const summary = summarizeStats(canvasHls);
  assert.equal(summary.audioCurrentTimeMs, 61_000);
  assert.equal(summary.videoCurrentTimeMs, 60_960);
  assert.equal(summary.videoCodec, "avc1.640028");
  assert.equal(summary.audioCodec, "mp4a.40.2");
  assert.equal(summary.hlsBufferCacheUtilization, 0.123);
  // Numbers the engine does not give are null, not missing; the <video> engine's own fields only for it.
  assert.equal(summary.videoStutter, null);
  assert.equal("hlsLevels" in summary, false);
  const native = summarizeStats({ engine: "native", mode: "hls.js", adaptsWithinStream: true, hlsLevels: 4, timelineOffset: 12 });
  assert.deepEqual([native.engine, native.mode, native.adaptsWithinStream, native.hlsLevels, native.timelineOffset], ["native", "hls.js", true, 4, 12]);
});

test("the buffer is the HLS read-ahead, else the picture decoded ahead, with the sound in milliseconds", () => {
  const hls = bufferState(canvasHls);
  assert.equal(hls.bufferHealthSeconds, 24.5);
  // Milliseconds stay milliseconds, however small.
  assert.equal(hls.bufferedAudioMs, 100);
  assert.equal(hls.audioUnderrunCount, 2);
  assert.equal(hls.hlsPlaylists.length, 8);
  assert.equal(hls.hlsPlaylists[0].name.length, 40);
  assert.equal(hls.hlsPlaylists[0].segments, 300);
  assert.deepEqual(hls.hlsEvictions, { behind: 4, ahead: 0, bytes: 1_024 });

  const direct = bufferState({ ...canvasHls, hlsBufferedAheadSeconds: null, hlsPlaylists: null, hlsEvictions: null });
  assert.equal(direct.bufferHealthSeconds, 2.5);
  assert.equal(direct.hlsPlaylists, null);
  assert.equal(bufferState(null).bufferHealthSeconds, null);
});

test("dropped frames are the ones the engine decoded and never showed", () => {
  assert.equal(droppedFrames(canvasHls), 3);
  assert.equal(droppedFrames({}), null);
  assert.equal(droppedFrames(null), null);
});
