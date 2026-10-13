import assert from "node:assert/strict";
import { test } from "node:test";
import { mirrorCandidates, rankMirrors } from "../src/mirrors.js";
import { createYtdlpSource, SOURCE_ID } from "../src/node.js";
import { createYtdlp } from "../src/ytdlp.js";

// A fetch stand-in for Bilibili's upos mirrors (no network). Which real host
// is good changes by the hour, so these behaviors are only fixtures: here the
// host yt-dlp hands out answers at once and then stalls, ali is fast, hw
// refuses the signature, a PCDN backup is slower but steady, and Akamai is
// never asked for a URL signed for a bilivideo host.
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

test("probes rank mirrors by steady throughput, not by who answers first, and drop refusals", async () => {
  assert.deepEqual(mirrorCandidates(AKAMAI).map((url) => new URL(url).hostname), [
    "upos-hz-mirrorakam.akamaized.net", "upos-sz-mirrorcosov.bilivideo.com", "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com",
  ], "a URL signed for Akamai is also served by every bilivideo mirror");
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

test("prepare starts a split pair on the fastest mirror, audio on video's hosts, and hands the node the rest as alternates", async () => {
  const { fetchImpl, requests } = cdn();
  const info = {
    title: "Bilibili", duration: 600,
    requested_formats: [
      { format_id: "30080", url: COSOV, backup_url: [PCDN, AKAMAI], vcodec: "avc1.640032", acodec: "none", width: 1920, height: 1080, fps: 30, tbr: 2400, http_headers: { Referer: "https://www.bilibili.com/video/BV1" } },
      { format_id: "30280", url: AUDIO, vcodec: "none", acodec: "mp4a.40.2", abr: 192, http_headers: { Referer: "https://www.bilibili.com/video/BV1" } },
    ],
  };
  const exec = (binary, args, options, callback) => (typeof options === "function" ? options : callback)(null, JSON.stringify(info), "");
  const source = createYtdlpSource(createYtdlp({ exec }), { fetchImpl, mirrorProbe: probe, logger: { info() {}, warn() {} } });
  const stream = await source.prepare({ plugin: SOURCE_ID, id: "https://bilibili.com/video/BV1", url: "https://www.bilibili.com/video/BV1" }, {
    capabilities: { video: ["avc1"], audio: ["mp4a"], maxHeight: 720 }, startTime: 0, limits: { maxVideoKbps: 4800 }, chooseTracks: () => ({ subtitles: [], audio: null }),
  });
  const { video, audio } = stream.input;
  const hosts = (track) => [track.url, ...track.alternates].map((url) => new URL(url).hostname);
  assert.deepEqual(hosts(video), ["upos-sz-mirrorali.bilivideo.com", "xy1x2x3x4xy.mcdn.bilivideo.cn", "upos-sz-mirrorcosov.bilivideo.com"]);
  assert.deepEqual(hosts(audio), ["upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorcosov.bilivideo.com"]);
  // Only the host changes: the signed path and query stay, and every mirror
  // of a file shares the node's disk cache.
  for (const url of [video.url, ...video.alternates]) assert.equal(url.slice(url.indexOf(PATH)), `${PATH}${QUERY}`);
  assert.equal(video.cacheKey(video.url), video.cacheKey(COSOV));
  assert.ok(requests.every((request) => request.referer === "https://www.bilibili.com/video/BV1"), "the probe sends yt-dlp's headers");
  assert.deepEqual([stream.profile.height, stream.profile.videoCodec, stream.profile.formatId], [1080, "avc1.640032", "30080+30280"]);
});
