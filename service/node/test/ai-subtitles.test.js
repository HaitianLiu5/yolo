import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signMediaToken } from "@useyolo/core";
import { createAiSubtitles } from "../src/ai-subtitles.js";
import { createMediaPipeline } from "../src/media/pipeline.js";
import { createSpeechRegistry } from "../src/speech.js";

// AI subtitles (Agent Note 2026-10-18-ai-subtitles): a stream offers growing
// tracks, a screen's window decides what the transcriber and translator work
// on, and ffmpeg reads the item's own sound for them.

const secret = "media-test-secret";

// A directory of files over HTTP with byte ranges, as a CDN serves them.
async function serve(t, dir) {
  const server = createServer((request, response) => {
    const file = join(dir, new URL(request.url, "http://x").pathname);
    let size;
    try {
      size = statSync(file).size;
    } catch {
      response.writeHead(404).end();
      return;
    }
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : size - 1;
    response.writeHead(range ? 206 : 200, { "content-length": end - start + 1, "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
    createReadStream(file, { start, end }).pipe(response);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const heard = (audio) => Math.round((audio.length - 44) / 32_000);

// A transcriber that says how many seconds of sound it got, at 1–3 s.
function speechWith({ translate = true, transcribe } = {}) {
  const speech = createSpeechRegistry();
  speech.add("transcriber", "fake", {
    transcribe: transcribe ?? (async ({ audio }) => ({ language: "ja", segments: [{ start: 1, end: 3, text: `heard ${heard(audio)}s` }] })),
  }, "fake");
  if (translate) speech.add("translator", "fake", { language: "zh-Hans", translate: async ({ lines }) => lines.map((line) => `译 ${line}`) }, "fake");
  return speech;
}

async function until(read, done, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("a stream offers growing AI tracks, and a screen's window gets its sound transcribed and translated", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "yolo-ai-subtitles-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=40", "-c:a", "aac", "-movflags", "+faststart", join(dir, "a.m4a"));
  const origin = await serve(t, dir);
  const media = createMediaPipeline({ secret, runtimeDir: dir, aiSubtitles: createAiSubtitles({ speech: speechWith() }) });
  media.init();
  t.after(() => media.close());

  const sessionId = "ses_ai";
  const stream = await media.open({
    sessionId,
    mediaToken: await signMediaToken(secret, { sessionId, userId: "usr_ai", exp: Math.floor(Date.now() / 1000) + 600 }),
    source: { plugin: "fixture", id: "talk" },
    descriptor: { title: "A talk", duration: 40, input: { type: "file", url: `${origin}/a.m4a` }, tracks: { subtitles: [{ id: "en", language: "en", name: "English" }], audio: [], selected: { subtitles: [], audio: null } } },
  });
  const tracks = Object.fromEntries(stream.tracks.subtitles.map((track) => [track.id, track]));
  assert.deepEqual(Object.keys(tracks), ["en", "ai-zh-Hans", "ai-original"]);
  assert.equal(tracks.en.growing, undefined);
  assert.deepEqual([tracks["ai-zh-Hans"].language, tracks["ai-zh-Hans"].auto, tracks["ai-zh-Hans"].growing], ["zh-Hans", true, true]);

  const read = async (track, query = "") => (await media.handle(new Request(`http://node.test${track.url}${query}`))).text();
  const translated = await until(() => read(tracks["ai-zh-Hans"], "?start=0&end=60"), (vtt) => vtt.includes("heard 10s"));
  assert.equal(translated, "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n译 heard 30s\n\n00:00:31.000 --> 00:00:33.000\n译 heard 10s\n\n");
  // Without a window: every cue made so far, and no new work.
  assert.match(await read(tracks["ai-original"]), /00:00:31\.000 --> 00:00:33\.000\nheard 10s/);
});

test("a live stream's chunk is read once its segments are published, from the segments themselves", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "yolo-ai-live-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-c:a", "aac", "-f", "hls", "-hls_time", "5", "-hls_segment_filename", join(dir, "seg%d.ts"), join(dir, "live.m3u8"));
  const origin = await serve(t, dir);
  const subtitles = createAiSubtitles({ speech: speechWith({ translate: false }) });
  let latestSequence = 1;
  const source = () => ({ duration: null, input: null, live: { segmentDuration: 5, latestSequence, segmentUrl: (sequence) => `${origin}/seg${sequence}.ts`, headers: null } });
  const read = () => subtitles.vtt({ key: "live", trackId: "ai-original", window: { start: 0, end: 60 }, source });

  // 15-second chunks of three 5-second segments: the first is not published yet.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(read(), "WEBVTT\n\n");
  latestSequence = 3;
  assert.equal(await until(read, (vtt) => vtt.includes("heard")), "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nheard 15s\n\n");
  latestSequence = 5;
  assert.match(await until(read, (vtt) => vtt.includes("00:00:16")), /00:00:16\.000 --> 00:00:18\.000\nheard 15s/);
});

test("a failure before anything worked is said to the screen", async () => {
  const subtitles = createAiSubtitles({ speech: speechWith() });
  // Nothing listens on the discard port.
  const source = () => ({ duration: 120, input: { type: "file", url: "http://127.0.0.1:9/a.m4a", headers: null }, live: null });
  const read = () => subtitles.vtt({ key: "item", trackId: "ai-zh-Hans", window: { start: 0, end: 60 }, source });
  assert.equal(read(), "WEBVTT\n\n");
  const failure = await until(() => {
    try {
      read();
      return null;
    } catch (error) {
      return error;
    }
  }, Boolean);
  assert.equal(failure?.code, "resolve_failed");
  assert.equal(failure.message, "AI subtitles failed: No sound could be read at 0:00");
  assert.throws(() => subtitles.vtt({ key: "item", trackId: "ai-fr", source: () => null }), { code: "not_found" });
});
