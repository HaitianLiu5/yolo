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

// The car reads up to 210 seconds ahead. A read-ahead the node refused (as
// it did with links a refresh had just replaced) is not the stream's end:
// the segment is asked for again on its retry cycle, and the playlist's
// other segments are read ahead meanwhile. Only a refusal of playback's own
// request is final (the test above). Read-ahead that stopped instead would
// leave a stall waiting forever for the buffer the missing segment holds.
test("a refused read-ahead is asked for again on its retry cycle, and playback gets the segment", async (t) => {
  const requests = [];
  let refusals = 2;
  const prefetcher = createPrefetcher({
    maxConcurrent: 1,
    retryBaseDelayMs: 1,
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.startsWith(segment(1).url) && refusals > 0) {
        refusals -= 1;
        return new Response("denied", { status: 403 });
      }
      return new Response(`bytes of ${new URL(url).pathname}`);
    },
  });
  t.after(() => prefetcher.destroy());
  const playlistUrl = `${TEST_ORIGIN}audio.m3u8`;
  prefetcher.updatePlaylist(playlistBody([segment(0), segment(1), segment(2)]), playlistUrl);
  assert.equal(await (await prefetcher.fetch(segment(0).url)).text(), "bytes of /0.m4s");
  await waitFor(() => prefetcher.segmentCache.has(segment(1).url) && prefetcher.segmentCache.has(segment(2).url));
  assert.equal(requests.filter((url) => url.startsWith(segment(1).url)).length, 3, "refused twice, then read");
  assert.ok(requests.filter((url) => url.startsWith(segment(1).url)).every((url) => url.includes("prefetch=1")), "all read-ahead");
  assert.equal(await (await prefetcher.fetch(segment(1).url)).text(), "bytes of /1.m4s");
  assert.equal(await (await prefetcher.fetch(segment(2).url)).text(), "bytes of /2.m4s");
});

test("playback waiting on a read-ahead the node refuses asks for the segment itself", async (t) => {
  const requests = [];
  let answerReadAhead;
  const readAheadAnswered = new Promise((done) => { answerReadAhead = done; });
  const prefetcher = createPrefetcher({
    maxConcurrent: 1,
    retryBaseDelayMs: 60_000,
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.startsWith(segment(1).url) && url.includes("prefetch=1")) {
        await readAheadAnswered;
        return new Response("denied", { status: 403 });
      }
      return new Response(`bytes of ${new URL(url).pathname}`);
    },
  });
  t.after(() => prefetcher.destroy());
  prefetcher.updatePlaylist(playlistBody([segment(0), segment(1)]), `${TEST_ORIGIN}audio.m3u8`);
  await prefetcher.fetch(segment(0).url);
  await waitFor(() => requests.some((url) => url.startsWith(segment(1).url)));
  const played = prefetcher.fetch(segment(1).url);
  answerReadAhead();
  assert.equal(await (await played).text(), "bytes of /1.m4s");
  assert.deepEqual(requests.filter((url) => url.startsWith(segment(1).url)), [`${segment(1).url}?prefetch=1`, segment(1).url]);
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

test("reads the node's live-window tags and ignores their names from before the rename", () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  const url = "https://yolo.test/m/token/p/3.m3u8";
  prefetcher.updatePlaylist("#EXTM3U\n#EXT-X-YOLO-DVR-START:3000\n#EXT-X-YOLO-PLAY-START:3010\n#EXTINF:2,\n/m/token/l/3/1\n", url);
  assert.equal(prefetcher.playlists.get(url).liveDvrStartTime, 3000);
  assert.equal(prefetcher.playlists.get(url).livePlayStartTime, 3010);
  const oldUrl = "https://yolo.test/m/token/p/4.m3u8";
  prefetcher.updatePlaylist("#EXTM3U\n#EXT-X-DRIVE-IN-DVR-START:2000\n#EXTINF:2,\n/m/token/l/4/1\n", oldUrl);
  assert.ok(!(prefetcher.playlists.get(oldUrl).liveDvrStartTime > 0));
});

