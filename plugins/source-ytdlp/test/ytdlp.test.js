import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFormatSelector } from "../src/formats.js";
import { cookiesFor, createYtdlpSource, SOURCE_ID } from "../src/node.js";
import { subtitleEntries } from "../src/subtitles.js";
import { createYtdlp } from "../src/ytdlp.js";

// The yt-dlp source: what it asks yt-dlp for per device, and the Input its
// prepare() returns (Agent Notes 2026-10-07-capability-negotiation and
// 2026-10-11-node-media-pipeline). test/e2e plays it through the stack.

const CAR = { renderer: "canvas-webcodecs", delivery: ["hls", "mp4"], video: ["avc1"], audio: ["mp4a"], maxHeight: 720 };
const chooseNone = () => ({ subtitles: [], audio: null });

// A yt-dlp stand-in that answers every run with `info` and records its args;
// `options` go to the source (a fetch stand-in, for one).
function source(info, calls = [], options = {}) {
  const exec = (binary, args, execOptions, callback) => {
    calls.push(args);
    (typeof execOptions === "function" ? execOptions : callback)(null, args.includes("--version") ? "2026.09.01\n" : JSON.stringify(info), "");
  };
  return createYtdlpSource(createYtdlp({ exec }), options);
}
const play = (src, id, startTime = 0) => src.prepare({ plugin: SOURCE_ID, id, url: id }, { capabilities: CAR, startTime, limits: { maxVideoKbps: 4800 }, chooseTracks: chooseNone });

