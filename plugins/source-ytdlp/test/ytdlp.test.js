import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cookiesFor, createYtdlpSource, SOURCE_ID } from "../src/node.js";
import { createSubtitleStore } from "../src/subtitles.js";
import { cookieArgs, createYtdlp } from "../src/ytdlp.js";

// A yt-dlp stand-in: answers by the flags it is called with.
function fakeExec(answers, calls = []) {
  return (binary, args, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    calls.push({ binary, args });
    if (args.includes("--version")) return done(null, "2026.09.01\n", "");
    const answer = args.includes("--flat-playlist") ? answers.playlist : answers.info;
    if (answer instanceof Error) return done(answer, "", "ERROR: Unsupported URL");
    return done(null, JSON.stringify(answer), "");
  };
}

const INFO = {
  title: "Info",
  duration: 61.5,
  subtitles: { en: [{ name: "English", ext: "vtt", url: "https://subs.test/en.vtt" }], live_chat: [{ ext: "vtt", url: "https://subs.test/chat" }] },
  automatic_captions: { "zh-Hans": [{ ext: "vtt", url: "https://subs.test/zh.vtt" }], fr: [{ ext: "vtt", url: "https://subs.test/fr.vtt" }] },
};

test("claim makes the canonical URL the id and keeps the URL as given", () => {
  const source = createYtdlpSource(createYtdlp({ exec: fakeExec({}) }));
  assert.deepEqual(source.claim("https://youtu.be/abc?si=xyz"), { id: "https://youtube.com/watch?v=abc", url: "https://youtu.be/abc?si=xyz" });
  // YouTube spellings fold together; tracking parameters and fragments go.
  for (const url of ["https://www.youtube.com/watch?v=abc&t=42&utm_source=x", "https://m.youtube.com/shorts/abc"]) {
    assert.equal(source.claim(url).id, "https://youtube.com/watch?v=abc", url);
  }
  assert.equal(source.claim("http://Example.com/a?b=2&a=1#frag").id, "https://example.com/a?a=1&b=2");
  assert.equal(source.claim("ftp://example.com/a"), undefined);
  // History saved before plugins used the key "url:<canonical URL>"; D1
  // migration 0003 renames it to "ytdlp:<same URL>", which is this source key.
  assert.equal(`${SOURCE_ID}:${source.claim("https://www.youtube.com/watch?v=abc&t=3").id}`, "ytdlp:https://youtube.com/watch?v=abc");
});

test("describe, tracks and expand use yt-dlp output", async () => {
  const calls = [];
  const source = createYtdlpSource(createYtdlp({
    cookies: ["--cookies", "/c.txt"],
    exec: fakeExec({
      info: INFO,
      playlist: { title: "Mix", entries: [{ id: "a1", ie_key: "Youtube", title: "One", duration: 30 }, { url: "https://example.com/2", title: "Two" }, { title: "No url" }] },
    }, calls),
  }));
  const video = { plugin: SOURCE_ID, id: "https://example.com/v", url: "https://example.com/v?ref=1" };
  assert.deepEqual(await source.describe(video), { title: "Info", thumbnail: null, duration: 61, isLive: false });
  assert.deepEqual(calls.at(-1).args.slice(0, 2), ["--cookies", "/c.txt"]);
  assert.equal(calls.at(-1).args.at(-1), "https://example.com/v?ref=1");
  assert.deepEqual((await source.tracks(video)).subtitles.map((track) => track.id), ["s_en", "s_zh-Hans"]);
  const playlist = await source.expand("https://example.com/list");
  assert.equal(playlist.title, "Mix");
  assert.deepEqual(playlist.items.map((item) => [item.source, item.title, item.duration]), [
    [{ id: "https://youtube.com/watch?v=a1", url: "https://www.youtube.com/watch?v=a1" }, "One", 30],
    [{ id: "https://example.com/2", url: "https://example.com/2" }, "Two", null],
  ]);
  assert.deepEqual(await source.health(), { available: true, version: "2026.09.01" });
  const live = createYtdlpSource(createYtdlp({ exec: fakeExec({ info: { ...INFO, is_live: true } }) }));
  assert.equal((await live.describe(video)).isLive, true);
});

test("yt-dlp failures surface as resolve_failed", async () => {
  const ytdlp = createYtdlp({ exec: fakeExec({ info: new Error("exit 1") }) });
  await assert.rejects(ytdlp.info("https://example.com/v"), { code: "resolve_failed", message: "ERROR: Unsupported URL" });
  assert.throws(() => ytdlp.info("not a url"), { code: "invalid_request" });
});

test("cookie options replace the environment; a file wins over a browser", () => {
  assert.deepEqual(cookieArgs({ cookiesFile: " /c.txt ", cookiesFromBrowser: "chrome" }), ["--cookies", "/c.txt"]);
  assert.deepEqual(cookieArgs({}), []);
  const env = { YTDLP_COOKIES_FILE: "/env.txt", YTDLP_COOKIES_FROM_BROWSER: "safari" };
  assert.deepEqual(cookiesFor({ cookiesFromBrowser: "firefox" }, env), ["--cookies-from-browser", "firefox"]);
  assert.deepEqual(cookiesFor({}, env), ["--cookies", "/env.txt"]);
  assert.deepEqual(cookiesFor({}, { YTDLP_COOKIES_FROM_BROWSER: "safari" }), ["--cookies-from-browser", "safari"]);
});

