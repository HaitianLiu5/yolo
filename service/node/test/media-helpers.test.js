import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKeyFor, createSegmentCache, isCacheableResponse } from "../src/media/cache.js";
import { buildDashHls, expectedRangeBytes, parseMp4Structure } from "../src/media/dash.js";
import { buildLiveWindow, filterVariants, rewriteHlsUris, rewriteTranscodePlaylist, sequenceForTime, trimToStartOffset } from "../src/media/hls.js";
import { createHostHealth } from "../src/media/hosts.js";
import { ffmpegHeaders } from "../src/media/transcode.js";
import { normalizeInput, urlExpiry } from "../src/media/pipeline.js";

// A version-zero sidx box with one 1000-byte, 5-second reference.
function sidx(declaredSize) {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32BE(declaredSize, 0);
  buffer.write("sidx", 4, "ascii");
  buffer.writeUInt32BE(1, 12);
  buffer.writeUInt32BE(1000, 16);
  buffer.writeUInt16BE(1, 30);
  buffer.writeUInt32BE(1000, 32);
  buffer.writeUInt32BE(5000, 36);
  return buffer;
}

test("a sidx gives each segment's byte range; a box cut off by the probe gives none", () => {
  assert.deepEqual(parseMp4Structure(sidx(44), 1044).segments, [{ start: 44, end: 1043, duration: 5, durationTicks: 5000 }]);
  assert.deepEqual(parseMp4Structure(sidx(4096)).segments, []);
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

test("variants above the bandwidth cap are dropped; when all are, the smallest stays", () => {
  const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nlow.m3u8\n";
  assert.doesNotMatch(filterVariants(master, 5_000_000), /high/);
  assert.match(filterVariants(master, 5_000_000), /low\.m3u8/);
  // An adaptive-quality cap below every variant: the closest one plays.
  assert.equal(filterVariants(master, 1_000), "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nlow.m3u8\n");
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
  const body = buildLiveWindow(index, { cursorSequence: 50, segmentPath: (sequence) => `/m/t/l/0/${sequence}` });
  // 30 seconds behind the cursor, 150 seconds ahead of it.
  assert.match(body, /#EXT-X-MEDIA-SEQUENCE:35\n/);
  assert.match(body, /#EXT-X-DRIVE-IN-DVR-START:1000/);
  assert.match(body, /\/m\/t\/l\/0\/124\n$/);
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

test("two overlapping requests for one segment never leave a partial or missing cache entry", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yolo-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = createSegmentCache({ dir });
  cache.init();
  const CHUNK = 64 * 1024;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Three 64 KiB chunks of `fill`, each sent once its gate opens.
  const upstream = (fill, gates) => {
    let sent = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        if (sent === 3) return controller.close();
        await gates[sent];
        sent += 1;
        controller.enqueue(new Uint8Array(CHUNK).fill(fill));
      },
    }), { status: 206, headers: { "content-type": "video/mp4", "content-length": String(3 * CHUNK) } });
  };
  const drain = async (reader) => { while (!(await reader.read()).done); };
  const url = "https://cdn.test/v.mp4";
  const range = `bytes=0-${3 * CHUNK - 1}`;
  const target = cache.paths(url, range);

  const first = drain(cache.tee(upstream(0x41, [null, null, sleep(100)]), target).getReader());
  await sleep(30);
  // The device retried while the first read was still going; it then gives up too.
  const retry = cache.tee(upstream(0x41, [null, new Promise(() => {})]), target).getReader();
  await retry.read();
  await first;
  let hit = null;
  for (let tries = 0; !hit && tries < 50; tries += 1) hit = cache.get(url, range) ?? await sleep(10);
  assert.ok(hit);
  const bytes = readFileSync(hit.dataPath);
  assert.equal(bytes.length, 3 * CHUNK);
  assert.equal(bytes.indexOf(0), -1, "no zero-filled hole");
  await retry.cancel();
  assert.ok(cache.get(url, range), "the abandoned retry keeps the finished entry");
  assert.equal(cache.stats.sizeBytes, 3 * CHUNK);
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

test("mirror hosts rank by recent faults, which decay, then by measured speed, never by name", () => {
  let clock = 0;
  const health = createHostHealth({ now: () => clock, halfLifeMs: 60_000 });
  const [a, b, c] = ["https://a.example/f.m4s", "https://b.example/f.m4s", "https://c.example/f.m4s"];
  assert.deepEqual(health.rank([a, b, c]), [a, b, c], "nothing seen yet: the order given");
  health.fault(a);
  assert.deepEqual(health.rank([a, b, c]), [b, c, a], "a host that stalled goes last, for every resource on it");
  clock += 61_000;
  assert.deepEqual(health.rank([a, b, c]), [a, b, c], "after one half-life it is forgiven");
  health.fault(b);
  health.fault(b);
  health.fault(c);
  clock += 90_000;
  assert.deepEqual(health.rank([a, b, c]), [a, c, b], "two faults keep a host down longer than one");
  clock += 30 * 60_000;
  health.success(b, { bytes: 1_000_000, ms: 1_000 });
  health.success(c, { bytes: 1_000_000, ms: 4_000 });
  health.success(a, { bytes: 100_000, ms: 4_000 });
  assert.deepEqual(health.rank([c, b, a]), [b, a, c], "the faster first; a short transfer is no measure, so a counts as fast as the best");
});
