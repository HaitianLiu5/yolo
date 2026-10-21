import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { createPlayback, DEVICE_TRANSCODE_KBPS } from "../src/playback.js";
import { createPlex } from "../src/plex.js";
import { resolvePlexSubtitleDelivery } from "../src/subtitles.js";

// Plex's playback decisions that test/e2e does not reach: image subtitles
// burned in, embedded text subtitles never burned in, LAN direct play of
// the original with the token only in a header, and the transcode's size
// per device and path (Agent Notes 2026-10-07-capability-negotiation,
// 2026-10-12-lan-direct-play).

// `streams` is the part's streams, or a function of the item's ratingKey.
function fakeServer({ streams = [], media = {}, sessions = () => [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ method: init.method || "GET", path: pathname, params: Object.fromEntries(searchParams), token: init.headers?.["x-plex-token"] });
    const item = /^\/library\/metadata\/(\d+)$/.exec(pathname)?.[1];
    if (item) {
      const Stream = typeof streams === "function" ? streams(item) : streams;
      return Response.json({ MediaContainer: { Metadata: [{ ratingKey: item, type: "movie", title: "Film", duration: 6_780_000, Media: [{ ...media, Part: [{ id: 7, Stream, ...(media.part || {}) }] }] }] } });
    }
    if (pathname.endsWith("/start.m3u8")) return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nsession/${searchParams.get("session")}/base/index.m3u8\n`);
    if (pathname === "/transcode/sessions") {
      const answer = sessions();
      return answer instanceof Response ? answer : Response.json({ MediaContainer: { size: answer.length, TranscodeSession: answer.map((key) => ({ key })) } });
    }
    return Response.json({ MediaContainer: {} });
  };
  const starts = () => calls.filter((call) => call.path.endsWith("/start.m3u8"));
  return { calls, starts, plex: createPlex({ url: "http://plex.test:32400", token: "t0k", fetchImpl }) };
}
const choose = ({ subtitles = [], audio = null } = {}) => () => ({ subtitles, audio });

test("an image subtitle is burned in by Plex, the chosen audio follows, and health follows Plex's transcode sessions", async () => {
  let live = [];
  const { calls, starts, plex } = fakeServer({ sessions: () => live, streams: [
    { id: 1, streamType: 2, codec: "aac", channels: 2, languageCode: "eng", selected: true },
    { id: 2, streamType: 2, codec: "ac3", channels: 6, languageCode: "jpn" },
    { id: 3, streamType: 3, codec: "pgs", languageCode: "zho", displayTitle: "中文 (PGS)" },
  ] });
  const stream = await createPlayback({ plex }).prepare({ plugin: "plex", id: "42" }, { startTime: 30, chooseTracks: choose({ subtitles: ["plex:3"], audio: "plex:2" }) });
  assert.deepEqual(stream.tracks.subtitles.map((track) => [track.id, track.format, track.delivery]), [["plex:3", "image", "burn"]]);
  assert.deepEqual([starts()[0].params.subtitles, starts()[0].params.audioStreamID, starts()[0].params.offset], ["burn", "2", "30"]);
  assert.equal(stream.input.type, "hls");
  assert.ok(calls.every((call) => call.token === "t0k"));

  live = [`/transcode/sessions/${starts()[0].params.session}`];
  assert.equal(await stream.health(), "alive");
  live = [];
  assert.equal(await stream.health(), "expired");
  live = new Response("", { status: 500 });
  assert.equal(await stream.health(), "unknown");

  // A text subtitle whose conversion fails is burned in instead.
  const fallback = await resolvePlexSubtitleDelivery({ id: 9, codec: "ass", delivery: "external" }, async () => {
    throw new Error("subtitle source unavailable");
  });
  assert.deepEqual([fallback.fallback, fallback.burnSubtitleStreamID, fallback.subtitle.delivery], [true, 9, "burn"]);
});

test("on the home network a playable original is Plex's part with the token in a header only; other audio is Plex's direct stream", async () => {
  const streams = [
    { id: 1, streamType: 1, codec: "h264", bitDepth: 8, width: 1920, height: 1080 },
    { id: 2, streamType: 2, codec: "aac", channels: 2, languageCode: "eng", default: true },
    { id: 3, streamType: 2, codec: "ac3", channels: 6, languageCode: "fra" },
  ];
  const { starts, plex } = fakeServer({ streams, media: { container: "mp4", bitrate: 9000, part: { key: "/library/parts/7/1700000000/file.mp4", container: "mp4" } } });
  const playback = createPlayback({ plex });
  const playable = (original) => ({ decision: original.container === "mp4" && original.audio[0].codec === "mp4a" ? "direct" : "remux", reasons: [] });
  const lan = (choice) => playback.prepare({ plugin: "plex", id: "42" }, {
    startTime: 30, chooseTracks: choose(choice), network: "lan", capabilities: { renderer: "html5-video", maxHeight: 2160 }, limits: { maxVideoKbps: 200_000 }, playable,
  });
  const direct = await lan();
  assert.deepEqual(direct.input, { type: "file", url: "http://plex.test:32400/library/parts/7/1700000000/file.mp4", headers: { Accept: "*/*", "X-Plex-Token": "t0k" }, cache: false });
  assert.deepEqual([direct.startTime, starts().length], [30, 0]);

  assert.equal((await lan({ audio: "plex:3" })).input.type, "hls");
  const start = starts().at(-1).params;
  assert.deepEqual([start.directStream, start.videoResolution, start.videoBitrate], ["1", "3840x2160", String(DEVICE_TRANSCODE_KBPS)]);
});

test("a transcode follows a <video> or native device's screen within the path's limit; the car always gets 720p at 4.8 Mbps or less", async () => {
  const { starts, plex } = fakeServer();
  const playback = createPlayback({ plex });
  const remote = async (capabilities, maxVideoKbps) => {
    await playback.prepare({ plugin: "plex", id: "42" }, { startTime: 0, chooseTracks: choose(), network: "tunnel", capabilities, limits: { maxVideoKbps } });
    const { videoResolution, videoBitrate } = starts().at(-1).params;
    return [videoResolution, videoBitrate];
  };
  const browser = (maxHeight) => ({ renderer: "html5-video", maxHeight });
  const car = { renderer: "canvas-webcodecs", maxHeight: 720 };
  assert.deepEqual(await remote(browser(1440), 20_000), ["2560x1440", "20000"]);
  assert.deepEqual(await remote(browser(2160), 12_000), ["2560x1440", "12000"]);
  assert.deepEqual(await remote({ renderer: "native", maxHeight: 2160 }, 200_000), ["3840x2160", "20000"]);
  assert.deepEqual(await remote(car, 20_000), ["1280x720", "4800"]);
  // Adaptive quality: a stalled device's cap shrinks the picture too.
  assert.deepEqual(await remote(car, 1000), ["640x360", "1000"]);
});

// An ffmpeg stand-in on PATH for the embedded subtitle `cues`
// ([start, end, text], seconds): it writes the ASS subtitles that start
// within `-ss`/`-t`, timed from `-ss` as ffmpeg's are, and logs each run.
async function fakeFfmpeg(t, dir, cues) {
  const bin = join(dir, "bin");
  const log = join(dir, "ffmpeg-runs.jsonl");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "ffmpeg"), `#!${process.execPath}
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : null);
const from = option("-ss") ?? 0;
const until = from + (option("-t") ?? Infinity);
const time = (seconds) => new Date(seconds * 1000).toISOString().slice(12, 22);
const lines = ${JSON.stringify(cues)}.filter(([start]) => start >= from && start < until)
  .map(([start, end, text]) => "Dialogue: 0," + time(start - from) + "," + time(end - from) + ",Default,,0,0,0,," + text);
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ ss: option("-ss"), input: args[args.indexOf("-i") + 1] }) + "\\n");
process.stdout.write("[Script Info]\\nScriptType: v4.00+\\n\\n[Events]\\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\\n" + lines.join("\\n") + "\\n");
`);
  await chmod(join(bin, "ffmpeg"), 0o755);
  appendFileSync(log, "");
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  return async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("an embedded text subtitle is never burned in: Plex copies the video, the screen reads windows of it from the file at once, and its WebVTT outlives a library rescan", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "yolo-plex-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runs = await fakeFfmpeg(t, dir, [[5, 9, "Opening line"], [600, 604, "Ten minutes in\\N十分钟了"]]);
  // A rescan makes the same file item 43, whose subtitle stream has a new id.
  const subtitleIds = { 42: 3, 43: 30 };
  const { calls, starts, plex } = fakeServer({
    // The node cannot read Plex's path: ffmpeg reads the part through Plex.
    media: { container: "mkv", part: { file: "/Volumes/Films/Film.mkv", size: 40_000_000_000, key: "/library/parts/7/1/file.mkv", container: "mkv" } },
    streams: (ratingKey) => [
      { id: 1, streamType: 1, codec: "hevc", bitDepth: 10, width: 3840, height: 2160 },
      { id: 2, streamType: 2, codec: "eac3", channels: 6, default: true },
      { id: subtitleIds[ratingKey], streamType: 3, codec: "ass", index: 2, languageCode: "zho", displayTitle: "中英双语" },
    ],
  });
  const playback = createPlayback({ plex, cacheDir: join(dir, "cache"), logger: {} });
  const play = (id) => playback.prepare({ plugin: "plex", id }, {
    startTime: 600, chooseTracks: choose({ subtitles: [`plex:${subtitleIds[id]}`] }), network: "lan",
    capabilities: { renderer: "html5-video", maxHeight: 2160 }, limits: { maxVideoKbps: 200_000 }, playable: () => ({ decision: "remux", reasons: ["container"] }),
  });
  const delivery = (stream) => stream.tracks.subtitles.map((track) => [track.id, track.delivery, track.growing === true]);

  const stream = await play("42");
  assert.deepEqual(delivery(stream), [["plex:3", "vtt", true]]);
  assert.equal(starts()[0].params.subtitles, "none");
  assert.equal(calls.find((call) => call.method === "PUT").params.subtitleStreamID, "0");
  const window = await stream.subtitle("plex:3", { start: 590, end: 690 });
  assert.match(window, /^00:10:00\.000 --> 00:10:04\.000\nTen minutes in\n十分钟了$/m);
  assert.doesNotMatch(window, /Opening line/);
  assert.match((await runs()).find((run) => run.ss === 600).input, /^http:\/\/plex\.test:32400\/library\/parts\/7\/1\/file\.mkv$/);

  // The whole track, extracted meanwhile, is what an agent's transcript reads.
  let whole;
  for (let tries = 0; typeof whole !== "string" && tries < 100; tries += 1) {
    whole = await playback.subtitle("42", "plex:3");
    if (typeof whole !== "string") await new Promise((done) => setTimeout(done, 50));
  }
  assert.match(whole, /Opening line[\s\S]*Ten minutes in/);

  assert.deepEqual(delivery(await play("43")), [["plex:30", "vtt", false]]);
  assert.equal((await runs()).filter((run) => run.ss === null).length, 1, "the whole track is read from the file once");
});
