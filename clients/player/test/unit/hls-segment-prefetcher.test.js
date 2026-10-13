import assert from "node:assert/strict";
import test from "node:test";

import {
  cachedEntry,
  createPrefetcher,
  playlistBody,
  segment,
  TEST_ORIGIN,
} from "../helpers/hls-fixture.js";
import { prefetchRequest } from "../../src/engine/hls-segment-prefetcher.js";

test("an expired Plex session reports once, stops the old playlist, and keeps its typed error", async (t) => {
  let requests = 0;
  const reported = [];
  const prefetcher = createPrefetcher({ maxConcurrent: 0,
    onSessionExpired: (error) => reported.push(error.code),
    fetchImpl: async () => { requests++; return new Response("expired", {
      status: 410, headers: { "X-Yolo-Error-Code": "SESSION_EXPIRED" },
    }); },
  });
  t.after(() => prefetcher.destroy());
  const playlist = `${TEST_ORIGIN}old.m3u8`;
  prefetcher.updatePlaylist(playlistBody([segment(0), segment(1)]), playlist);
  const expired = (error) => error.code === "SESSION_EXPIRED";
  await assert.rejects(prefetcher.fetch(segment(0).url), expired);
  await assert.rejects(prefetcher.fetch(segment(1).url), expired);
  assert.equal(requests, 1);
  assert.deepEqual(reported, ["SESSION_EXPIRED"]);
  assert.equal(prefetcher.retryTimer, null);
  // The playlist itself keeps the typed error the player recovers from.
  await assert.rejects(prefetcher.fetch(playlist), expired);
});

test("a denied segment stops retry cycles and further prefetch for that playlist", async (t) => {
  let requests = 0;
  const prefetcher = createPrefetcher({
    maxConcurrent: 0,
    retryBaseDelayMs: 1,
    fetchImpl: async () => { requests += 1; return new Response("denied", { status: 403 }); },
  });
  t.after(() => prefetcher.destroy());
  const playlistUrl = `${TEST_ORIGIN}video.m3u8`;
  prefetcher.updatePlaylist(playlistBody([segment(0), segment(1)]), playlistUrl);
  const denied = (error) => error.code === "UPSTREAM_ACCESS_DENIED";
  await assert.rejects(prefetcher.fetch(segment(0).url), denied);
  assert.equal(prefetcher.jobs.get(segment(0).url).state, "failed");
  prefetcher.maxConcurrent = 1;
  prefetcher.scheduleAhead(playlistUrl, 1);
  prefetcher.pumpPrefetches();
  await assert.rejects(prefetcher.fetch(segment(0).url), denied);
  await assert.rejects(prefetcher.fetch(segment(1).url), denied);
  assert.equal(requests, 1);
  assert.equal(prefetcher.networkRetryCount, 0);
  assert.equal(prefetcher.retryTimer, null);

  // A repaired source uses a new playlist URL, which is not poisoned by the
  // failure of the previous session.
  prefetcher.maxConcurrent = 0;
  prefetcher.fetchImpl = async () => new Response("repaired");
  const fresh = { url: `${TEST_ORIGIN}fresh/0.m4s`, duration: 5 };
  prefetcher.updatePlaylist(playlistBody([fresh]), `${TEST_ORIGIN}fresh/video.m3u8`);
  assert.equal(await (await prefetcher.fetch(fresh.url)).text(), "repaired");
});

test("buffer health stops at the first missing segment", () => {
  const prefetcher = createPrefetcher();
  const segments = [segment(0), segment(1), segment(2), segment(3)];
  const playlistUrl = "https://yolo.test/video.m3u8";
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  prefetcher.playlists.get(playlistUrl).currentIndex = 0;
  prefetcher.jobs.set(segment(1).url, { state: "pending" });
  prefetcher.segmentCache.set(segment(2).url, cachedEntry("two"));
  prefetcher.segmentCache.set(segment(3).url, cachedEntry("three"));

  const stats = prefetcher.getStats();
  assert.equal(stats.bufferedAheadSeconds, 0);
  assert.equal(stats.readySegments, 0);
  assert.equal(stats.pendingSegments, 1);
});

