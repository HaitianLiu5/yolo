import assert from "node:assert/strict";
import test from "node:test";

import { hasHlsStartupBuffer, REBUFFER_SECONDS, START_BUFFER_SECONDS, stallRunwaySeconds } from "../../src/engine/playback-buffer-policy.js";
import { HlsSegmentPrefetcher } from "../../src/engine/hls-segment-prefetcher.js";

const registeredPlaylist = (bufferedAheadSeconds, pendingSegments = 1) => ({
  activePlaylistCount: 2,
  bufferedAheadSeconds,
  pendingSegments,
});

test("a start or a seek plays once three seconds are buffered; low-latency live its own two", () => {
  assert.equal(START_BUFFER_SECONDS, 3);
  assert.equal(hasHlsStartupBuffer({ decodedReady: true, network: registeredPlaylist(2.9), mediaTime: 30, duration: 120 }), false);
  assert.equal(hasHlsStartupBuffer({ decodedReady: true, network: registeredPlaylist(3), mediaTime: 30, duration: 120 }), true);
  assert.equal(hasHlsStartupBuffer({ decodedReady: true, network: registeredPlaylist(1), requiredStartSeconds: 2 }), false);
  assert.equal(hasHlsStartupBuffer({ decodedReady: true, network: registeredPlaylist(2), requiredStartSeconds: 2 }), true);
});

test("a stall waits for five seconds only when the network buffer ran short", () => {
  assert.equal(REBUFFER_SECONDS, 5);
  // The link fell behind: more runway, so it does not stall again at once.
  assert.equal(stallRunwaySeconds({ network: registeredPlaylist(1) }), 5);
  // A decoder hiccup with media buffered resumes as a start would.
  assert.equal(stallRunwaySeconds({ network: registeredPlaylist(12) }), 3);
  assert.equal(stallRunwaySeconds({ startSeconds: 2, network: registeredPlaylist(12) }), 2);
  // A progressive file has no network buffer to measure.
  assert.equal(stallRunwaySeconds({ network: null }), 3);
});

test("startup runway is bounded by media remaining near the end", () => {
  assert.equal(hasHlsStartupBuffer({
    decodedReady: true,
    network: registeredPlaylist(4),
    mediaTime: 116,
    duration: 120,
  }), true);
});

test("decoded media breaks an empty playlist registration cycle only when no work exists", () => {
  const idleNetwork = {
    activePlaylistCount: 0,
    pendingSegments: 0,
    activeDownloads: 0,
    queuedSegments: 0,
    retryWaitingSegments: 0,
  };
  assert.equal(hasHlsStartupBuffer({ decodedReady: true, network: idleNetwork }), true);
  assert.equal(hasHlsStartupBuffer({
    decodedReady: true,
    network: { ...idleNetwork, queuedSegments: 1 },
  }), false);
});

test("a fully downloaded ENDLIST tail can start without a future segment", async (t) => {
  const prefetcher = new HlsSegmentPrefetcher({ fetchImpl: async () => new Response("media") });
  t.after(() => prefetcher.destroy());
  const manifest = '#EXTM3U\n#EXTINF:4,\nseg0.m4s\n';
  prefetcher.updatePlaylist(manifest, "https://fixture.test/short.m3u8");
  await prefetcher.fetch("https://fixture.test/seg0.m4s");
  assert.equal(prefetcher.getStats().allRemainingSegmentsCached, false);
  assert.equal(hasHlsStartupBuffer({ decodedReady: true, network: prefetcher.getStats(), duration: 4 }), false);
  // An unchanged segment list can become finite on the final playlist update.
  prefetcher.updatePlaylist(`${manifest}#EXT-X-ENDLIST\n`, "https://fixture.test/short.m3u8");
  const network = prefetcher.getStats();
  assert.equal(network.bufferedAheadSeconds, 0);
  assert.equal(network.allRemainingSegmentsCached, true);
  assert.equal(hasHlsStartupBuffer({ decodedReady: true, network, duration: 4 }), true);
  assert.equal(hasHlsStartupBuffer({ decodedReady: false, network, duration: 4 }), false);
});
