import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlayback, DEVICE_TRANSCODE_KBPS } from "../src/playback.js";
import { createPlex } from "../src/plex.js";
import { resolvePlexSubtitleDelivery } from "../src/subtitles.js";

// Plex's playback decisions that test/e2e does not reach: image subtitles
// burned in, LAN direct play of the original with the token only in a
// header, and the transcode's size per device and path
// (Agent Notes 2026-10-07-capability-negotiation, 2026-10-12-lan-direct-play).

function fakeServer({ streams = [], media = {}, sessions = () => [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ method: init.method || "GET", path: pathname, params: Object.fromEntries(searchParams), token: init.headers?.["x-plex-token"] });
    if (pathname === "/library/metadata/42") {
      return Response.json({ MediaContainer: { Metadata: [{ ratingKey: "42", type: "movie", title: "Film", duration: 6_780_000, Media: [{ ...media, Part: [{ id: 7, Stream: streams, ...(media.part || {}) }] }] }] } });
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
