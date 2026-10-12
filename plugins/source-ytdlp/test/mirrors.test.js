import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheIdentity } from "../src/formats.js";
import { backupUrls, mirrorCandidates, preferFastMirrors, rankMirrors } from "../src/mirrors.js";
import { createYtdlpSource, SOURCE_ID } from "../src/node.js";
import { createYtdlp } from "../src/ytdlp.js";

// Bilibili's upos mirrors as measured from the home node on 2026-10-12,
// played back by a fetch stand-in (no network): the COS mirror yt-dlp hands
// out answers at once and then stalls, ali is fast, hw refuses the
// signature, a PCDN backup is slower but steady, Akamai is never asked.
const PATH = "/upgcxcode/12/34/567/567-1-30080.m4s";
const QUERY = "?e=ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B5tZlqNxTEto8BTrNvNeZVuJ10Kj_g2UB02J0mN0B5tZlqNCNEto8BTrNvNC7MTX502C8f2jmMQJ6mqF2fka1mqx6gqj0eN0B599M=&uipk=5&nbs=1&deadline=1760300000&gen=playurlv2&os=cosovbv&oi=0&trid=abc&mid=0&platform=pc&og=cos&upsig=deadbeef&uparams=e,uipk,nbs,deadline,gen,os,oi,trid,mid,platform,og&bvc=vod&nettype=0&orderid=0,3";
const COSOV = `https://upos-sz-mirrorcosov.bilivideo.com${PATH}${QUERY}`;
const AUDIO = `https://upos-sz-mirrorcosov.bilivideo.com${PATH.replace("30080", "30280")}${QUERY}`;
const PCDN = `https://xy1x2x3x4xy.mcdn.bilivideo.cn:8082${PATH}${QUERY}`;
const AKAMAI = `https://upos-hz-mirrorakam.akamaized.net${PATH}${QUERY}`;

function cdn({ requests = [] } = {}) {
  const chunk = (size) => new Uint8Array(size).fill(1);
  const fetchImpl = async (url, init = {}) => {
    const { hostname } = new URL(url);
    requests.push({ host: hostname, range: init.headers?.Range, referer: init.headers?.Referer });
    const wanted = Number(/bytes=0-(\d+)/.exec(init.headers?.Range || "")?.[1] ?? 0) + 1;
    if (hostname.includes("akamaized")) return new Response(null, { status: 403 });
    if (hostname === "upos-sz-mirrorhw.bilivideo.com") return new Response(null, { status: 403 });
    if (hostname === "upos-sz-mirrorali.bilivideo.com") return new Response(chunk(wanted), { status: 206 });
    const body = new ReadableStream({
      async start(controller) {
        const abort = () => controller.error(new DOMException("The operation was aborted", "AbortError"));
        init.signal?.addEventListener("abort", abort, { once: true });
        if (hostname.includes("mcdn")) {
          for (let sent = 0; sent < wanted; sent += wanted / 4) {
            await new Promise((done) => setTimeout(done, 25));
            if (init.signal?.aborted) return;
            controller.enqueue(chunk(wanted / 4));
          }
          controller.close();
          return;
        }
        // The COS mirror: the first bytes at once, then nothing.
        controller.enqueue(chunk(16 * 1024));
      },
    });
    return new Response(body, { status: 206 });
  };
  return { fetchImpl, requests };
}

const probe = { bytes: 64 * 1024, timeoutMs: 800 };

test("upos URLs get the ali and hw mirrors and yt-dlp's backups as candidates; others are left alone", () => {
  assert.deepEqual(mirrorCandidates(COSOV, [PCDN, AKAMAI]).map((url) => new URL(url).host), [
    "upos-sz-mirrorcosov.bilivideo.com", "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com", "xy1x2x3x4xy.mcdn.bilivideo.cn:8082",
  ]);
  // Only the host changes: the signed path and query stay as they were.
  for (const url of mirrorCandidates(COSOV)) assert.equal(url.slice(url.indexOf(PATH)), `${PATH}${QUERY}`);
  assert.deepEqual(mirrorCandidates("https://rr1.googlevideo.com/videoplayback?id=1"), ["https://rr1.googlevideo.com/videoplayback?id=1"]);
  assert.deepEqual(backupUrls({ backup_url: [PCDN, "not a url"] }), [PCDN]);
  assert.deepEqual(backupUrls({ backupUrl: PCDN }), [PCDN]);
  assert.deepEqual(backupUrls(null), []);
});

