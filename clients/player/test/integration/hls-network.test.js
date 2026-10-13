import assert from "node:assert/strict";
import test from "node:test";

import { MediabunnyPlayer } from "../../src/engine/mediabunny-player.js";
import {
  createPrefetcher,
  playlistBody,
  segment,
  waitFor,
} from "../helpers/hls-fixture.js";

test("a timed-out prefetch releases the queue for later segments", async (t) => {
  const requested = [];
  let firstSegmentAttempts = 0;
  const prefetcher = createPrefetcher({
    inactivityTimeoutMs: 10,
    maxRetries: 0,
    retryBaseDelayMs: 5,
    retryCycleMaxDelayMs: 10,
    fetchImpl: (url, { signal } = {}) => {
      requested.push(url);
      if (url.endsWith("/1.m4s") && firstSegmentAttempts++ === 0) {
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return Promise.resolve(new Response(url.endsWith("/1.m4s") ? "one" : "two", {
        headers: { "content-type": "video/mp4" },
      }));
    },
  });
  t.after(() => prefetcher.destroy());
  const playlistUrl = "https://yolo.test/video.m3u8";
  const segments = [segment(0), segment(1), segment(2)];
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  prefetcher.playlists.get(playlistUrl).currentIndex = 0;

  prefetcher.scheduleAhead(playlistUrl, 1);
  await waitFor(() => prefetcher.getStats().readySegments === 2);

  const stats = prefetcher.getStats();
  assert.deepEqual(requested, [segments[1].url, segments[2].url, segments[1].url]);
  assert.equal(stats.activeDownloads, 0);
  assert.equal(stats.queuedSegments, 0);
  assert.equal(stats.retryWaitingSegments, 0);
  assert.equal(stats.timeoutCount, 1);
  assert.equal(stats.failureCount, 1);
  assert.equal(stats.completedDownloads, 2);
});

test("a foreground segment or playlist fails within the inactivity deadline", async (t) => {
  const prefetcher = createPrefetcher({
    inactivityTimeoutMs: 10,
    maxRetries: 0,
    retryBaseDelayMs: 5,
    fetchImpl: (_url, { signal } = {}) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  t.after(() => prefetcher.destroy());
  const playlistUrl = "https://yolo.test/video.m3u8";
  const segments = [segment(0)];
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);

  await assert.rejects(
    prefetcher.fetch(segments[0].url),
    (error) => error.code === "HLS_SEGMENT_FETCH_FAILED",
  );
  assert.equal(prefetcher.getStats().timeoutCount, 1);
  await assert.rejects(prefetcher.fetch(playlistUrl), /made no network progress/);
  assert.equal(prefetcher.getStats().timeoutCount, 2);
  assert.match(prefetcher.getStats().lastFailure.error, /made no network progress/);
});

test("continuous body progress prevents a false inactivity timeout", async (t) => {
  const prefetcher = createPrefetcher({
    inactivityTimeoutMs: 10,
    maxRetries: 0,
    fetchImpl: async () => new Response(new ReadableStream({
      async start(controller) {
        for (const value of [1, 2, 3, 4]) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          controller.enqueue(Uint8Array.of(value));
        }
        controller.close();
      },
    }), { headers: { "content-type": "video/mp4" } }),
  });
  t.after(() => prefetcher.destroy());
  const playlistUrl = "https://yolo.test/video.m3u8";
  const segments = [segment(0)];
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);

  const response = await prefetcher.fetch(segments[0].url);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(prefetcher.getStats().timeoutCount, 0);
});

// Mediabunny's own policy retried every failed fetch forever, so the player
// never saw the error and never recovered or left the LAN origin.
test("the canvas engine gives up on a segment the prefetcher could not get", async (t) => {
  const saved = { fetch: globalThis.fetch, location: globalThis.location };
  t.after(() => Object.assign(globalThis, saved));
  globalThis.location = new URL("https://yolo.test/play");
  const lanOrigin = "https://lan.test";
  const segmentFetches = [];
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    if (url.endsWith(".m3u8")) return new Response("#EXTM3U\n#EXTINF:5,\n0.m4s\n#EXTINF:5,\n1.m4s\n#EXT-X-ENDLIST\n");
    segmentFetches.push(url);
    // The source denies a segment; the LAN origin went away with the car.
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
  // One request for the 403; the LAN segment's three are the prefetcher's own bounded tries.
  assert.equal(segmentFetches.filter((url) => url.endsWith("/0.m4s")).length, 4);

  // A download a seek cancelled did not fail: no code, so the engine asks again.
  const prefetcher = createPrefetcher({
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  });
  t.after(() => prefetcher.destroy());
  prefetcher.updatePlaylist(playlistBody([segment(0), segment(1)]), "https://yolo.test/video.m3u8");
  const cancelled = prefetcher.fetch(segment(0).url);
  await waitFor(() => prefetcher.getStats().activeDownloads === 1);
  prefetcher.handleSeek(5);
  await assert.rejects(cancelled, (error) => error.code === undefined);
});