test("read-ahead requests carry ?prefetch=1 on every origin and no custom header", () => {
  assert.deepEqual(prefetchRequest("https://yolo.test/m/token/l/0/5"), { url: "https://yolo.test/m/token/l/0/5?prefetch=1", headers: {} });
  assert.deepEqual(prefetchRequest("https://yolo-lan-1.example.com:9443/m/token/l/0/5?a=1"), { url: "https://yolo-lan-1.example.com:9443/m/token/l/0/5?a=1&prefetch=1", headers: {} });
});

// quality.js does not decide from an estimate whose newest sample is old.
test("stats say how long ago the newest throughput sample finished", async (t) => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0, fetchImpl: async () => new Response("segment bytes") });
  t.after(() => prefetcher.destroy());
  prefetcher.updatePlaylist(playlistBody([segment(0)]), `${TEST_ORIGIN}audio.m3u8`);
  assert.equal(prefetcher.getStats().throughputSampleAgeMs, null, "no sample yet");
  await prefetcher.fetch(segment(0).url);
  const age = prefetcher.getStats().throughputSampleAgeMs;
  assert.ok(Number.isInteger(age) && age >= 0 && age < 1_000, `age ${age}`);
});

// Device telemetry carries these on every health heartbeat, so a read-ahead
// that stopped shows which playlist stopped and why (Agent Note
// 2026-10-11-device-telemetry). The shape of the 2026-10-16 item: 183 audio
// segments of 10 seconds and 367 video segments of 5.
test("stats name each playlist's read-ahead: its position, length, window end, jobs by state, and evictions", async (t) => {
  const { sanitizeEventFields } = await import("@useyolo/core");
  const prefetcher = createPrefetcher({ maxConcurrent: 0, targetAheadSeconds: 20 });
  t.after(() => prefetcher.destroy());
  const base = "https://yolo.test/m/secret-media-token/dash";
  const track = (name, count, duration) => Array.from({ length: count }, (_, index) => ({ url: `${base}/${name}/${index}.m4s`, duration }));
  const video = track("video", 367, 5);
  const audio = track("audio", 183, 10);
  prefetcher.updatePlaylist(playlistBody(video), `${base}/video.m3u8`);
  prefetcher.updatePlaylist(playlistBody(audio), `${base}/audio.m3u8`);
  prefetcher.segmentCache.set(audio[154].url, { ...cachedEntry("154"), url: audio[154].url, playlistUrl: `${base}/audio.m3u8`, index: 154 });

  prefetcher.handleSeek(1548);
  await prefetcher.fetch(audio[154].url);
  prefetcher.jobs.get(video[309].url).state = "retry_wait";

  const stats = prefetcher.getStats();
  assert.deepEqual(stats.playlists, [
    { name: "video.m3u8", current: 308, segments: 367, scheduledThrough: 312, ahead: 0, queued: 3, pending: 0, retry: 1, failed: 0 },
    { name: "audio.m3u8", current: 154, segments: 183, scheduledThrough: 156, ahead: 0, queued: 2, pending: 0, retry: 0, failed: 0 },
  ]);
  assert.equal(stats.orphanJobs, 0);
  assert.deepEqual(stats.evictions, { behind: 0, ahead: 0, bytes: 0 });

  // History goes before what lies ahead; both are counted.
  for (const index of [100, 170]) {
    prefetcher.segmentCache.set(audio[index].url, { ...cachedEntry("four"), url: audio[index].url, playlistUrl: `${base}/audio.m3u8`, index });
  }
  prefetcher.maxBytes = 1;
  prefetcher.evictReadyCache(1);
  assert.deepEqual(prefetcher.getStats().evictions, { behind: 2, ahead: 1, bytes: 11 });

  // Small, without the media token, and kept whole by the device-event limits.
  const fields = { buffer: { hlsPlaylists: stats.playlists, hlsEvictions: prefetcher.getStats().evictions } };
  const json = JSON.stringify(fields);
  assert.ok(json.length < 400, `${json.length} bytes`);
  assert.ok(!json.includes("secret-media-token"));
  assert.deepEqual(sanitizeEventFields(fields), fields);
});

