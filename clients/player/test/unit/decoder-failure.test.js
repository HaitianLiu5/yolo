import assert from "node:assert/strict";
import test from "node:test";

import { DecoderProbe } from "../../src/engine/decoder-probe.js";
import { DecoderRecovery, isDecoderError, LADDER_WINDOW_MS } from "../../src/engine/decoder-recovery.js";
import { MediabunnyPlayer } from "../../src/engine/mediabunny-player.js";
import { cachedEntry, createPrefetcher, playlistBody, segment, TEST_ORIGIN } from "../helpers/hls-fixture.js";

// A canvas engine failure tells which decoder failed and where
// (Agent Note 2026-10-11-device-telemetry): Chrome's video and audio
// decoders both say only "Decoding error.". A decoder's failure is
// recovered in place before any new stream (Agent Note
// 2026-04-04-canvas-playback-engine).

// A Mediabunny sample sink as decoder-probe.js finds it, with a WebCodecs
// decoder that fails on demand.
function fakeSampleSink() {
  const sink = {
    async _createDecoder(onSample, onError) {
      const decoder = { state: "configured", decodeQueueSize: 2 };
      sink.output = (timestamp) => onSample({ timestamp });
      sink.failDecoder = (error) => {
        decoder.state = "closed";
        onError(error);
      };
      return { decoder, decode() {} };
    },
  };
  return sink;
}

test("a canvas engine failure names its decoder, the last packet, and that packet's segment", async (t) => {
  const sink = fakeSampleSink();
  const video = new DecoderProbe();
  assert.equal(video.attach({ _videoSampleSink: sink }), true);
  // Without Mediabunny's shape there is nothing to describe, and no error.
  const missing = new DecoderProbe();
  assert.deepEqual([missing.attach({}), missing.describe()], [false, null]);

  const wrapper = await sink._createDecoder(() => {}, () => {});
  wrapper.decode({ timestamp: 968, type: "key", byteLength: 41_000 });
  sink.output(968);
  wrapper.decode({ timestamp: 970.0333, type: "delta", byteLength: 900 });
  const error = new Error("Decoding error.");
  error.name = "EncodingError";
  sink.failDecoder(error);

  // A Plex stream from 656 s in 8-second segments; reads reached segment 40.
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  t.after(() => prefetcher.destroy());
  const playlistUrl = `${TEST_ORIGIN}1.m3u8`;
  const segments = Array.from({ length: 45 }, (_, index) => segment(index, 8));
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  prefetcher.playlists.get(playlistUrl).currentIndex = 40;
  prefetcher.segmentCache.set(segments[39].url, { ...cachedEntry("ts bytes"), index: 39, playlistUrl });

  const states = [];
  const errors = [];
  const player = Object.create(MediabunnyPlayer.prototype);
  Object.assign(player, {
    state: "playing",
    clock: { currentTime: 970, stop() {} },
    firstTimestamp: 656,
    decoderProbes: { video, audio: new DecoderProbe() },
    hlsSegmentPrefetcher: prefetcher,
    onStateChange: (state, detail) => states.push([state, detail]),
    onError: (failed) => errors.push(failed),
  });
  t.mock.method(console, "log", () => {});
  player.fail(error, { track: "video" });

  const [[state, detail]] = states;
  assert.equal(state, "error");
  assert.equal(detail.error, "Decoding error.");
  assert.deepEqual({ ...detail.failure, decoder: { ...detail.failure.decoder, decoderAgeMs: 0 } }, {
    track: "video",
    name: "EncodingError",
    code: null,
    stack: detail.failure.stack,
    decoder: {
      reportedError: true,
      decoderState: "closed",
      decodeQueueSize: 2,
      decoderAgeMs: 0,
      packets: 2,
      frames: 1,
      lastPacketTimestamp: 970.033,
      lastPacketKey: false,
      lastPacketBytes: 900,
      lastFrameTimestamp: 968,
    },
    segments: [{ playlist: "1.m3u8", index: 39, bytes: 8, readIndex: 40 }],
  });
  assert.match(detail.failure.stack, /^at /);
  // playback_recovery_scheduled carries the same description, for this error only.
  assert.deepEqual([errors, player.getFailure(error), player.getFailure(new Error("other"))], [[error], detail.failure, null]);
});

