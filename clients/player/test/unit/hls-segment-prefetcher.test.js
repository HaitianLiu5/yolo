import assert from "node:assert/strict";
import test from "node:test";

import {
  cachedEntry,
  createPrefetcher,
  playlistBody,
  segment,
  TEST_ORIGIN,
  waitFor,
} from "../helpers/hls-fixture.js";
import { prefetchRequest } from "../../src/engine/hls-segment-prefetcher.js";

// The canvas engine's HLS read-ahead (Agent Note 2026-04-04-canvas-playback-engine):
// single-flight, bounded in time and bytes, and final only on playback's own refusals.

test("read-ahead is single-flight, stops at its time target, and marks its requests ?prefetch=1", async (t) => {
  let inFlight = 0;
  let maxInFlight = 0;
  const requested = [];
  const prefetcher = createPrefetcher({
    maxConcurrent: 1,
    ahead: 36,
    targetAheadSeconds: 12,
    fetchImpl: async (url) => {
      requested.push(url);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return new Response("bytes");
    },
  });
  t.after(() => prefetcher.destroy());
  const playlistUrl = `${TEST_ORIGIN}video.m3u8`;
  prefetcher.updatePlaylist(playlistBody(Array.from({ length: 10 }, (_, index) => segment(index, 4))), playlistUrl);
  prefetcher.playlists.get(playlistUrl).currentIndex = 0;
  prefetcher.scheduleAhead(playlistUrl, 1);
  await waitFor(() => prefetcher.getStats().readySegments === 3);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(requested, [1, 2, 3].map((index) => `${segment(index).url}?prefetch=1`));
  // The node tells read-ahead from playback by the query alone, on every origin.
  assert.deepEqual(prefetchRequest("https://lan.test:9443/m/token/l/0/5?a=1"), { url: "https://lan.test:9443/m/token/l/0/5?a=1&prefetch=1", headers: {} });
});

test("the ready cache trims the farthest segments to stay within its byte budget", () => {
  const prefetcher = createPrefetcher({ maxBytes: 6, maxConcurrent: 1 });
  prefetcher.segmentCache.set(segment(1).url, { ...cachedEntry("near"), index: 1 });
  prefetcher.segmentCache.set(segment(2).url, { ...cachedEntry("far!"), index: 2 });
  prefetcher.trimReadyCacheToBudget();
  assert.deepEqual([prefetcher.segmentCache.has(segment(1).url), prefetcher.segmentCache.has(segment(2).url), prefetcher.cachedBytes], [true, false, 4]);
});

test("playback's own 410 or 403 is final and asked once; an expired session is reported once", async (t) => {
  for (const [status, code] of [[410, "SESSION_EXPIRED"], [403, "UPSTREAM_ACCESS_DENIED"]]) {
    let requests = 0;
    const reported = [];
    const prefetcher = createPrefetcher({
      maxConcurrent: 0,
      retryBaseDelayMs: 1,
      onSessionExpired: (error) => reported.push(error.code),
      fetchImpl: async () => {
        requests += 1;
        return new Response("no", { status, headers: status === 410 ? { "X-Yolo-Error-Code": code } : {} });
      },
    });
    t.after(() => prefetcher.destroy());
    prefetcher.updatePlaylist(playlistBody([segment(0), segment(1)]), `${TEST_ORIGIN}video.m3u8`);
    const typed = (error) => error.code === code;
    await assert.rejects(prefetcher.fetch(segment(0).url), typed);
    await assert.rejects(prefetcher.fetch(segment(1).url), typed);
    assert.equal(requests, 1, code);
    assert.equal(prefetcher.retryTimer, null);
    assert.deepEqual(reported, status === 410 ? [code] : []);
  }
});

// Agent Note 2026-10-16-refused-read-ahead: a refused read-ahead is not the
// stream's end; stopping would leave a stall waiting forever.
test("a refused read-ahead is asked for again on its retry cycle, and playback gets the segment", async (t) => {
  const requests = [];
  let refusals = 2;
  const prefetcher = createPrefetcher({
    maxConcurrent: 1,
    retryBaseDelayMs: 1,
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.startsWith(segment(1).url) && refusals-- > 0) return new Response("denied", { status: 403 });
      return new Response(`bytes of ${new URL(url).pathname}`);
    },
  });
  t.after(() => prefetcher.destroy());
  prefetcher.updatePlaylist(playlistBody([segment(0), segment(1), segment(2)]), `${TEST_ORIGIN}audio.m3u8`);
  await prefetcher.fetch(segment(0).url);
  await waitFor(() => prefetcher.segmentCache.has(segment(1).url) && prefetcher.segmentCache.has(segment(2).url));
  assert.equal(requests.filter((url) => url.startsWith(segment(1).url)).length, 3, "refused twice, then read");
  assert.equal(await (await prefetcher.fetch(segment(1).url)).text(), "bytes of /1.m4s");
});
