import assert from "node:assert/strict";
import test from "node:test";

import { MediabunnyPlayer } from "../../src/engine/mediabunny-player.js";
import { createPrefetcher, playlistBody, segment, waitFor } from "../helpers/hls-fixture.js";

// The canvas engine's buffers (Agent Note 2026-04-04-canvas-playback-engine):
// network jitter is buffered as encoded segments, one HLS download at a time,
// about 210 seconds ahead within 128 MiB; decoded frames stay few.

test("the player's HLS prefetch is single-flight and buffers 210 seconds within 128 MiB", (t) => {
  const hadLocation = "location" in globalThis;
  globalThis.location ??= new URL("https://yolo.test/");
  t.after(() => { if (!hadLocation) delete globalThis.location; });
  const player = Object.create(MediabunnyPlayer.prototype);
  player.createInput("/m/token/p/0.m3u8", { prefetchHls: true });
  const prefetcher = player.hlsSegmentPrefetcher;
  t.after(() => prefetcher.destroy());
  assert.deepEqual(
    [prefetcher.maxConcurrent, prefetcher.targetAheadSeconds, prefetcher.maxBytes],
    [1, 210, 128 * 1024 * 1024],
  );
});

test("the decoded video queue stops at its bound, however short the frames", async () => {
  const player = Object.create(MediabunnyPlayer.prototype);
  Object.assign(player, {
    generation: 1, trackRuns: { video: 0 }, destroyed: false, videoQueue: [], videoQueueCapacity: 6, videoDecodeCount: 0,
    waitForVideoFault: async () => {}, handleTrackFailure: (error) => { throw error; },
  });
  let reads = 0;
  const producing = player.produceVideo(1, 0, { next: async () => { reads += 1; return { done: false, value: { duration: 0.001 } }; } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual([player.videoQueue.length, reads], [16, 16]);
  player.generation = 2;
  await producing;
});

test("a hung read-ahead times out and frees the single download slot", async (t) => {
  const requested = [];
  let hung = true;
  const prefetcher = createPrefetcher({
    inactivityTimeoutMs: 10,
    maxConcurrent: 1,
    maxRetries: 0,
    retryBaseDelayMs: 5,
    retryCycleMaxDelayMs: 10,
    fetchImpl: (url, { signal } = {}) => {
      requested.push(new URL(url).pathname);
      if (url.includes("/1.m4s") && hung) {
        hung = false;
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return Promise.resolve(new Response("bytes"));
    },
  });
  t.after(() => prefetcher.destroy());
  const playlistUrl = "https://yolo.test/video.m3u8";
  prefetcher.updatePlaylist(playlistBody([segment(0), segment(1), segment(2)]), playlistUrl);
  prefetcher.playlists.get(playlistUrl).currentIndex = 0;
  prefetcher.scheduleAhead(playlistUrl, 1);
  await waitFor(() => prefetcher.getStats().readySegments === 2);
  assert.deepEqual(requested, ["/1.m4s", "/2.m4s", "/1.m4s"]);
  assert.equal(prefetcher.getStats().timeoutCount, 1);
});

// Mediabunny's own policy retried every failed fetch forever, so the player
// never saw the error and never recovered or left the LAN origin.
test("the canvas engine gives up on a segment the prefetcher could not get", async (t) => {
  const saved = { fetch: globalThis.fetch, location: globalThis.location };
  t.after(() => Object.assign(globalThis, saved));
  globalThis.location = new URL("https://yolo.test/play");
  const lanOrigin = "https://lan.test";
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    if (url.endsWith(".m3u8")) return new Response("#EXTM3U\n#EXTINF:5,\n0.m4s\n#EXTINF:5,\n1.m4s\n#EXT-X-ENDLIST\n");
    if (url.startsWith(lanOrigin)) throw new TypeError("Failed to fetch");
    return new Response("denied", { status: 403 });
  };
  for (const [origin, code] of [["https://yolo.test", "UPSTREAM_ACCESS_DENIED"], [lanOrigin, "HLS_SEGMENT_FETCH_FAILED"]]) {
    const player = Object.create(MediabunnyPlayer.prototype);
    const input = player.createInput(`${origin}/m/token/p/0.m3u8`, { prefetchHls: true });
    t.after(() => player.hlsSegmentPrefetcher.destroy());
    let timer;
    const gaveUp = await Promise.race([
      input.getTracks().then(() => null, (error) => error.code),
      new Promise((resolve) => { timer = setTimeout(() => resolve("still retrying"), 4_000); }),
    ]);
    clearTimeout(timer);
    assert.equal(gaveUp, code, origin);
  }
});