// At the cap with no history to evict, making room for the next segment of
// the window by evicting the window's farthest segment only made the next
// read fetch that one again: one wasted download per read, the cached
// count flat (seen in the car end-to-end, 2026-10-16).
test("at the cap, the read-ahead does not trade a segment it holds for a farther one", async (t) => {
  const requested = [];
  const prefetcher = createPrefetcher({
    maxConcurrent: 1,
    targetAheadSeconds: 50,
    fetchImpl: async (url) => { requested.push(new URL(url).pathname); return new Response("12345678"); },
  });
  t.after(() => prefetcher.destroy());
  const playlistUrl = `${TEST_ORIGIN}video.m3u8`;
  const segments = Array.from({ length: 12 }, (_, index) => segment(index, 5));
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  const playlist = prefetcher.playlists.get(playlistUrl);
  playlist.currentIndex = 0;
  for (let index = 1; index <= 8; index += 1) {
    prefetcher.segmentCache.set(segments[index].url, { ...cachedEntry("12345678"), url: segments[index].url, playlistUrl, index });
  }
  prefetcher.segmentSizeSamples = [8];
  prefetcher.maxBytes = 64;

  // The window (1-10) wants 9 and 10; the cap holds 1-8.
  prefetcher.scheduleAhead(playlistUrl, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(requested, [], "nothing fetched at the price of 7 or 8");
  assert.equal(prefetcher.segmentCache.size, 8);
  assert.deepEqual([...prefetcher.jobs.values()].map((job) => [job.index, job.state]), [[9, "queued"], [10, "queued"]]);

  // Playback reads on: segment 1 is history now, and makes room for 9.
  await prefetcher.fetch(segments[1].url);
  await waitFor(() => prefetcher.segmentCache.has(segments[9].url));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(requested, ["/9.m4s"]);
  assert.equal(prefetcher.segmentCache.has(segments[1].url), false);
  assert.ok([2, 3, 4, 5, 6, 7, 8].every((index) => prefetcher.segmentCache.has(segments[index].url)));
  assert.deepEqual(prefetcher.getStats().evictions, { behind: 1, ahead: 0, bytes: 8 });
});

test("room for one playlist's segment comes from another's only when that starts later", () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  const audioUrl = `${TEST_ORIGIN}audio.m3u8`;
  const videoUrl = `${TEST_ORIGIN}video.m3u8`;
  const audio = Array.from({ length: 10 }, (_, index) => ({ url: `${TEST_ORIGIN}a/${index}.m4s`, duration: 10 }));
  const video = Array.from({ length: 20 }, (_, index) => ({ url: `${TEST_ORIGIN}v/${index}.m4s`, duration: 5 }));
  prefetcher.updatePlaylist(playlistBody(audio), audioUrl);
  prefetcher.updatePlaylist(playlistBody(video), videoUrl);
  prefetcher.playlists.get(audioUrl).currentIndex = 0;
  prefetcher.playlists.get(videoUrl).currentIndex = 0;
  // Video 8 starts 35 seconds ahead, video 12 55 seconds; audio 5, the
  // segment wanted, 40 seconds.
  for (const index of [8, 12]) prefetcher.segmentCache.set(video[index].url, { ...cachedEntry("1234"), url: video[index].url, playlistUrl: videoUrl, index });
  prefetcher.evictReadyCache(8, { makingRoomFor: { playlistUrl: audioUrl, index: 5 } });
  assert.equal(prefetcher.segmentCache.has(video[12].url), false, "starts later: evicted");
  assert.equal(prefetcher.segmentCache.has(video[8].url), true, "starts sooner: kept");
});