test("a fetched media playlist registers its extensionless proxied segments; a master playlist registers none", async () => {
  const prefetcher = createPrefetcher({
    maxConcurrent: 0,
    fetchImpl: async () => new Response(
      "#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.0,\n/m/token/f/100\n#EXTINF:5.0,\n/m/token/f/101\n",
      { headers: { "content-type": "application/vnd.apple.mpegurl" } },
    ),
  });
  prefetcher.updatePlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\n/m/token/p/1.m3u8\n", "https://yolo.test/m/token/p/0.m3u8");
  assert.equal(prefetcher.playlists.size, 0);

  await prefetcher.fetch("https://yolo.test/m/token/p/1.m3u8");
  assert.deepEqual(prefetcher.playlists.get("https://yolo.test/m/token/p/1.m3u8").segments, [
    { url: "https://yolo.test/m/token/f/100", duration: 5 },
    { url: "https://yolo.test/m/token/f/101", duration: 5 },
  ]);
  assert.equal(prefetcher.segmentIndexes.size, 2);
});

test("reports the absolute DVR timeline from the node's live tags", () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  const playlistUrl = "https://yolo.test/m/token/p/2.m3u8";
  prefetcher.updatePlaylist(
    "#EXTM3U\n#EXT-X-YOLO-DVR-START:1000\n#EXT-X-YOLO-LIVE-EDGE:4600\n#EXTINF:2,\n/m/token/l/2/100\n",
    playlistUrl,
  );
  const playlist = prefetcher.playlists.get(playlistUrl);
  prefetcher.advancePlaylist(playlist, 0, playlist.segments[0].url);

  const stats = prefetcher.getStats();
  assert.equal(stats.liveDvrStartTime, 1000);
  assert.ok(stats.liveEdgeTime >= 4600);
});

test("seek preserves completed media and recenters pending work", () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  const playlistUrl = "https://yolo.test/video.m3u8";
  const segments = Array.from({ length: 8 }, (_, index) => segment(index, 5));
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  const playlist = prefetcher.playlists.get(playlistUrl);
  playlist.currentIndex = 6;
  playlist.currentUrl = segments[6].url;
  prefetcher.segmentCache.set(segments[1].url, {
    ...cachedEntry("played"),
    url: segments[1].url,
    playlistUrl,
    index: 1,
  });
  const obsoleteJob = {
    url: segments[7].url,
    playlistUrl,
    index: 7,
    state: "queued",
    controller: null,
  };
  prefetcher.jobs.set(segments[7].url, obsoleteJob);

  prefetcher.handleSeek(7);

  assert.equal(playlist.currentIndex, 0);
  assert.equal(playlist.currentUrl, segments[0].url);
  assert.equal(prefetcher.segmentCache.has(segments[1].url), true);
  assert.notEqual(prefetcher.jobs.get(segments[7].url), obsoleteJob);
  assert.deepEqual(
    [...prefetcher.jobs.values()].map((entry) => entry.index),
    [2, 3, 4, 5, 6, 7],
  );
  assert.equal(prefetcher.getStats().activePlaylistCount, 1);
});

test("live seek maps absolute time from the first program timestamp", () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  const playlistUrl = "https://yolo.test/live.m3u8";
  prefetcher.updatePlaylist([
    "#EXTM3U",
    "#EXT-X-PROGRAM-DATE-TIME:2026-07-21T00:00:00.000Z",
    "#EXTINF:5,",
    "0.m4s",
    "#EXT-X-PROGRAM-DATE-TIME:2026-07-21T00:00:05.000Z",
    "#EXTINF:5,",
    "1.m4s",
    "#EXT-X-PROGRAM-DATE-TIME:2026-07-21T00:00:10.000Z",
    "#EXTINF:5,",
    "2.m4s",
  ].join("\n"), playlistUrl);
  const playlist = prefetcher.playlists.get(playlistUrl);

  assert.equal(playlist.playlistStartTime, Date.parse("2026-07-21T00:00:00.000Z") / 1000);
  assert.equal(prefetcher.segmentIndexAtTime(
    playlist,
    Date.parse("2026-07-21T00:00:07.000Z") / 1000,
  ), 1);
});

