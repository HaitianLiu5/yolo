import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeCapabilities, signMediaToken } from "@useyolo/core";
import { DEVICE_SEGMENT_TIMEOUT_MS, SEGMENT_TIMING } from "../src/media/hedge.js";
import { createMediaPipeline, SESSION_EXPIRED } from "../src/media/pipeline.js";

const secret = "media-test-secret";
const USER = "usr_media";

async function origin(t, handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range || null, headers: req.headers });
    handler(req, res);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => {
    server.closeAllConnections();
    server.close(done);
  }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

const FILE = Buffer.alloc(64 * 1024, 7);

function serveBytes(res, req, body, type = "video/mp4") {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  res.setHeader("content-type", type);
  res.setHeader("accept-ranges", "bytes");
  if (!range) {
    res.setHeader("content-length", body.length);
    res.end(body);
    return;
  }
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
  res.writeHead(206, { "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
  res.end(body.subarray(start, end + 1));
}

async function pipelineFor(t, options = {}) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "yolo-media-"));
  const media = createMediaPipeline({ secret, runtimeDir, stopGraceMs: 20, ...options });
  media.init();
  t.after(async () => {
    await media.close();
    // A cache write still in flight may land while the directory goes.
    await rm(runtimeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return media;
}

let counter = 0;
// `request` is what the control plane says about the device, such as
// `{ capabilities }`; without it the node serves the canvas engine's way.
async function open(media, descriptor, { sessionId = `ses_t${counter += 1}`, exp = Math.floor(Date.now() / 1000) + 600, request } = {}) {
  const mediaToken = await signMediaToken(secret, { sessionId, userId: USER, exp });
  return media.open({ sessionId, mediaToken, source: { plugin: "fixture", id: "1" }, descriptor, ...(request ? { request } : {}) });
}

const get = (media, path, headers = {}) => media.handle(new Request(`http://node.test${path}`, { headers }));

test("a file is served with byte ranges and kept in the disk cache", async (t) => {
  const upstream = await origin(t, (req, res) => serveBytes(res, req, FILE));
  const media = await pipelineFor(t);
  const descriptor = await open(media, { title: "File", input: { type: "file", url: `${upstream.url}/a.mp4` }, startTime: 3 });
  assert.equal(descriptor.delivery.type, "mp4");
  assert.equal(descriptor.trimToStart, false);
  assert.match(descriptor.delivery.url, /^\/m\/[^/]+\/f\/0$/);
  assert.equal(descriptor.startTime, 3);

  const first = await get(media, descriptor.delivery.url, { range: "bytes=0-32767" });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get("content-range"), "bytes 0-32767/65536");
  assert.equal((await first.arrayBuffer()).byteLength, 32768);
  await new Promise((done) => setTimeout(done, 50));
  const second = await get(media, descriptor.delivery.url, { range: "bytes=0-32767" });
  assert.equal(second.headers.get("x-yolo-cache"), "hit");
  assert.equal((await second.arrayBuffer()).byteLength, 32768);
  assert.equal(upstream.requests.length, 1);
});

test("media tokens are checked; ended sessions answer SESSION_EXPIRED", async (t) => {
  const upstream = await origin(t, (req, res) => serveBytes(res, req, FILE));
  const media = await pipelineFor(t);
  const descriptor = await open(media, { input: { type: "file", url: `${upstream.url}/a.mp4` } });
  const token = descriptor.delivery.url.split("/")[2];
  const forged = `${token.slice(0, -2)}xx`;
  assert.equal((await get(media, `/m/${forged}/f/0`)).status, 403);

  const unknown = await signMediaToken(secret, { sessionId: "ses_gone", userId: USER, exp: Math.floor(Date.now() / 1000) + 60 });
  const gone = await get(media, `/m/${unknown}/f/0`);
  assert.equal(gone.status, 410);
  assert.equal(gone.headers.get("x-yolo-error-code"), SESSION_EXPIRED);

  await assert.rejects(open(media, { input: { type: "file", url: `${upstream.url}/a.mp4` } }, { exp: Math.floor(Date.now() / 1000) - 1 }), { code: "invalid_request" });

  await media.stop(descriptor.sessionId);
  assert.equal((await get(media, descriptor.delivery.url, { range: "bytes=0-1" })).status, 206, "a stopped session stays readable briefly");
  await new Promise((done) => setTimeout(done, 60));
  assert.equal((await get(media, descriptor.delivery.url)).status, 410);
});

test("HLS playlists are rewritten onto the session and segments proxied", async (t) => {
  const upstream = await origin(t, (req, res) => {
    if (req.url === "/master.m3u8") {
      res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000\nhigh/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nlow/index.m3u8\n");
    } else if (req.url === "/low/index.m3u8") {
      res.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg0.m4s\n#EXT-X-ENDLIST\n');
    } else serveBytes(res, req, FILE);
  });
  const media = await pipelineFor(t);
  const descriptor = await open(media, { input: { type: "hls", url: `${upstream.url}/master.m3u8`, maxBandwidth: 5_000_000, headers: { "X-Test": "1" } } });
  assert.equal(descriptor.delivery.type, "hls");
  const master = await (await get(media, descriptor.delivery.url)).text();
  assert.doesNotMatch(master, /high/);
  const variant = master.split("\n").find((line) => line.startsWith("/m/"));
  assert.match(variant, /\/p\/\d+\.m3u8$/);
  const playlist = await (await get(media, variant)).text();
  const [init, segment] = [...playlist.matchAll(/(\/m\/[^\s"]+)/g)].map((match) => match[1]);
  assert.match(init, /\/f\/\d+$/);
  assert.equal((await get(media, segment)).status, 200);
  assert.ok(upstream.requests.every((request) => request.headers["x-test"] === "1"), "the Input's headers go with every request");
});

test("a source-provided master manifest, trimmed placeholders and transcoder health", async (t) => {
  let alive = true;
  const upstream = await origin(t, (req, res) => {
    if (req.url.startsWith("/session/s1/index.m3u8")) {
      res.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-START:TIME-OFFSET=8\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n#EXTINF:4,\nc.ts\n");
    } else if (req.url.startsWith("/session/s1/c.ts") && alive) {
      serveBytes(res, req, FILE, "video/mp2t");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const media = await pipelineFor(t);
  const descriptor = await open(media, {
    input: { type: "hls", url: `${upstream.url}/start.m3u8`, manifest: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nsession/s1/index.m3u8\n", trimToStart: true, transcoder: true, cache: false },
    health: async () => (alive ? "alive" : "expired"),
  });
  // The device learns the stream may begin at its start position.
  assert.equal(descriptor.trimToStart, true);
  const master = await (await get(media, descriptor.delivery.url)).text();
  assert.ok(!upstream.requests.some((request) => request.url === "/start.m3u8"), "the manifest is not fetched again");
  const playlist = await (await get(media, master.split("\n").find((line) => line.startsWith("/m/")))).text();
  assert.doesNotMatch(playlist, /EXT-X-START/);
  const segments = playlist.split("\n").filter((line) => line.startsWith("/m/"));
  assert.equal(segments.length, 1);
  assert.equal((await get(media, segments[0])).status, 200);
  alive = false;
  const expired = await get(media, segments[0]);
  assert.equal(expired.status, 410);
  assert.equal(expired.headers.get("x-yolo-error-code"), SESSION_EXPIRED);
});

test("subtitles come from the source; pending ones ask the device to retry", async (t) => {
  const media = await pipelineFor(t);
  const descriptor = await open(media, {
    input: { type: "file", url: "https://media.test/a.mp4" },
    tracks: {
      subtitles: [
        { id: "s_en", kind: "subtitle", language: "en", name: "English", delivery: "vtt" },
        { id: "s_zh", kind: "subtitle", language: "zh", name: "中文", delivery: "vtt" },
        { id: "img", kind: "subtitle", language: "en", name: "PGS", format: "image", delivery: "burn" },
      ],
      audio: [],
      selected: { subtitles: ["s_en"], audio: null },
    },
    subtitle: async (id) => (id === "s_en" ? "WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n" : { pending: true, retryAfter: 3 }),
  });
  const [english, chinese, image] = descriptor.tracks.subtitles;
  assert.deepEqual(descriptor.tracks.selected, { subtitles: ["s_en"], audio: null });
  assert.equal(image.url, undefined);
  const vtt = await get(media, english.url);
  assert.equal(vtt.headers.get("content-type"), "text/vtt; charset=utf-8");
  assert.match(await vtt.text(), /Hi/);
  const pending = await get(media, chinese.url);
  assert.equal(pending.status, 425);
  assert.equal(pending.headers.get("retry-after"), "3");
  assert.deepEqual(media.selectSubtitles(descriptor.sessionId, ["s_zh"]).selected.subtitles, ["s_zh"]);
});

test("expired upstream URLs are refreshed from the source once", async (t) => {
  let refreshed = 0;
  const upstream = await origin(t, (req, res) => {
    if (req.url.includes("old")) {
      res.writeHead(403);
      res.end();
    } else serveBytes(res, req, FILE);
  });
  const media = await pipelineFor(t);
  const descriptor = await open(media, {
    input: { type: "file", url: `${upstream.url}/old.mp4` },
    refresh: async () => {
      refreshed += 1;
      return { type: "file", url: `${upstream.url}/new.mp4` };
    },
  });
  const response = await get(media, descriptor.delivery.url, { range: "bytes=0-99" });
  assert.equal(response.status, 206);
  assert.equal(refreshed, 1);
  assert.deepEqual(upstream.requests.map((request) => request.url), ["/old.mp4", "/new.mp4"]);
});

test("a live DVR playlist is served as a window, and its segments on demand", async (t) => {
  const upstream = await origin(t, (req, res) => {
    if (req.url === "/live.m3u8") res.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\nseg/0.ts\n#EXTINF:2,\nseg/1.ts\n");
    else serveBytes(res, req, FILE, "video/mp2t");
  });
  const media = await pipelineFor(t);
  const parse = (body) => (body.includes("seg/") ? {
    mediaSequence: 0, latestSequence: 1, segmentDuration: 2, startedAt: 1000, liveEdge: 1004, targetDuration: 2,
    segmentUrl: (sequence) => (sequence <= 1 ? `${upstream.url}/seg/${sequence}.ts` : null),
  } : null);
  const descriptor = await open(media, { isLive: true, input: { type: "hls", url: `${upstream.url}/live.m3u8`, live: { parse } } });
  assert.deepEqual(descriptor.liveDvr, { available: true, defaultLatencySeconds: 30 });
  const window = await (await get(media, `${descriptor.delivery.url}?at=1002`)).text();
  assert.match(window, /#EXT-X-DRIVE-IN-PLAY-START:1002/);
  const segment = window.split("\n").find((line) => line.endsWith("/1"));
  assert.equal((await get(media, segment)).status, 200);
});

// A <video> element treats a live playlist's last segment as the live edge:
// its window ends at the newest published segment, without the canvas
// engine's runway of segments not published yet.
test("a live DVR playlist for a <video> element ends at the newest segment", async (t) => {
  const upstream = await origin(t, (req, res) => {
    if (req.url === "/live.m3u8") res.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\nseg/0.ts\n#EXTINF:2,\nseg/1.ts\n#EXTINF:2,\nseg/2.ts\n");
    else serveBytes(res, req, FILE, "video/mp2t");
  });
  const media = await pipelineFor(t);
  const parse = (body) => (body.includes("seg/") ? {
    mediaSequence: 0, latestSequence: 2, segmentDuration: 2, startedAt: 1000, liveEdge: 1006, targetDuration: 2,
    segmentUrl: (sequence) => (sequence <= 2 ? `${upstream.url}/seg/${sequence}.ts` : null),
  } : null);
  const windowFor = async (renderer) => {
    const descriptor = await open(media, { isLive: true, input: { type: "hls", url: `${upstream.url}/live.m3u8`, live: { parse } } }, { request: { capabilities: normalizeCapabilities({ renderer }) } });
    const body = await (await get(media, `${descriptor.delivery.url}?at=1000`)).text();
    return body.split("\n").filter((line) => line.startsWith("/m/")).map((line) => Number(line.split("/").at(-1)));
  };
  assert.deepEqual(await windowFor("html5-video"), [0, 1, 2], "back to the start of the DVR, up to the newest segment");
  assert.ok((await windowFor("canvas-webcodecs")).at(-1) > 2, "the canvas engine's runway");
});

// A DASH-style MP4: an empty moov, a sidx listing `sizes`, then the
// segments (2 seconds each), enough for the split delivery.
function dashFile(sizes) {
  const moov = Buffer.alloc(8);
  moov.writeUInt32BE(8, 0);
  moov.write("moov", 4, "ascii");
  const sidx = Buffer.alloc(32 + 12 * sizes.length);
  sidx.writeUInt32BE(sidx.length, 0);
  sidx.write("sidx", 4, "ascii");
  sidx.writeUInt32BE(1, 12);
  sidx.writeUInt32BE(1000, 16);
  sidx.writeUInt16BE(sizes.length, 30);
  sizes.forEach((size, index) => {
    sidx.writeUInt32BE(size, 32 + 12 * index);
    sidx.writeUInt32BE(2000, 36 + 12 * index);
  });
  return Buffer.concat([moov, sidx, ...sizes.map((size, index) => Buffer.alloc(size, index + 1))]);
}

// Mirrors of one file (Input `alternates`), each its own host. For segment
// ranges (not the file's head, which the stream's probe reads), `silent`
// never answers, `stall` sends 40% of each range and then nothing, `once`
// does that for its first range only and is silent afterwards, and `good`
// serves it. The node treats every host alike: the names only describe
// this fixture.
async function mirrorCdn(t, files) {
  const state = { requests: [] };
  const hosts = {};
  for (const mirror of ["silent", "stall", "once", "good"]) {
    let served = 0;
    hosts[mirror] = await origin(t, (req, res) => {
      const body = files[req.url.slice(1)];
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
      const start = Number(range?.[1] ?? 0);
      if (start === 0) return serveBytes(res, req, body);
      state.requests.push({ mirror, range: req.headers.range });
      if (mirror === "good") return serveBytes(res, req, body);
      if (mirror === "silent" || (mirror === "once" && served++ > 0)) return;
      const end = Number(range[2]);
      res.writeHead(206, { "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
      res.write(body.subarray(start, start + Math.floor((end - start + 1) * 0.4)));
    });
  }
  const mirrors = (name, order) => ({ url: `${hosts[order[0]].url}/${name}`, alternates: order.slice(1).map((mirror) => `${hosts[mirror].url}/${name}`) });
  return { mirrors, segmentRequests: () => state.requests };
}

// The node's upstream fetch, counting segment attempts in flight.
function countingFetch() {
  const counts = { active: 0, max: 0 };
  const fetchImpl = async (url, init = {}) => {
    if (String(init.headers?.Range).startsWith("bytes=0-")) return fetch(url, init);
    counts.active += 1;
    counts.max = Math.max(counts.max, counts.active);
    let open = true;
    const close = () => {
      if (open) counts.active -= 1;
      open = false;
    };
    init.signal?.addEventListener("abort", close, { once: true });
    const response = await fetch(url, init);
    return new Response(response.body.pipeThrough(new TransformStream({ flush: close })), response);
  };
  return { counts, fetchImpl };
}

const FAST = { firstByteMs: 100, stallMs: 300, slowMs: 5_000, giveUpMs: 800 };

test("a split segment is hedged on the next mirror, streamed from its first byte, resumed at its byte offset, and the node remembers the mirror", async (t) => {
  const video = dashFile([200_000, 200_000, 200_000]);
  const audio = dashFile([4_000, 4_000, 4_000]);
  const { mirrors, segmentRequests } = await mirrorCdn(t, { "v.mp4": video, "a.mp4": audio });
  const { counts, fetchImpl } = countingFetch();
  const media = await pipelineFor(t, { segmentTiming: FAST, fetchImpl });
  const input = { type: "split", video: mirrors("v.mp4", ["silent", "stall", "good"]), audio: mirrors("a.mp4", ["good"]) };
  const descriptor = await open(media, { input });
  const segment = (stream, index) => stream.delivery.url.replace("master.m3u8", `video/${index}.m4s`);

  const response = await get(media, segment(descriptor, 0));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "200000");
  const reader = response.body.getReader();
  const first = await reader.read();
  // The stalled mirror's bytes reach the device before any other mirror is asked for the rest.
  assert.ok(first.value.byteLength > 0);
  assert.ok(!segmentRequests().some((request) => request.mirror === "good"), "streamed before the segment was whole");
  const chunks = [first.value];
  for (let next = await reader.read(); !next.done; next = await reader.read()) chunks.push(next.value);
  const start = Number(/bytes=(\d+)-/.exec(segmentRequests()[0].range)[1]);
  assert.deepEqual(Buffer.concat(chunks), video.subarray(start, start + 200_000));
  assert.deepEqual(segmentRequests().map((request) => [request.mirror, request.range]), [
    ["silent", `bytes=${start}-${start + 199_999}`],
    ["stall", `bytes=${start}-${start + 199_999}`],
    ["good", `bytes=${start + 80_000}-${start + 199_999}`],
  ]);
  assert.equal(counts.max, 2, "at most two attempts at once");
  assert.equal(media.status().hedges, 2);

  // Another session of the same mirrors starts on the one that worked.
  const later = await open(media, { input });
  const before = segmentRequests().length;
  const second = await get(media, segment(later, 1));
  assert.equal((await second.arrayBuffer()).byteLength, 200_000);
  assert.deepEqual(segmentRequests().slice(before).map((request) => request.mirror), ["good"]);
  assert.equal(media.status().hedges, 2);
});

test("a split segment that cannot progress fails inside the device's segment timeout", async (t) => {
  assert.ok(SEGMENT_TIMING.giveUpMs <= DEVICE_SEGMENT_TIMEOUT_MS - 1_000, "the node gives up before the device does");
  assert.ok(SEGMENT_TIMING.firstByteMs * 3 + SEGMENT_TIMING.stallMs < SEGMENT_TIMING.giveUpMs, "three mirrors get their chance first");
  const video = dashFile([200_000, 200_000]);
  const { mirrors } = await mirrorCdn(t, { "v.mp4": video, "a.mp4": dashFile([4_000, 4_000]) });
  const media = await pipelineFor(t, { segmentTiming: FAST });
  const timed = async (promise) => {
    const startedAt = Date.now();
    const value = await promise;
    return { value, ms: Date.now() - startedAt };
  };

  // No mirror answers: a 504 before the device's own timeout.
  const silent = await open(media, { input: { type: "split", video: mirrors("v.mp4", ["silent", "silent"]), audio: mirrors("a.mp4", ["good"]) } });
  const refused = await timed(get(media, silent.delivery.url.replace("master.m3u8", "video/0.m4s")));
  assert.equal(refused.value.status, 504);
  assert.equal((await refused.value.json()).code, "UPSTREAM_TIMEOUT");
  assert.ok(refused.ms >= FAST.giveUpMs && refused.ms < FAST.giveUpMs + 1_000, `answered after ${refused.ms} ms`);

  // Every mirror stalls mid-body: the body ends in an error, not silence.
  const stalled = await open(media, { input: { type: "split", video: mirrors("v.mp4", ["once", "silent"]), audio: mirrors("a.mp4", ["good"]) } });
  const response = await get(media, stalled.delivery.url.replace("master.m3u8", "video/1.m4s"));
  assert.equal(response.status, 200);
  const read = await timed(response.arrayBuffer().then(() => null, (error) => error));
  assert.ok(read.value instanceof Error, "the body fails");
  assert.ok(read.ms < FAST.giveUpMs + 1_000, `failed after ${read.ms} ms`);
});

test("a file's mirror that errors is skipped, also while probing a split stream", async (t) => {
  const video = dashFile([10_000, 10_000]);
  const upstream = await origin(t, (req, res) => {
    if (req.url.startsWith("/down/") || req.url.startsWith("/gone/")) {
      res.writeHead(req.url.startsWith("/down/") ? 502 : 404);
      res.end();
      return;
    }
    serveBytes(res, req, req.url.endsWith("v.mp4") ? video : FILE);
  });
  const media = await pipelineFor(t);
  const file = await open(media, { input: { type: "file", url: `${upstream.url}/down/a.mp4`, alternates: [`${upstream.url}/up/a.mp4`] } });
  const response = await get(media, file.delivery.url, { range: "bytes=0-99" });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 100);

  const split = await open(media, {
    input: {
      type: "split",
      video: { url: `${upstream.url}/down/v.mp4`, alternates: [`${upstream.url}/up/v.mp4`] },
      audio: { url: `${upstream.url}/up/v.mp4` },
    },
  });
  assert.equal(split.delivery.type, "hls", "probed through the alternate");
  // Without alternates, an error is still an error.
  const single = await open(media, { input: { type: "file", url: `${upstream.url}/gone/b.mp4` } });
  assert.equal((await get(media, single.delivery.url, { range: "bytes=0-9" })).status, 404);
});