test("the read-ahead fills its playlists in media time, and sizes a segment by its own playlist's", async (t) => {
  const requested = [];
  const prefetcher = createPrefetcher({
    maxConcurrent: 1,
    fetchImpl: async (url) => { requested.push(new URL(url).pathname); return new Response("x"); },
  });
  t.after(() => prefetcher.destroy());
  const audioUrl = `${TEST_ORIGIN}audio.m3u8`;
  const videoUrl = `${TEST_ORIGIN}video.m3u8`;
  const audio = Array.from({ length: 10 }, (_, index) => ({ url: `${TEST_ORIGIN}a/${index}.m4s`, duration: 10 }));
  const video = Array.from({ length: 20 }, (_, index) => ({ url: `${TEST_ORIGIN}v/${index}.m4s`, duration: 5 }));
  prefetcher.updatePlaylist(playlistBody(audio), audioUrl);
  prefetcher.updatePlaylist(playlistBody(video), videoUrl);
  prefetcher.playlists.get(audioUrl).currentIndex = 0;
  prefetcher.playlists.get(videoUrl).currentIndex = 0;
  prefetcher.maxConcurrent = 0;
  // Audio 3 starts 20 seconds ahead (3 segments), video 4 15 seconds (4).
  for (const [url, playlistUrl, index] of [[audio[3].url, audioUrl, 3], [video[4].url, videoUrl, 4]]) {
    prefetcher.jobs.set(url, { url, playlistUrl, index, state: "queued", promise: null, controller: null });
  }
  // Audio segments weigh 4 bytes, video ones 16: 10 bytes of room fit the
  // average of both (7), but not a video segment.
  for (const index of [0, 1, 2]) prefetcher.recordDownload(4, 10, index, audioUrl);
  prefetcher.recordDownload(16, 10, 0, videoUrl);
  prefetcher.maxBytes = 10;
  prefetcher.maxConcurrent = 1;
  prefetcher.pumpPrefetches();
  assert.deepEqual(requested, [], "video 4 comes first and does not fit; nothing overshoots the cap");
  prefetcher.maxBytes = 64;
  prefetcher.pumpPrefetches();
  await waitFor(() => requested.length === 2);
  assert.deepEqual(requested, ["/v/4.m4s", "/a/3.m4s"], "sooner in media time first");
});

// A cache at its cap that holds nothing playback has passed, with the
// frontier segment waiting to be retried: segment 9 cannot fit, and
// nothing later than it may make room.
function retryAtTheCap(t, retryInMs) {
  const requested = [];
  const prefetcher = createPrefetcher({
    maxConcurrent: 1,
    targetAheadSeconds: 50,
    fetchImpl: async (url) => { requested.push(new URL(url).pathname); return new Response("12345678"); },
  });
  t.after(() => prefetcher.destroy());
  const playlistUrl = `${TEST_ORIGIN}video.m3u8`;
  const segments = Array.from({ length: 12 }, (_, index) => segment(index, 5));
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  prefetcher.playlists.get(playlistUrl).currentIndex = 0;
  for (let index = 1; index <= 8; index += 1) {
    prefetcher.segmentCache.set(segments[index].url, { ...cachedEntry("12345678"), url: segments[index].url, playlistUrl, index });
  }
  prefetcher.recordDownload(8, 10, 8, playlistUrl);
  prefetcher.maxBytes = 64;
  prefetcher.jobs.set(segments[9].url, {
    url: segments[9].url, playlistUrl, index: 9, state: "retry_wait",
    retryAt: performance.now() + retryInMs, failureCycles: 1, promise: null, controller: null,
  });
  let pumps = 0;
  const pump = prefetcher.pumpPrefetches.bind(prefetcher);
  prefetcher.pumpPrefetches = () => { pumps += 1; return pump(); };
  return { prefetcher, segments, requested, pumps: () => pumps };
}

test("a retry the cap holds back waits for the next read, without a timer spinning", async (t) => {
  const { prefetcher, segments, requested, pumps } = retryAtTheCap(t, -1);
  // 6 bytes free, and segment 9 takes 8.
  prefetcher.maxBytes = 70;
  prefetcher.pumpPrefetches();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(pumps() <= 2, `${pumps()} pumps in 300 ms`);
  assert.equal(prefetcher.retryTimer, null, "no timer for a retry that is already due");
  assert.equal(prefetcher.jobs.get(segments[9].url).state, "retry_wait");
  assert.deepEqual(requested, []);
  // Playback reads on: segment 1 is history now, and the retry gets its room.
  await prefetcher.fetch(segments[1].url);
  await waitFor(() => prefetcher.segmentCache.has(segments[9].url));
  assert.deepEqual(requested, ["/9.m4s"]);
});

test("a retry that is not due yet keeps its timer, also with the cache over its cap", async (t) => {
  const { prefetcher, segments, pumps } = retryAtTheCap(t, 50);
  prefetcher.maxBytes = 60;
  prefetcher.pumpPrefetches();
  assert.ok(prefetcher.retryTimer, "a timer for the retry 50 ms away");
  await waitFor(() => pumps() >= 2, 500);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(pumps() <= 3, `${pumps()} pumps`);
  assert.equal(prefetcher.retryTimer, null, "due now, it waits for a read or a download");
  assert.equal(prefetcher.jobs.get(segments[9].url).state, "retry_wait");
});