// --- Playing (prepare) -------------------------------------------------------

const TESLA = { renderer: "canvas-webcodecs", delivery: ["hls", "mp4"], video: ["avc1"], audio: ["mp4a"], maxHeight: 720 };
const chooseNone = () => ({ subtitles: [], audio: null });

function playableExec(info, calls = []) {
  return (binary, args, options, callback) => {
    calls.push(args);
    const done = typeof options === "function" ? options : callback;
    if (args.includes("--version")) return done(null, "2026.09.01\n", "");
    return done(null, JSON.stringify(info), "");
  };
}

test("prepare picks formats for the device and describes split audio/video", async () => {
  const calls = [];
  const info = {
    title: "Split", duration: 30.4, thumbnail: "https://img.test/t.jpg",
    subtitles: { en: [{ ext: "vtt", url: "https://subs.test/en.vtt", name: "English" }] },
    requested_formats: [
      { format_id: "136", url: "https://rr1.googlevideo.com/videoplayback?id=v1&itag=136&clen=100&lmt=5&sig=a", vcodec: "avc1.4d401f", acodec: "none", width: 1280, height: 720, fps: 60, tbr: 2500 },
      { format_id: "140", url: "https://rr1.googlevideo.com/videoplayback?id=v1&itag=140&clen=50&lmt=5&sig=a", vcodec: "none", acodec: "mp4a.40.2", abr: 128 },
    ],
  };
  const source = createYtdlpSource(createYtdlp({ exec: playableExec(info, calls) }));
  const chosen = [];
  const stream = await source.prepare({ plugin: SOURCE_ID, id: "https://example.com/v", url: "https://example.com/v" }, {
    capabilities: TESLA, startTime: null, limits: { maxVideoKbps: 4800 },
    chooseTracks: (available) => {
      chosen.push(available);
      return { subtitles: ["s_en"], audio: null };
    },
  });
  const selector = calls[0][calls[0].indexOf("-f") + 1];
  assert.match(selector, /^bv\[vcodec\^=avc1\]\[height<=720\]\[tbr<=4800\]\[fps>=50\]\+ba\[acodec\^=mp4a\]/);
  assert.equal(stream.input.type, "split");
  assert.equal(stream.input.video.codec, "avc1.4d401f");
  assert.equal(stream.input.video.headers.Referer, "https://www.youtube.com/");
  // Re-signed URLs of the same file share the node's disk cache.
  assert.equal(stream.input.video.cacheKey(stream.input.video.url), "yt:v1:136:100:5");
  assert.equal(stream.input.video.alternates, undefined, "only Bilibili's upos hosts have mirrors");
  assert.equal(stream.startTime, 0);
  assert.deepEqual(stream.tracks.selected, { subtitles: ["s_en"], audio: null });
  assert.deepEqual(chosen[0].subtitles.map((track) => [track.id, track.delivery]), [["s_en", "vtt"]]);
  assert.equal(stream.profile.split, true);
  assert.equal(stream.title, "Split");
  assert.equal(typeof stream.refresh, "function");
});

// Adaptive quality: under a device's cap, formats that fit come first; when
// none does, the smallest one, never the best.
test("a device's bitrate cap picks formats under it, else the smallest", async () => {
  const calls = [];
  const source = createYtdlpSource(createYtdlp({ exec: playableExec({ title: "Capped", url: "https://cdn.test/a.mp4", vcodec: "avc1", acodec: "mp4a" }, calls) }));
  await source.prepare({ plugin: SOURCE_ID, id: "https://example.com/c", url: "https://example.com/c" }, {
    capabilities: TESLA, startTime: 0, limits: { maxVideoKbps: 700 }, chooseTracks: chooseNone,
  });
  const selector = calls[0][calls[0].indexOf("-f") + 1].split("/");
  assert.equal(selector[0], "bv[vcodec^=avc1][height<=720][tbr<=700][fps>=50]+ba[acodec^=mp4a]");
  const smallest = selector.indexOf("wv[vcodec^=avc1]+ba[acodec^=mp4a]");
  assert.ok(smallest > 0 && smallest < selector.indexOf("b*[height<=720][fps>=50]"), selector.join(" / "));
  assert.ok(selector.indexOf("b[height<=1080][tbr<=700]") < smallest, "a combined format under the cap before the smallest");
  const full = createYtdlpSource(createYtdlp({ exec: playableExec({ title: "Full", url: "https://cdn.test/a.mp4", vcodec: "avc1", acodec: "mp4a" }, calls) }));
  await full.prepare({ plugin: SOURCE_ID, id: "https://example.com/f", url: "https://example.com/f" }, { capabilities: TESLA, startTime: 0, limits: { maxVideoKbps: 4800 }, chooseTracks: chooseNone });
  assert.doesNotMatch(calls.at(-1)[calls.at(-1).indexOf("-f") + 1], /wv/, "the node's own ceiling keeps today's fallbacks");
});

