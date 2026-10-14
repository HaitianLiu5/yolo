import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlayback, DEVICE_TRANSCODE_KBPS, normalizeVideoBitrate, transcodeProfile } from "../src/playback.js";
import { createPlex } from "../src/plex.js";

// A Plex Media Server stand-in that records what Yolo asks it.
function fakeServer({ viewOffset = 0, streams = [], sessions = () => [], media = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ method: init.method || "GET", path: pathname, params: Object.fromEntries(searchParams), token: init.headers?.["x-plex-token"] });
    if (pathname === "/library/metadata/42") {
      return Response.json({ MediaContainer: { Metadata: [{
        ratingKey: "42", type: "movie", title: "The Gentlemen", duration: 6_780_000, viewOffset,
        Media: [{ ...media, Part: [{ id: 7, Stream: streams, ...(media.part || {}) }] }],
      }] } });
    }
    if (pathname.endsWith("/decision")) return Response.json({ MediaContainer: { generalDecisionText: "ok" } });
    if (pathname.endsWith("/start.m3u8")) return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nsession/${searchParams.get("session")}/base/index.m3u8\n`);
    if (pathname === "/transcode/sessions") {
      const answer = sessions();
      if (answer instanceof Response) return answer;
      return Response.json(Array.isArray(answer) ? { MediaContainer: { size: answer.length, TranscodeSession: answer.map((key) => ({ key })) } } : answer);
    }
    if (pathname === "/library/parts/7") return new Response("", { status: 200 });
    return new Response("{}");
  };
  return { calls, plex: createPlex({ url: "http://plex.test:32400", token: "t0k", fetchImpl }) };
}

const choose = (choice) => (available) => ({ subtitles: choice.subtitles ?? [], audio: choice.audio ?? null, available });

test("without a Yolo position, playback resumes at Plex's viewOffset (the 0.1 restart bug)", async () => {
  const { calls, plex } = fakeServer({ viewOffset: 1_234_500 });
  const playback = createPlayback({ plex });
  const stream = await playback.prepare({ plugin: "plex", id: "42" }, { startTime: null, chooseTracks: choose({}) });
  assert.equal(stream.startTime, 1234.5);
  const start = calls.find((call) => call.path.endsWith("/start.m3u8"));
  assert.equal(start.params.offset, "1234");
  assert.equal(start.params.videoResolution, "1280x720");
  assert.equal(start.params.subtitles, "none", "Plex burns in only a chosen image subtitle");
  assert.equal(stream.input.type, "hls");
  assert.match(stream.input.manifest, /session\/yolo-[0-9a-f]+\/base\/index\.m3u8/);
  assert.deepEqual([stream.input.trimToStart, stream.input.transcoder, stream.input.cache], [true, true, false]);
  assert.equal(stream.input.headers["X-Plex-Token"], "t0k");
  assert.ok(calls.every((call) => call.token === "t0k"));

  const explicit = await playback.prepare({ plugin: "plex", id: "42" }, { startTime: 0, chooseTracks: choose({}) });
  assert.equal(explicit.startTime, 0);
  assert.equal(calls.filter((call) => call.path.endsWith("/start.m3u8")).at(-1).params.offset, undefined);
});

test("image subtitles are burned in; the part selection and audio follow the choice", async () => {
  const { calls, plex } = fakeServer({ streams: [
    { id: 1, streamType: 2, codec: "aac", channels: 2, languageCode: "eng", displayTitle: "English", selected: true },
    { id: 2, streamType: 2, codec: "ac3", channels: 6, languageCode: "jpn", displayTitle: "日本語" },
    { id: 3, streamType: 3, codec: "pgs", languageCode: "zho", language: "中文", title: "简体", displayTitle: "中文 (PGS)" },
  ] });
  const playback = createPlayback({ plex });
  const stream = await playback.prepare({ plugin: "plex", id: "42" }, { startTime: 30, chooseTracks: choose({ subtitles: ["plex:3"], audio: "plex:2" }) });
  assert.deepEqual(stream.tracks.subtitles.map((track) => [track.id, track.format, track.delivery, track.name]), [["plex:3", "image", "burn", "简体中文"]]);
  assert.deepEqual(stream.tracks.audio.map((track) => [track.id, track.detail]), [["plex:1", "AAC 2ch"], ["plex:2", "AC3 6ch"]]);
  assert.deepEqual(stream.tracks.selected, { subtitles: ["plex:3"], audio: "plex:2" });
  const put = calls.find((call) => call.method === "PUT");
  assert.deepEqual([put.params.subtitleStreamID, put.params.audioStreamID], ["3", "2"]);
  const start = calls.find((call) => call.path.endsWith("/start.m3u8"));
  assert.deepEqual([start.params.subtitles, start.params.audioStreamID], ["burn", "2"]);
});

// A bilingual ASS file as Plex serves it: a BOM, styling tags, and no title.
const BILINGUAL_ASS = `\uFEFF[Script Info]
Title: Green Book

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.20,0:00:04.50,Default,,0,0,0,,{\\fs22\\fn宋体}纽约人民，大家好！\\N{\\r}Hello New York, everyone!
`;

test("text subtitles become WebVTT the player renders; an untitled bilingual one is named by its text", async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "yolo-plex-subs-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const { plex } = fakeServer({ streams: [
    { id: 8, streamType: 3, codec: "srt", key: "/library/streams/8", languageCode: "eng", displayTitle: "English" },
    { id: 9, streamType: 3, codec: "ass", key: "/library/streams/9", displayTitle: "Unknown" },
  ] });
  const fetchImpl = plex.raw;
  const files = { "/library/streams/8": "1\n00:00:01,000 --> 00:00:04,000\nHello\n", "/library/streams/9": BILINGUAL_ASS };
  plex.raw = async (path, options) => (files[path] ? new Response(files[path]) : fetchImpl(path, options));
  const playback = createPlayback({ plex, cacheDir });
  const stream = await playback.prepare({ plugin: "plex", id: "42" }, { startTime: 0, chooseTracks: choose({ subtitles: ["plex:8"] }) });
  assert.deepEqual(stream.tracks.subtitles.map((track) => [track.id, track.delivery, track.language, track.name]), [
    ["plex:8", "vtt", "eng", "English"],
    ["plex:9", "vtt", "zho", "中英双语"],
  ]);
  assert.match(await stream.subtitle("plex:8"), /00:00:01\.000 --> 00:00:04\.000\nHello/);
  const ass = await stream.subtitle("plex:9");
  assert.match(ass, /00:00:01\.200 --> 00:00:04\.500\nHello New York, everyone!\n纽约人民，大家好！/);
  assert.doesNotMatch(ass, /宋体|\\fs22|\{\\r\}/);
});

test("health follows Plex's transcode inventory; stop and progress talk to Plex", async () => {
  let live = [];
  const { calls, plex } = fakeServer({ sessions: () => live });
  const playback = createPlayback({ plex });
  const stream = await playback.prepare({ plugin: "plex", id: "42" }, { startTime: 0, chooseTracks: choose({}) });
  const session = calls.find((call) => call.path.endsWith("/start.m3u8")).params.session;
  live = [`/transcode/sessions/${session}`];
  assert.equal(await stream.health(), "alive");
  live = [];
  assert.equal(await stream.health(), "expired");
  // Plex leaves out the list when no transcode runs.
  live = { MediaContainer: { size: 0 } };
  assert.equal(await stream.health(), "expired");
  live = new Response("", { status: 500 });
  assert.equal(await stream.health(), "unknown");
  await stream.progress({ position: 61.5, status: "playing" });
  assert.deepEqual(calls.at(-1).params, { key: "42", identifier: "com.plexapp.plugins.library", time: "61500", state: "playing" });
  await stream.stop();
  await stream.stop();
  assert.equal(calls.filter((call) => call.path.endsWith("/stop")).length, 1);
});

// Adaptive quality: a device that stalled asks for less; Plex transcodes
// smaller, never above the configured bitrate.
test("a device's bitrate cap lowers the transcode's bitrate and picture size", async () => {
  const { calls, plex } = fakeServer();
  const playback = createPlayback({ plex, videoBitrate: 4800 });
  const capped = await playback.prepare({ plugin: "plex", id: "42" }, { startTime: 0, chooseTracks: choose({}), limits: { maxVideoKbps: 1000 } });
  const start = calls.filter((call) => call.path.endsWith("/start.m3u8")).at(-1);
  assert.deepEqual([start.params.videoBitrate, start.params.maxVideoBitrate, start.params.videoResolution], ["1000", "1000", "640x360"]);
  assert.deepEqual([capped.profile.videoKbps, capped.profile.width, capped.profile.height], [1000, 640, 360]);
  await playback.prepare({ plugin: "plex", id: "42" }, { startTime: 0, chooseTracks: choose({}), limits: { maxVideoKbps: 4800 } });
  const full = calls.filter((call) => call.path.endsWith("/start.m3u8")).at(-1);
  assert.deepEqual([full.params.videoBitrate, full.params.videoResolution], ["4800", "1280x720"]);
  assert.deepEqual(transcodeProfile(4200, { maxVideoKbps: 9000 }), { videoBitrate: 4200, width: 1280, height: 720, videoResolution: "1280x720" });
  assert.equal(transcodeProfile(4800, { maxVideoKbps: 1500 }).videoResolution, "854x480");
  assert.deepEqual([transcodeProfile(4800, { maxVideoKbps: 50 }).videoBitrate, transcodeProfile(4800, { maxVideoKbps: 50 }).videoResolution], [300, "426x240"]);
  // The configured bitrate stays within what the car decodes smoothly.
  assert.equal(normalizeVideoBitrate("4200"), 4200);
  assert.equal(normalizeVideoBitrate("9000"), 4800);
});

// LAN direct play (Agent Note 2026-10-12-lan-direct-play): the original part
// when the device plays it as it is, through the node so the token never
// leaves it; otherwise Plex's direct stream at the device's picture size.
test("on the home network a playable original plays as Plex's part with the token in a header only; anything else is Plex's direct stream", async () => {
  const streams = [
    { id: 1, streamType: 1, codec: "h264", bitDepth: 8, width: 1920, height: 1080 },
    { id: 2, streamType: 2, codec: "aac", channels: 2, languageCode: "eng", default: true },
    { id: 3, streamType: 2, codec: "ac3", channels: 6, languageCode: "fra" },
  ];
  const media = { container: "mp4", bitrate: 9000, part: { key: "/library/parts/7/1700000000/file.mp4", container: "mp4" } };
  const { calls, plex } = fakeServer({ streams, media });
  const playback = createPlayback({ plex });
  const capabilities = { renderer: "html5-video", maxHeight: 2160 };
  const described = [];
  const playable = (original) => {
    described.push(original);
    return { decision: original.container === "mp4" && original.audio[0].codec === "mp4a" ? "direct" : "remux", reasons: [] };
  };
  const lan = (choice = {}, extra = {}) => playback.prepare({ plugin: "plex", id: "42" }, {
    startTime: 30, chooseTracks: choose(choice), network: "lan", capabilities, limits: { maxVideoKbps: 200_000 }, playable, ...extra,
  });

  const direct = await lan();
  assert.deepEqual(described[0], { container: "mp4", video: { codec: "avc1", profile: null, bitDepth: 8, hdr: false, width: 1920, height: 1080 }, audio: [{ codec: "mp4a", channels: 2 }], kbps: 9000 });
  assert.deepEqual(direct.input, { type: "file", url: "http://plex.test:32400/library/parts/7/1700000000/file.mp4", headers: { Accept: "*/*", "X-Plex-Token": "t0k" }, cache: false });
  assert.equal(direct.startTime, 30, "the device seeks in the original");
  assert.ok(!calls.some((call) => call.path.endsWith("/start.m3u8")), "no Plex transcode");

  // Audio other than the file's default needs Plex: its direct stream, at
  // the device's size, with a limit that lets Plex copy the video.
  const french = await lan({ audio: "plex:3" });
  assert.equal(french.input.type, "hls");
  const start = calls.filter((call) => call.path.endsWith("/start.m3u8")).at(-1).params;
  assert.deepEqual([start.directStream, start.videoResolution, start.maxVideoBitrate, start.videoBitrate], ["1", "3840x2160", "200000", String(DEVICE_TRANSCODE_KBPS)]);
  // On the relay's 4.8 Mbps, the same item is the fixed 720p transcode.
  await playback.prepare({ plugin: "plex", id: "42" }, { startTime: 30, chooseTracks: choose({}), capabilities, limits: { maxVideoKbps: 4800 }, playable });
  assert.equal(calls.filter((call) => call.path.endsWith("/start.m3u8")).at(-1).params.videoResolution, "1280x720");
});

// Remote direct play (Agent Note 2026-10-07-capability-negotiation): a
// <video> device's transcode follows its screen and the path's ceiling; the
// car's stays at 720p.
test("away from home a <video> device gets its own picture size within the remote ceiling; the car keeps 720p", async () => {
  const { calls, plex } = fakeServer();
  const playback = createPlayback({ plex });
  const remote = async (capabilities, maxVideoKbps) => {
    await playback.prepare({ plugin: "plex", id: "42" }, { startTime: 0, chooseTracks: choose({}), network: "tunnel", capabilities, limits: { maxVideoKbps } });
    const start = calls.filter((call) => call.path.endsWith("/start.m3u8")).at(-1).params;
    return [start.videoResolution, start.videoBitrate, start.maxVideoBitrate];
  };
  const browser = (maxHeight) => ({ renderer: "html5-video", maxHeight });
  assert.deepEqual(await remote(browser(1440), 20_000), ["2560x1440", "20000", "20000"]);
  assert.deepEqual(await remote(browser(1080), 20_000), ["1920x1080", "20000", "20000"]);
  // A limit carries only so tall a picture: an adaptive cap of 12 Mbps is 1440p.
  assert.deepEqual(await remote(browser(2160), 12_000), ["2560x1440", "12000", "12000"]);
  assert.deepEqual(await remote(browser(2160), 6_000), ["1280x720", "4800", "4800"]);
  const car = { renderer: "canvas-webcodecs", maxHeight: 720 };
  assert.deepEqual(await remote(car, 20_000), ["1280x720", "4800", "4800"]);
});