test("the car asks for H.264 only, 720p for fast motion and 1080p below 50 fps; a taller announced codec comes before H.264 at a lower height", () => {
  const car = buildFormatSelector({ targetHeight: 720, maxVideoKbps: 4800, videoCodecs: ["avc1"], audioCodec: "mp4a" }).split("/");
  assert.equal(car[0], "bv[vcodec^=avc1][height<=720][tbr<=4800][fps>=50]+ba[acodec^=mp4a]");
  assert.ok(car.includes("bv[vcodec^=avc1][height<=1080][tbr<=4800][fps<50]+ba[acodec^=mp4a]"));
  // The canvas engine decodes H.264 only: any other codec is excluded, never asked for.
  assert.doesNotMatch(car.join("/"), /vcodec\^=(?:av01|vp09|hvc1)/);
  for (const any of car.filter((alternative) => /^bv\[height/.test(alternative))) {
    for (const family of ["av01", "vp09", "hvc1"]) assert.ok(any.includes(`[vcodec!^=?${family}]`), any);
  }

  const browser = buildFormatSelector({ targetHeight: 1440, maxVideoKbps: 20_000, videoCodecs: ["avc1", "vp09", "av01"], audioCodec: "mp4a" }).split("/");
  const tallAv1 = browser.indexOf("bv[vcodec^=av01][ext=mp4][protocol^=http][protocol!*=dash][dynamic_range=SDR][height<=1440][height>1080][tbr<=20000][fps>=50]+ba[acodec^=mp4a]");
  const avc1080 = browser.indexOf("bv[vcodec^=avc1][height<=1080][tbr<=20000][fps>=50]+ba[acodec^=mp4a]");
  assert.ok(tallAv1 >= 0 && tallAv1 < avc1080);
});

test("prepare returns a split Input with the device's selector, an HLS master for live, a file, and a direct link without yt-dlp", async () => {
  const calls = [];
  const split = await play(source({
    title: "Split", duration: 30.4,
    requested_formats: [
      { format_id: "136", url: "https://rr1.googlevideo.com/videoplayback?id=v1&itag=136&clen=100&lmt=5&sig=a", vcodec: "avc1.4d401f", acodec: "none", width: 1280, height: 720, fps: 60, tbr: 2500 },
      { format_id: "140", url: "https://rr1.googlevideo.com/videoplayback?id=v1&itag=140&clen=50&lmt=5&sig=a", vcodec: "none", acodec: "mp4a.40.2", abr: 128 },
    ],
  }, calls), "https://example.com/v", null);
  assert.match(calls[0][calls[0].indexOf("-f") + 1], /^bv\[vcodec\^=avc1\]\[height<=720\]\[tbr<=4800\]/);
  assert.deepEqual([split.input.type, split.input.video.codec, split.input.audio.codec, split.startTime], ["split", "avc1.4d401f", "mp4a.40.2", 0]);
  // Re-signed URLs of the same file share the node's disk cache.
  assert.equal(split.input.video.cacheKey(split.input.video.url), "yt:v1:136:100:5");

  // A live stream's separate renditions play as their master, with a DVR window.
  const master = "https://manifest.googlevideo.com/api/manifest/hls_variant/x/file/index.m3u8";
  const live = await play(source({ title: "Live", is_live: true, requested_formats: [
    { format_id: "232", protocol: "m3u8_native", url: "https://manifest.googlevideo.com/video.m3u8", manifest_url: master, vcodec: "avc1.4d401f", acodec: "none", height: 720 },
    { format_id: "234", protocol: "m3u8_native", url: "https://manifest.googlevideo.com/audio.m3u8", manifest_url: master, vcodec: "none", acodec: "mp4a.40.2" },
  ] }), "https://www.youtube.com/watch?v=y", 90);
  assert.deepEqual([live.input.type, live.input.url, live.input.maxBandwidth, live.isLive, live.startTime], ["hls", master, 5_056_000, true, 0]);
  assert.equal(typeof live.input.live.parse, "function");

  // An HLS format with no master and no codecs plays its own playlist, not as a file.
  const media = await play(source({ title: "Media playlist", protocol: "m3u8_native", ext: "mp4", url: "https://cdn.test/media/playlist?vkey=1", vcodec: null, acodec: null }), "https://example.com/h");
  assert.deepEqual([media.input.type, media.input.url], ["hls", "https://cdn.test/media/playlist?vkey=1"]);

  const file = await play(source({ title: "File", url: "https://cdn.test/a.mp4", vcodec: "avc1", acodec: "mp4a" }), "https://example.com/f", 12);
  assert.deepEqual([file.input.type, file.input.url, file.startTime], ["file", "https://cdn.test/a.mp4", 12]);

  const none = [];
  assert.deepEqual((await play(source({}, none), "https://cdn.test/movie.webm")).input, { type: "file", url: "https://cdn.test/movie.webm" });
  assert.equal(none.length, 0, "direct media links need no yt-dlp");
});

test("claim's canonical URL is the item's id, the source key D1 migration 0003 wrote; plugin options win over the environment's cookies", () => {
  const ytdlp = source({});
  assert.deepEqual(ytdlp.claim("https://youtu.be/abc?si=xyz"), { id: "https://youtube.com/watch?v=abc", url: "https://youtu.be/abc?si=xyz" });
  assert.equal(`${SOURCE_ID}:${ytdlp.claim("https://www.youtube.com/watch?v=abc&t=3").id}`, "ytdlp:https://youtube.com/watch?v=abc");
  assert.equal(ytdlp.claim("http://Example.com/a?b=2&a=1#frag").id, "https://example.com/a?a=1&b=2");
  assert.equal(ytdlp.claim("ftp://example.com/a"), undefined);

  const env = { YTDLP_COOKIES_FILE: "/env.txt", YTDLP_COOKIES_FROM_BROWSER: "safari" };
  assert.deepEqual(cookiesFor({ cookiesFromBrowser: "firefox" }, env), ["--cookies-from-browser", "firefox"]);
  assert.deepEqual(cookiesFor({}, env), ["--cookies", "/env.txt"]);
});

test("subtitles are named in their own language, with no \"(auto)\" in the name", () => {
  const vtt = (lang) => [{ ext: "vtt", url: `https://subs.test/${lang}.vtt` }];
  const entries = subtitleEntries({ subtitles: { "ai-zh": vtt("zh"), "ai-ja": vtt("ja"), "ai-ar": vtt("ar"), en: vtt("en") } });
  assert.deepEqual(entries.map((entry) => [entry.lang, entry.name, entry.auto]), [
    ["zh", "中文", true], ["ja", "日本語", true], ["ar", "العربية", true], ["en", "English", false],
  ]);
});

test("a Bilibili video's run is its parts from one flat listing, named by Bilibili's part list, and a lone video's costs no run", async () => {
  const parts = {
    _type: "playlist",
    title: "Nathan For You S1",
    entries: [1, 2, 3].map((p) => ({ _type: "url", url: `https://www.bilibili.com/video/BV19i4y147HP?p=${p}`, title: null })),
  };
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    return Response.json({ code: 0, data: [1, 2, 3].map((page) => ({ page, part: `S01E0${page}`, duration: 1260 + page })) });
  };
  const calls = [];
  const src = source(parts, calls, { fetchImpl });
  // The page without ?p= is the first part; the listing is asked without it too.
  const run = await src.sequence({ plugin: SOURCE_ID, id: "https://bilibili.com/video/BV19i4y147HP", url: "https://www.bilibili.com/video/BV19i4y147HP" });
  assert.equal(run.index, 0);
  assert.equal(run.title, "Nathan For You S1");
  assert.deepEqual(run.items[1].source, { id: "https://bilibili.com/video/BV19i4y147HP?p=2", url: "https://www.bilibili.com/video/BV19i4y147HP?p=2" });
  assert.deepEqual([run.items[1].title, run.items[1].label, run.items[1].duration], ["S01E02", "P2", 1262]);
  assert.ok(calls[0].includes("--flat-playlist"));
  assert.equal(calls[0].at(-1), "https://www.bilibili.com/video/BV19i4y147HP");
  assert.equal(asked[0], "https://api.bilibili.com/x/player/pagelist?bvid=BV19i4y147HP");

  const third = await src.sequence({ plugin: SOURCE_ID, id: "https://bilibili.com/video/BV19i4y147HP?p=3", url: "https://www.bilibili.com/video/BV19i4y147HP?p=3" });
  assert.equal(third.index, 2);
  assert.equal(calls.length, 1, "the parts share one listing");
  assert.equal(asked.length, 1, "and one part list");

  // Without Bilibili's part list, a part keeps its place and is left for describe().
  const unnamed = await source(parts, [], { fetchImpl: async () => new Response("", { status: 412 }), logger: { warn() {} } })
    .sequence({ plugin: SOURCE_ID, id: "https://bilibili.com/video/BV19i4y147HP", url: "https://www.bilibili.com/video/BV19i4y147HP" });
  assert.equal("title" in unnamed.items[1], false);
  assert.equal(unnamed.items[1].label, "P2");

  const lone = [];
  assert.equal(await source(parts, lone, { fetchImpl }).sequence({ plugin: SOURCE_ID, id: "https://youtube.com/watch?v=abc", url: "https://youtu.be/abc" }), null);
  assert.equal(lone.length, 0);
});

