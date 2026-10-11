import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheKeyFor, isCacheableResponse } from "../src/media/cache.js";
import { buildDashHls, expectedRangeBytes, parseMp4Structure } from "../src/media/dash.js";
import { buildLiveWindow, filterVariants, rewriteHlsUris, rewriteTranscodePlaylist, sequenceForTime, trimToStartOffset } from "../src/media/hls.js";
import { ffmpegHeaders } from "../src/media/transcode.js";
import { normalizeInput, urlExpiry } from "../src/media/pipeline.js";

test("parses a bounded version-zero sidx", () => {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32BE(44, 0);
  buffer.write("sidx", 4, "ascii");
  buffer.writeUInt32BE(1, 12);
  buffer.writeUInt32BE(1000, 16);
  buffer.writeUInt32BE(0, 20);
  buffer.writeUInt32BE(0, 24);
  buffer.writeUInt16BE(0, 28);
  buffer.writeUInt16BE(1, 30);
  buffer.writeUInt32BE(1000, 32);
  buffer.writeUInt32BE(5000, 36);
  assert.deepEqual(parseMp4Structure(buffer, 1044).segments, [{ start: 44, end: 1043, duration: 5, durationTicks: 5000 }]);
});

test("malformed MP4 box sizes fail closed", () => {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32BE(4096, 0);
  buffer.write("sidx", 4, "ascii");
  assert.deepEqual(parseMp4Structure(buffer).segments, []);
});

