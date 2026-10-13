import assert from "node:assert/strict";
import test from "node:test";
import { MediabunnyPlayer } from "../../src/engine/mediabunny-player.js";
import { LatestOperation } from "../../src/latest-operation.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function createRestartHarness(oldIterator) {
  const player = Object.create(MediabunnyPlayer.prototype);
  Object.assign(player, {
    generation: 0,
    destroyed: false,
    producerRestarts: new LatestOperation(),
    videoIterator: oldIterator,
    audioIterator: null,
    videoQueue: [],
    videoQueueCapacity: 6,
    videoTrack: {},
    audioTrack: null,
    audioRing: null,
    firstVideoRendered: true,
    iteratorCloseTimeoutCount: 0,
    hlsSegmentPrefetcher: null,
    clock: {
      useAudioRing: (ring, sampleRate) => { player.clockSource = { ring, sampleRate }; },
      reset: (time) => { player.resetTime = time; },
    },
  });
  player.createdTargets = [];
  player.startedProducers = [];
  player.videoSink = {
    canvases: (target) => {
      player.createdTargets.push(target);
      return { next: async () => ({ done: true }) };
    },
  };
  player.audioSink = null;
  player.produceVideo = async (generation, iterator) => {
    player.startedProducers.push({ generation, iterator });
  };
  return player;
}

test("rapid producer restarts publish only the latest seek", async () => {
  const cleanup = deferred();
  let closeCount = 0;
  const oldIterator = {
    return: async () => {
      closeCount += 1;
      await cleanup.promise;
    },
  };
  const player = createRestartHarness(oldIterator);

  const first = player.restartProducers(10);
  await Promise.resolve();
  const second = player.restartProducers(20);
  cleanup.resolve();

  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(closeCount, 1);
  assert.deepEqual(player.createdTargets, [20]);
  assert.equal(player.resetTime, 20);
  assert.deepEqual(player.clockSource, { ring: null, sampleRate: 0 });
  assert.equal(player.startedProducers.length, 1);
});

test("video producer reads only from its captured iterator", async () => {
  const player = Object.create(MediabunnyPlayer.prototype);
  Object.assign(player, {
    generation: 1,
    destroyed: false,
    videoQueue: [],
    videoQueueCapacity: 6,
    videoDecodeCount: 0,
    videoEnded: false,
    videoIterator: { next: async () => { throw new Error("wrong iterator"); } },
    waitForVideoFault: async () => {},
    fail: (error) => { throw error; },
  });
  let reads = 0;
  const iterator = {
    next: async () => {
      reads += 1;
      if (reads === 1) return { done: false, value: { duration: 1 / 60 } };
      return { done: true };
    },
  };

  await player.produceVideo(1, iterator);
  assert.equal(player.videoDecodeCount, 1);
  assert.equal(player.videoEnded, true);
});

test("live-edge seek preserves the encoded HLS buffer", async () => {
  const player = Object.create(MediabunnyPlayer.prototype);
  player.firstTimestamp = 0;
  player.duration = 120;
  player.wantsPlayback = false;
  player.audioRing = { setRunning() {} };
  player.clock = { stop() {} };
  player.setState = () => {};
  const resetRequests = [];
  player.restartProducers = async (_target, options) => {
    resetRequests.push(options);
    return true;
  };

  await player.seek(1_000, { preserveHlsBuffer: true });
  await player.seek(2_000);

  assert.deepEqual(resetRequests, [
    { resetHlsBuffer: false, hlsSeekTarget: 1 },
    { resetHlsBuffer: true, hlsSeekTarget: 2 },
  ]);
});

test("seekable range exposes the resumed media timeline start", () => {
  const player = Object.create(MediabunnyPlayer.prototype);
  player.firstTimestamp = 11_622;
  player.duration = 14_299;

  assert.deepEqual(player.getSeekableRange(), {
    start: 11_622,
    end: 14_299,
  });
});

// The canvas engine's buffer (Agent Note 2026-04-04-canvas-playback-engine):
// one HLS download at a time, about 210 seconds ahead, within 128 MiB.
test("the player's HLS prefetch is single-flight and buffers 210 seconds within 128 MiB", (t) => {
  const hadLocation = "location" in globalThis;
  globalThis.location ??= new URL("https://yolo.test/");
  t.after(() => { if (!hadLocation) delete globalThis.location; });
  const player = Object.create(MediabunnyPlayer.prototype);
  player.createInput("/m/token/p/0.m3u8", { prefetchHls: true });
  const prefetcher = player.hlsSegmentPrefetcher;
  t.after(() => prefetcher.destroy());
  assert.deepEqual(
    [prefetcher.maxConcurrent, prefetcher.targetAheadSeconds, prefetcher.ahead, prefetcher.maxBytes],
    [1, 210, 90, 128 * 1024 * 1024],
  );
});