test("probes rank mirrors by steady throughput, not by who answers first, and drop refusals", async () => {
  const { fetchImpl, requests } = cdn();
  const startedAt = Date.now();
  const { ordered, probes } = await rankMirrors(mirrorCandidates(COSOV, [PCDN, AKAMAI]), { fetchImpl, ...probe });
  assert.deepEqual(ordered.map((url) => new URL(url).hostname), [
    "upos-sz-mirrorali.bilivideo.com", "xy1x2x3x4xy.mcdn.bilivideo.cn", "upos-sz-mirrorcosov.bilivideo.com",
  ]);
  assert.ok(!requests.some((request) => request.host.includes("akamaized")), "Akamai is never asked");
  const cos = probes.find((entry) => entry.host === "upos-sz-mirrorcosov.bilivideo.com");
  assert.equal(cos.complete, false);
  assert.equal(cos.bytes, 16 * 1024);
  // The stalled mirror is cut off soon after the fast one finished, not at
  // the probe's deadline.
  assert.ok(Date.now() - startedAt < probe.timeoutMs, `ranking took ${Date.now() - startedAt} ms`);
  assert.ok(requests.every((request) => request.range === `bytes=0-${probe.bytes - 1}`));
});

test("nothing answering keeps yt-dlp's URL", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const { ordered } = await rankMirrors(mirrorCandidates(COSOV), { fetchImpl, ...probe });
  assert.deepEqual(ordered, mirrorCandidates(COSOV), "failed hosts stay, in yt-dlp's order");
  const refused = await rankMirrors(mirrorCandidates(COSOV), { fetchImpl: async () => new Response(null, { status: 403 }), ...probe });
  assert.deepEqual(refused.ordered, [COSOV]);
});

test("a split pair starts on the fastest mirror, audio follows video's hosts, the rest become alternates", async () => {
  const { fetchImpl } = cdn();
  const input = {
    type: "split",
    video: { url: COSOV, headers: { Referer: "https://www.bilibili.com/" }, cacheKey: cacheIdentity },
    audio: { url: AUDIO, headers: { Referer: "https://www.bilibili.com/" }, cacheKey: cacheIdentity },
  };
  const ranked = await preferFastMirrors(input, [{ url: COSOV, backup_url: [PCDN, AKAMAI] }, { url: AUDIO }], { fetchImpl, ...probe });
  assert.equal(new URL(ranked.video.url).hostname, "upos-sz-mirrorali.bilivideo.com");
  assert.deepEqual(ranked.video.alternates.map((url) => new URL(url).hostname), ["xy1x2x3x4xy.mcdn.bilivideo.cn", "upos-sz-mirrorcosov.bilivideo.com"]);
  assert.deepEqual([ranked.audio.url, ...ranked.audio.alternates].map((url) => new URL(url).hostname), [
    "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorcosov.bilivideo.com",
  ]);
  // Every mirror of a file shares the node's disk cache.
  assert.equal(cacheIdentity(ranked.video.url), cacheIdentity(COSOV));
  assert.equal(ranked.video.headers.Referer, "https://www.bilibili.com/");
});

test("prepare probes Bilibili mirrors and hands the node its alternates", async () => {
  const { fetchImpl, requests } = cdn();
  const info = {
    title: "Bilibili", duration: 600,
    requested_formats: [
      { format_id: "30080", url: COSOV, vcodec: "avc1.640032", acodec: "none", width: 1920, height: 1080, fps: 30, tbr: 2400, http_headers: { Referer: "https://www.bilibili.com/video/BV1" } },
      { format_id: "30280", url: AUDIO, vcodec: "none", acodec: "mp4a.40.2", abr: 192, http_headers: { Referer: "https://www.bilibili.com/video/BV1" } },
    ],
  };
  const exec = (binary, args, options, callback) => (typeof options === "function" ? options : callback)(null, JSON.stringify(info), "");
  const source = createYtdlpSource(createYtdlp({ exec }), { fetchImpl, mirrorProbe: probe, logger: { info() {}, warn() {} } });
  const stream = await source.prepare({ plugin: SOURCE_ID, id: "https://bilibili.com/video/BV1", url: "https://www.bilibili.com/video/BV1" }, {
    capabilities: { video: ["avc1"], audio: ["mp4a"], maxHeight: 720 }, startTime: 0, limits: { maxVideoKbps: 4800 }, chooseTracks: () => ({ subtitles: [], audio: null }),
  });
  assert.equal(new URL(stream.input.video.url).hostname, "upos-sz-mirrorali.bilivideo.com");
  assert.ok(stream.input.video.alternates.some((url) => new URL(url).hostname === "upos-sz-mirrorcosov.bilivideo.com"));
  assert.ok(requests.every((request) => request.referer === "https://www.bilibili.com/video/BV1"), "the probe sends yt-dlp's headers");
});