test("split files become separate fMP4 playlists on the pipeline's routes", () => {
  const hls = buildDashHls({
    video: { codec: "avc1.4d401f", kbps: 1800, width: 1280, height: 720, fps: 60 },
    audio: { codec: "mp4a.40.2", kbps: 128 },
    videoInfo: { segments: [{ start: 10, end: 20, duration: 2 }], initEnd: 9 },
    audioInfo: { segments: [{ start: 8, end: 18, duration: 2 }], initEnd: 7 },
    paths: { playlist: (track) => `/m/t/dash/${track}.m3u8`, init: (track) => `/m/t/dash/${track}/init.mp4`, segment: (track, index) => `/m/t/dash/${track}/${index}.m4s` },
  });
  assert.match(hls.master, /RESOLUTION=1280x720,FRAME-RATE=60/);
  assert.match(hls.master, /URI="\/m\/t\/dash\/audio\.m3u8"/);
  assert.match(hls.video, /#EXT-X-MAP:URI="\/m\/t\/dash\/video\/init\.mp4"\n#EXTINF:2\.000000,\n\/m\/t\/dash\/video\/0\.m4s/);
  assert.equal(buildDashHls({ video: {}, audio: {}, videoInfo: { segments: [] }, audioInfo: { segments: [] }, paths: {} }), null);
  assert.equal(expectedRangeBytes("bytes=10-19"), 10);
  assert.equal(expectedRangeBytes("bytes=10-"), null);
});

test("URI rewriting covers tags and lines exactly once", () => {
  const uris = [];
  const result = rewriteHlsUris('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MEDIA:URI="audio.m3u8"\n\nvideo.m3u8\n', (uri) => {
    uris.push(uri);
    return `proxy/${uri}`;
  });
  assert.deepEqual(uris, ["key.bin", "audio.m3u8", "video.m3u8"]);
  assert.match(result, /URI="proxy\/key.bin"/);
  const transcode = rewriteTranscodePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg0.m4s\n', (name) => `/m/t/x/${name}`);
  assert.match(transcode, /URI="\/m\/t\/x\/init.mp4"/);
  assert.match(transcode, /\n\/m\/t\/x\/seg0.m4s\n/);
});

test("variants above the bandwidth cap are dropped, unless that would drop them all", () => {
  const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nlow.m3u8\n";
  assert.doesNotMatch(filterVariants(master, 5_000_000), /high/);
  assert.match(filterVariants(master, 5_000_000), /low\.m3u8/);
  assert.equal(filterVariants(master, 1_000), master);
  assert.equal(filterVariants(master, null), master);
});

test("placeholder segments before EXT-X-START are trimmed", () => {
  const trims = [];
  const result = trimToStartOffset([
    "#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:10", "#EXT-X-START:TIME-OFFSET=8",
    "#EXTINF:4,", "one.ts", "#EXTINF:4,", "two.ts", "#EXTINF:4,", "three.ts", "",
  ].join("\n"), { onTrim: (detail) => trims.push(detail) });
  assert.doesNotMatch(result, /one\.ts|two\.ts|EXT-X-START/);
  assert.match(result, /#EXT-X-MEDIA-SEQUENCE:12/);
  assert.deepEqual(trims, [{ resumeOffset: 8, droppedSegments: 2, nextMediaSequence: 12 }]);
  const invalid = "#EXTM3U\n#EXT-X-START:TIME-OFFSET=8\n#EXTINF:not-a-number,\none.ts\n";
  assert.equal(trimToStartOffset(invalid), invalid);
});

test("a live window is bounded around the cursor and keeps the DVR start", () => {
  const index = { latestSequence: 101, segmentDuration: 2, startedAt: 1000, liveEdge: 1204, targetDuration: 2 };
  const body = buildLiveWindow(index, { cursorSequence: 50, segmentPath: (sequence) => `/m/t/l/0/${sequence}`, windowAheadSeconds: 6, windowBehindSeconds: 0 });
  assert.match(body, /#EXT-X-MEDIA-SEQUENCE:50/);
  assert.match(body, /#EXT-X-DRIVE-IN-DVR-START:1000/);
  assert.match(body, /\/m\/t\/l\/0\/52\n$/);
  assert.equal(sequenceForTime(index, 1050), 25);
  assert.equal(sequenceForTime(index, null), null);
});

test("cache keys use a source's identity when it gives one", () => {
  const signedA = cacheKeyFor("https://cdn.test/v?sig=a", "bytes=0-99", "video:1");
  const signedB = cacheKeyFor("https://cdn.test/v?sig=b", "bytes=0-99", "video:1");
  assert.equal(signedA.filenameKey, signedB.filenameKey);
  assert.notEqual(cacheKeyFor("https://cdn.test/v?sig=a", "bytes=0-99").filenameKey, cacheKeyFor("https://cdn.test/v?sig=b", "bytes=0-99").filenameKey);
  assert.notEqual(signedA.filenameKey, cacheKeyFor("https://cdn.test/v", "bytes=100-199", "video:1").filenameKey);
  const response = (type, length) => new Response("x", { headers: { "content-type": type, "content-length": String(length) } });
  assert.equal(isCacheableResponse("https://x/a.ts", response("video/mp2t", 50_000), ""), true);
  assert.equal(isCacheableResponse("https://x/a.m3u8", response("video/mp2t", 50_000), ""), false);
  assert.equal(isCacheableResponse("https://x/a.ts", response("video/mp2t", 100), ""), false);
});

test("inputs are validated; signed URL expiry is read", () => {
  assert.equal(normalizeInput({ type: "file", url: "https://x.test/a.mp4" }).type, "file");
  assert.throws(() => normalizeInput({ type: "file", url: "ftp://x" }), { code: "resolve_failed" });
  assert.throws(() => normalizeInput({ type: "dash", url: "https://x" }), { code: "resolve_failed" });
  assert.equal(normalizeInput({ type: "split", video: { url: "https://x/v" }, audio: { url: "https://x/a" } }).type, "split");
  assert.equal(urlExpiry("https://cdn.test/v?expire=1700000000"), 1_700_000_000_000);
  assert.equal(urlExpiry("https://cdn.test/v"), null);
});

test("ffmpeg headers keep the source's and fill browser defaults", () => {
  const headers = ffmpegHeaders({ Referer: "https://site.test/", "user-agent": "Custom" });
  assert.match(headers, /^Referer: https:\/\/site.test\/\r\n/);
  assert.match(headers, /user-agent: Custom/);
  assert.doesNotMatch(headers, /User-Agent: Mozilla/);
  assert.match(headers, /Accept: \*\/\*\r\n/);
});