test("a YouTube URL with list= is in its playlist, found by the video whatever the list", async () => {
  const playlist = {
    _type: "playlist",
    title: "Lectures",
    entries: ["a1", "b2", "c3"].map((id) => ({ _type: "url", ie_key: "Youtube", id, url: `https://www.youtube.com/watch?v=${id}`, title: `Lecture ${id}`, duration: 600 })),
  };
  const run = await source(playlist).sequence({ plugin: SOURCE_ID, id: "https://youtube.com/watch?list=PL1&v=b2", url: "https://www.youtube.com/watch?v=b2&list=PL1" });
  assert.equal(run.index, 1);
  assert.equal(run.items[2].title, "Lecture c3");
  assert.equal(run.items[2].duration, 600);
  // A listing without the video is no run.
  assert.equal(await source(playlist).sequence({ plugin: SOURCE_ID, id: "https://youtube.com/watch?list=PL1&v=zz", url: "https://www.youtube.com/watch?v=zz&list=PL1" }), null);
});

// A video names the run it is in as its show (`parents`), so Yolo's history
// continues the run as one entry (Agent Note
// 2026-10-11-yolo-owns-progress-and-resume): a Bilibili video's, once it has
// more than one part, and a playlist's.
test("a video's parents are its multi-part Bilibili video or its playlist, and a lone video has none", async () => {
  const info = { title: "Part", url: "https://cdn.test/a.mp4", vcodec: "avc1", acodec: "mp4a" };
  const partList = (count) => async () => Response.json({ code: 0, data: Array.from({ length: count }, (_, n) => ({ page: n + 1, part: `P${n + 1}` })) });
  const parentsOf = async (url, fetchImpl = partList(3)) => (await play(source(info, [], { fetchImpl, logger: { warn() {} } }), url)).parents;
  assert.deepEqual(await parentsOf("https://www.bilibili.com/video/BV19i4y147HP?p=8"), ["https://bilibili.com/video/BV19i4y147HP"]);
  assert.deepEqual(await parentsOf("https://www.bilibili.com/video/BV19i4y147HP/"), ["https://bilibili.com/video/BV19i4y147HP"]);
  assert.deepEqual(await parentsOf("https://www.bilibili.com/video/BV1qQc4zxEsi/", partList(1)), []);
  assert.deepEqual(await parentsOf("https://www.bilibili.com/video/BV1qQc4zxEsi/", async () => new Response("", { status: 412 })), []);
  assert.deepEqual(await parentsOf("https://www.youtube.com/watch?v=b2&list=PL1&index=2"), ["https://youtube.com/playlist?list=PL1"]);
  assert.deepEqual(await parentsOf("https://www.youtube.com/watch?v=b2"), []);
});

test("yt-dlp runs through the node's egress proxy when the owner has egress rules, and without --proxy otherwise", async () => {
  const calls = [];
  const exec = (binary, args, execOptions, callback) => {
    calls.push(args);
    callback(null, JSON.stringify({ title: "Fixture" }), "");
  };
  let proxy = null;
  const ytdlp = createYtdlp({ exec, proxy: () => proxy });
  await ytdlp.info("https://video.example/watch?v=1");
  proxy = "http://127.0.0.1:50123";
  await ytdlp.info("https://video.example/watch?v=1");
  assert.equal(calls[0].includes("--proxy"), false);
  assert.deepEqual(calls[1].slice(0, 2), ["--proxy", "http://127.0.0.1:50123"]);
});