test("prepare plays an HLS manifest, a combined file, and direct media links", async () => {
  const hls = createYtdlpSource(createYtdlp({ exec: playableExec({ title: "Live", is_live: true, manifest_url: "https://manifest.test/live.m3u8" }) }));
  const live = await hls.prepare({ plugin: SOURCE_ID, id: "https://www.youtube.com/watch?v=x", url: "https://www.youtube.com/watch?v=x" }, { capabilities: TESLA, startTime: 90, limits: { maxVideoKbps: 4800 }, chooseTracks: chooseNone });
  assert.deepEqual([live.input.type, live.input.maxBandwidth, live.isLive, live.startTime], ["hls", 5_056_000, true, 0]);
  assert.equal(typeof live.input.live.parse, "function", "YouTube live gets a DVR window");

  // yt-dlp may answer a live stream with separate HLS video and audio
  // renditions of one master: play the master, not the video-only rendition.
  const master = "https://manifest.googlevideo.com/api/manifest/hls_variant/x/file/index.m3u8";
  const renditions = createYtdlpSource(createYtdlp({ exec: playableExec({
    title: "Live renditions",
    is_live: true,
    requested_formats: [
      { format_id: "232", protocol: "m3u8_native", url: "https://manifest.googlevideo.com/video.m3u8", manifest_url: master, vcodec: "avc1.4d401f", acodec: "none", height: 720 },
      { format_id: "234", protocol: "m3u8_native", url: "https://manifest.googlevideo.com/audio.m3u8", manifest_url: master, vcodec: "none", acodec: "mp4a.40.2" },
    ],
  }) }));
  const shared = await renditions.prepare({ plugin: SOURCE_ID, id: "https://www.youtube.com/watch?v=y", url: "https://www.youtube.com/watch?v=y" }, { capabilities: TESLA, startTime: null, limits: { maxVideoKbps: 4800 }, chooseTracks: chooseNone });
  assert.deepEqual([shared.input.type, shared.input.url, shared.input.maxBandwidth, shared.isLive], ["hls", master, 5_056_000, true]);
  assert.equal(typeof shared.input.live.parse, "function");

  const file = createYtdlpSource(createYtdlp({ exec: playableExec({ title: "File", url: "https://cdn.test/a.mp4", vcodec: "avc1", acodec: "mp4a" }) }));
  const progressive = await file.prepare({ plugin: SOURCE_ID, id: "https://example.com/f", url: "https://example.com/f" }, { capabilities: TESLA, startTime: 12, chooseTracks: chooseNone });
  assert.deepEqual([progressive.input.type, progressive.input.url, progressive.startTime], ["file", "https://cdn.test/a.mp4", 12]);

  const calls = [];
  const direct = createYtdlpSource(createYtdlp({ exec: playableExec({}, calls) }));
  const media = await direct.prepare({ plugin: SOURCE_ID, id: "https://cdn.test/movie.webm", url: "https://cdn.test/movie.webm" }, { capabilities: TESLA, startTime: null });
  assert.deepEqual(media.input, { type: "file", url: "https://cdn.test/movie.webm" });
  assert.equal(calls.length, 0, "direct media links need no yt-dlp");
});

test("subtitles download once, as clean WebVTT", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yolo-ytdlp-subs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let fetches = 0;
  const fetchImpl = async (url) => {
    fetches += 1;
    if (url.endsWith(".m3u8")) return new Response("#EXTM3U\nhttps://subs.test/1.vtt\nhttps://subs.test/2.vtt\n");
    if (url.endsWith("1.vtt")) return new Response("WEBVTT\n\n00:00.000 --> 00:01.000\n<c>One</c> &amp; two\n");
    if (url.endsWith("2.vtt")) return new Response("WEBVTT\n\n00:01.000 --> 00:02.000\nThree\n");
    return new Response("1\n00:00:01,000 --> 00:00:02,000\nSRT\n");
  };
  const english = { key: "en", url: "https://subs.test/list.m3u8", ext: "vtt" };
  const segmented = await createSubtitleStore({ dir, fetchImpl }).get("video", english);
  assert.match(segmented, /One & two\n/);
  assert.match(segmented, /Three/);
  assert.equal((segmented.match(/WEBVTT/g) || []).length, 1);
  assert.match(await createSubtitleStore({ dir, fetchImpl }).get("video", { key: "zh", url: "https://subs.test/zh.srt", ext: "srt" }), /^WEBVTT\n\n1\n00:00:01\.000/);
  const before = fetches;
  assert.equal(await createSubtitleStore({ dir, fetchImpl }).get("video", english), segmented, "a restarted node reads its disk cache");
  assert.equal(fetches, before);
});