test("a failed decoder climbs the ladder in place, one step per failure at the same place, and only its last step is a new stream", () => {
  // What climbs the ladder: the decoder's own error, or its names and
  // message; the network's and the session's coded errors keep the
  // player's recovery.
  const decoderError = Object.assign(new Error("Decoding error."), { name: "EncodingError" });
  const cases = [
    [decoderError, null, true],
    [new Error("Codec reclaimed due to inactivity."), { reportedError: true }, true],
    [new Error("Decoding error."), null, true],
    [Object.assign(new Error("Decoding error."), { code: "SESSION_EXPIRED" }), { reportedError: true }, false],
    [Object.assign(new Error("HLS segment network fetch failed after bounded retries"), { code: "HLS_SEGMENT_FETCH_FAILED" }), null, false],
    [new TypeError("Failed to fetch"), { reportedError: false }, false],
  ];
  for (const [error, decoder, expected] of cases) assert.equal(isDecoderError(error, decoder), expected, error.message);

  let now = 0;
  const recovery = new DecoderRecovery({ now: () => now });
  const step = (plan) => plan && [plan.step, plan.action, plan.deadlineMs];
  const ended = (plan) => plan.ended && [plan.ended.step, plan.ended.outcome, plan.ended.elapsedMs, plan.ended.sinceFailureMs];

  // The picture's decoder fails at 970.033 s: a new decoder from the buffer.
  const first = recovery.fail("video", { at: 970.033, detail: { failure: "first" } });
  assert.deepEqual([step(first), first.ended], [[1, "restart", 4_000], null]);
  // Its frames before that place do not close the ladder; failing again
  // before it gets past it is the same failure: refetch and software.
  now = 100;
  assert.deepEqual(recovery.asked("video"), { token: first.token, deadlineMs: 4_000 }, "its deadline starts once it is asked");
  now = 300;
  assert.equal(recovery.output("video", 969.9), null);
  assert.equal(recovery.waiting("video", first.token), false, "it gave something out in time");
  const second = recovery.fail("video", { at: 969.95 });
  assert.deepEqual([step(second), ended(second), second.at], [[2, "refetch_software", 15_000], [1, "failed", 300, 300], 970.033]);
  // Nothing out by the deadline is a failure too: skip to the next key frame.
  now = 15_300;
  assert.equal(recovery.waiting("video", second.token), true);
  const third = recovery.fail("video", { at: null, cause: "timeout" });
  assert.deepEqual([step(third), ended(third)], [[3, "skip_to_key", 8_000], [2, "timeout", 15_000, 15_300]]);
  // The sound's ladder is its own.
  const sound = recovery.fail("audio", { at: 970.5 });
  assert.equal(sound.step, 1);
  // A third failure at the place: a new stream, and the ladder closes.
  now = 15_500;
  const fourth = recovery.fail("video", { at: 971 });
  assert.deepEqual([step(fourth), ended(fourth), recovery.ladders.video], [[4, "new_stream", null], [3, "failed", 200, 15_500], null]);
  // The sound decodes past its place: recovered, with how long its step took.
  now = 15_620;
  assert.deepEqual(recovery.output("audio", 970.52), {
    step: 1, action: "restart", track: "audio", at: 970.5, cause: "error", outcome: "recovered", elapsedMs: 320, firstOutputMs: 320, sinceFailureMs: 320, detail: null,
  });

  // Decoders that keep failing at new places are not healed by restarts:
  // a fourth ladder in ten minutes goes straight to a new stream.
  assert.equal(recovery.fail("video", { at: 1_200 }).step, 1, "the third ladder");
  assert.equal(recovery.output("video", 1_200.04).outcome, "recovered");
  assert.equal(recovery.fail("video", { at: 1_300 }).step, 4, "a fourth");
  now += LADDER_WINDOW_MS;
  const later = recovery.fail("video", { at: 1_800 });
  assert.equal(later.step, 1);
  // A seek leaves the place behind: the next failure opens a new ladder.
  recovery.reset();
  assert.equal(recovery.fail("video", { at: 1_800.1 }).step, 1);
});