test("a consumed segment remains reusable for backward playback, also after the playlist is replaced", async () => {
  let networkRequests = 0;
  const prefetcher = createPrefetcher({
    maxConcurrent: 0,
    fetchImpl: async () => {
      networkRequests += 1;
      return new Response("network");
    },
  });
  const playlistUrl = "https://yolo.test/video.m3u8";
  const segments = [segment(0), segment(1), segment(2)];
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  prefetcher.segmentCache.set(segments[1].url, {
    ...cachedEntry("cached once"),
    url: segments[1].url,
    playlistUrl,
    index: 1,
  });

  assert.equal(await (await prefetcher.fetch(segments[1].url)).text(), "cached once");
  assert.equal(await (await prefetcher.fetch(segments[1].url)).text(), "cached once");
  // A new rendition's playlist replaces the old one; what was downloaded stays.
  prefetcher.updatePlaylist("#EXTM3U\n#EXTINF:5,\n/new.m4s\n", playlistUrl);
  assert.equal(prefetcher.segmentIndexes.has(segments[1].url), false);
  assert.equal(await (await prefetcher.fetch(segments[1].url)).text(), "cached once");
  assert.equal(networkRequests, 0);
});

test("prefetch scheduling stops after reaching the time target", () => {
  const prefetcher = createPrefetcher({
    ahead: 36,
    targetAheadSeconds: 12,
    maxConcurrent: 0,
  });
  const playlistUrl = "https://yolo.test/video.m3u8";
  prefetcher.updatePlaylist(
    playlistBody(Array.from({ length: 10 }, (_, index) => segment(index, 4))),
    playlistUrl,
  );

  prefetcher.scheduleAhead(playlistUrl, 1);

  assert.deepEqual(
    [...prefetcher.jobs.values()].map((entry) => entry.index),
    [1, 2, 3],
  );
});

test("keeps separate audio and video playlists buffered", () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  const videoUrl = "https://yolo.test/video.m3u8";
  const audioUrl = "https://yolo.test/audio.m3u8";
  const videoSegments = Array.from({ length: 4 }, (_, index) => ({
    url: `https://yolo.test/video-${index}.m4s`,
    duration: 5,
  }));
  const audioSegments = Array.from({ length: 4 }, (_, index) => ({
    url: `https://yolo.test/audio-${index}.m4s`,
    duration: 5,
  }));

  prefetcher.updatePlaylist(playlistBody(videoSegments), videoUrl);
  prefetcher.updatePlaylist(playlistBody(audioSegments), audioUrl);
  prefetcher.playlists.get(videoUrl).currentIndex = 0;
  prefetcher.playlists.get(audioUrl).currentIndex = 0;
  prefetcher.scheduleAhead(videoUrl, 1);
  prefetcher.scheduleAhead(audioUrl, 1);

  assert.deepEqual(prefetcher.segmentIndexes.get(videoSegments[1].url), {
    playlistUrl: videoUrl,
    index: 1,
  });
  assert.deepEqual(prefetcher.segmentIndexes.get(audioSegments[1].url), {
    playlistUrl: audioUrl,
    index: 1,
  });
  assert.equal(prefetcher.jobs.size, 6);

  for (const item of videoSegments.slice(1, 3)) {
    prefetcher.segmentCache.set(item.url, {
      ...cachedEntry(item.url),
      url: item.url,
      playlistUrl: videoUrl,
      index: videoSegments.indexOf(item),
    });
    prefetcher.jobs.delete(item.url);
  }
  prefetcher.segmentCache.set(audioSegments[1].url, {
    ...cachedEntry(audioSegments[1].url),
    url: audioSegments[1].url,
    playlistUrl: audioUrl,
    index: 1,
  });
  prefetcher.jobs.delete(audioSegments[1].url);

  const stats = prefetcher.getStats();
  assert.equal(stats.activePlaylistCount, 2);
  assert.equal(stats.bufferedAheadSeconds, 5);
  assert.equal(stats.readySegments, 3);
  assert.deepEqual(
    stats.playlistStats.map((item) => item.bufferedAheadSeconds),
    [10, 5],
  );
});

test("jumping to a resume position drops stale startup prefetches", () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  const playlistUrl = "https://yolo.test/video.m3u8";
  const segments = Array.from({ length: 10 }, (_, index) => segment(index));
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  const playlist = prefetcher.playlists.get(playlistUrl);
  prefetcher.advancePlaylist(playlist, 0, segments[0].url);
  prefetcher.scheduleAhead(playlistUrl, 1);

  prefetcher.advancePlaylist(playlist, 7, segments[7].url);

  assert.equal(playlist.currentIndex, 7);
  assert.deepEqual(
    [...prefetcher.jobs.values()].map((entry) => entry.index),
    [7, 8, 9],
  );
  assert.equal(prefetcher.advancePlaylist(playlist, 1, segments[1].url), false);
  assert.equal(playlist.currentIndex, 7);
});

