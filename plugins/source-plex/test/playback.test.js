import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlayback, normalizeVideoBitrate, sessionHealth, transcodeParams } from "../src/playback.js";
import { createPlex, subtitleLabel } from "../src/plex.js";

// A Plex Media Server stand-in that records what Yolo asks it.
function fakeServer({ viewOffset = 0, streams = [], sessions = () => [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ method: init.method || "GET", path: pathname, params: Object.fromEntries(searchParams), token: init.headers?.["x-plex-token"] });
    if (pathname === "/library/metadata/42") {
      return Response.json({ MediaContainer: { Metadata: [{
        ratingKey: "42", type: "movie", title: "The Gentlemen", duration: 6_780_000, viewOffset,
        Media: [{ Part: [{ id: 7, Stream: streams }] }],
      }] } });
    }
    if (pathname.endsWith("/decision")) return Response.json({ MediaContainer: { generalDecisionText: "ok" } });
    if (pathname.endsWith("/start.m3u8")) return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nsession/${searchParams.get("session")}/base/index.m3u8\n`);
    if (pathname === "/transcode/sessions") return Response.json({ MediaContainer: { size: sessions().length, TranscodeSession: sessions().map((key) => ({ key })) } });
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

test("text subtitles become WebVTT the player renders", async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "yolo-plex-subs-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const { plex } = fakeServer({ streams: [{ id: 8, streamType: 3, codec: "srt", key: "/library/streams/8", languageCode: "eng", displayTitle: "English" }] });
  const fetchImpl = plex.raw;
  plex.raw = async (path, options) => (path === "/library/streams/8"
    ? new Response("1\n00:00:01,000 --> 00:00:04,000\nHello\n")
    : fetchImpl(path, options));
  const playback = createPlayback({ plex, cacheDir });
  const stream = await playback.prepare({ plugin: "plex", id: "42" }, { startTime: 0, chooseTracks: choose({ subtitles: ["plex:8"] }) });
  assert.deepEqual(stream.tracks.subtitles.map((track) => [track.id, track.delivery]), [["plex:8", "vtt"]]);
  assert.match(await stream.subtitle("plex:8"), /00:00:01\.000 --> 00:00:04\.000\nHello/);
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
  await stream.progress({ position: 61.5, status: "playing" });
  assert.deepEqual(calls.at(-1).params, { key: "42", identifier: "com.plexapp.plugins.library", time: "61500", state: "playing" });
  await stream.stop();
  await stream.stop();
  assert.equal(calls.filter((call) => call.path.endsWith("/stop")).length, 1);
});

test("helpers", () => {
  assert.equal(normalizeVideoBitrate("4200"), 4200);
  assert.equal(normalizeVideoBitrate("9000"), 4800);
  assert.equal(transcodeParams("1", { session: "s", videoBitrate: 4800 }).get("subtitles"), "none");
  assert.equal(sessionHealth({ MediaContainer: { size: 0 } }, "s"), "expired");
  assert.equal(sessionHealth(null, "s"), "unknown");
  assert.equal(subtitleLabel({ languageCode: "zho", title: "简英双语 chs&eng" }), "简英双语");
  assert.equal(subtitleLabel({ language: "English", displayTitle: "English", title: "English SDH" }), "English (SDH)");
});
