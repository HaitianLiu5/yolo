import assert from "node:assert/strict";
import test from "node:test";

import { DecoderProbe } from "../../src/engine/decoder-probe.js";
import { MediabunnyPlayer } from "../../src/engine/mediabunny-player.js";
import { cachedEntry, createPrefetcher, playlistBody, segment, TEST_ORIGIN } from "../helpers/hls-fixture.js";

// A canvas engine failure tells which decoder failed and where
// (Agent Note 2026-10-11-device-telemetry): Chrome's video and audio
// decoders both say only "Decoding error.".

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