test("cache pressure evicts history to make room for forward work", () => {
  const prefetcher = createPrefetcher({ maxBytes: 4, maxConcurrent: 0 });
  prefetcher.segmentCache.set(segment(1).url, cachedEntry("full"));
  prefetcher.jobs.set(segment(2).url, {
    url: segment(2).url,
    index: 2,
    state: "queued",
    promise: null,
    controller: null,
  });

  prefetcher.pumpPrefetches();

  const stats = prefetcher.getStats();
  assert.equal(stats.cachedBytes, 0);
  assert.equal(stats.byteCapHitCount, 1);
});

test("prefetch makes room for estimated bytes before starting a download", () => {
  const prefetcher = createPrefetcher({ maxBytes: 10, maxConcurrent: 1 });
  prefetcher.segmentSizeSamples = [4];
  prefetcher.segmentCache.set(segment(1).url, { ...cachedEntry("12345678"), index: 1 });
  prefetcher.jobs.set(segment(2).url, {
    url: segment(2).url,
    index: 2,
    state: "queued",
    promise: null,
    controller: null,
  });
  prefetcher.startPrefetchEntry = (entry) => {
    entry.state = "pending";
    return null;
  };

  prefetcher.pumpPrefetches();

  assert.equal(prefetcher.jobs.get(segment(2).url).state, "pending");
  assert.equal(prefetcher.byteCapHitCount, 1);
  assert.equal(prefetcher.getStats().managedBytesEstimate, 4);
  prefetcher.pumpPrefetches();
  assert.equal(prefetcher.byteCapHitCount, 1);
});

test("ready cache trims the farthest segments to stay within its byte budget", () => {
  const prefetcher = createPrefetcher({ maxBytes: 6, maxConcurrent: 1 });
  const near = { ...cachedEntry("near"), index: 1 };
  const far = { ...cachedEntry("far!"), index: 2 };
  prefetcher.segmentCache.set(segment(1).url, near);
  prefetcher.segmentCache.set(segment(2).url, far);

  prefetcher.updateCachePeaks();
  prefetcher.trimReadyCacheToBudget();

  assert.equal(prefetcher.segmentCache.has(segment(1).url), true);
  assert.equal(prefetcher.segmentCache.has(segment(2).url), false);
  assert.equal(prefetcher.cachedBytes, 4);
  assert.equal(prefetcher.peakCachedBytes, 8);
  assert.equal(prefetcher.byteCapHitCount, 1);
});

test("reads a node's old live tags until the release after the rename, and prefers the new ones", () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  const oldUrl = "https://yolo.test/m/token/p/3.m3u8";
  prefetcher.updatePlaylist("#EXTM3U\n#EXT-X-DRIVE-IN-DVR-START:2000\n#EXT-X-DRIVE-IN-PLAY-START:2010\n#EXTINF:2,\n/m/token/l/3/1\n", oldUrl);
  assert.equal(prefetcher.playlists.get(oldUrl).liveDvrStartTime, 2000);
  assert.equal(prefetcher.playlists.get(oldUrl).livePlayStartTime, 2010);
  const bothUrl = "https://yolo.test/m/token/p/4.m3u8";
  prefetcher.updatePlaylist("#EXTM3U\n#EXT-X-YOLO-DVR-START:3000\n#EXT-X-DRIVE-IN-DVR-START:1\n#EXTINF:2,\n/m/token/l/4/1\n", bothUrl);
  assert.equal(prefetcher.playlists.get(bothUrl).liveDvrStartTime, 3000);
});

test("read-ahead requests carry ?prefetch=1 on every origin and no custom header", () => {
  assert.deepEqual(prefetchRequest("https://yolo.test/m/token/l/0/5"), { url: "https://yolo.test/m/token/l/0/5?prefetch=1", headers: {} });
  assert.deepEqual(prefetchRequest("https://yolo-lan-1.example.com:9443/m/token/l/0/5?a=1"), { url: "https://yolo-lan-1.example.com:9443/m/token/l/0/5?a=1&prefetch=1", headers: {} });
});
