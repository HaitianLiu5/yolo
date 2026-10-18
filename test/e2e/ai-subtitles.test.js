import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { createAiSubtitles } from "../../service/node/src/ai-subtitles.js";
import { createSpeechRegistry } from "../../service/node/src/speech.js";
import { eventually, launchBrowser, openPage, pair, playingPast, waitFor } from "./browser.js";
import { fakeYtdlp, listen, mediaOrigin } from "./fixtures.js";
import { startYolo } from "./yolo-stack.js";

// AI subtitles (Agent Note 2026-10-18-ai-subtitles): the official plugin
// against a stand-in for the owner's speech server, which speaks OpenAI's
// transcription and chat completion interfaces. The node reads the item's
// sound with ffmpeg, which is why these tests live with the e2e tests.

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const exec = promisify(execFile);
const ffmpeg = (args) => exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
// Seconds of 16 kHz mono 16-bit WAV.
const heard = (bytes) => Math.round((bytes - 44) / 32_000);

// The owner's speech server: says how much sound it got, from 1 s to 20 s
// of each chunk, and translates by tagging each line.
async function speechServer(t) {
  const calls = [];
  const url = await listen(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let answer;
    if (req.url === "/v1/audio/transcriptions") {
      const form = await new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"] }, body }).formData();
      const seconds = heard(form.get("file").size);
      calls.push({ path: req.url, model: form.get("model"), seconds });
      answer = { language: "japanese", text: `heard ${seconds}s`, segments: [{ start: 1, end: 20, text: ` heard ${seconds}s`, no_speech_prob: 0.01, avg_logprob: -0.2 }] };
    } else {
      const { model, messages } = JSON.parse(body.toString("utf8"));
      const { lines } = JSON.parse(messages[1].content);
      calls.push({ path: req.url, model, lines });
      answer = { choices: [{ message: { content: JSON.stringify(lines.map((line) => `译 ${line}`)) } }] };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
  return { url: `${url}/v1`, calls };
}

test("a screen shows the translation of what the item says, made by the owner's speech server while it plays", { timeout: 300_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "yolo-e2e-ai-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=45", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=45",
    "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k", "-c:a", "libopus", join(dir, "talk.webm")]);
  const media = await mediaOrigin(t, dir);
  const speech = await speechServer(t);
  const yolo = await startYolo(t, {
    pluginConfig: {
      plugins: [
        { source: join(root, "plugins/source-ytdlp"), options: { binary: await fakeYtdlp(dir, { title: "unused" }) } },
        { source: join(root, "plugins/subtitles-openai"), options: { url: speech.url, transcribeModel: "whisper-fixture", translateModel: "llm-fixture", language: "zh-Hans" } },
      ],
    },
  });

  const context = await launchBrowser(t);
  const { page } = await openPage(context, yolo.origin);
  const credential = await pair(yolo, page);
  const agent = await yolo.agentToken();
  await yolo.mcp(agent, "play", { url: `${media.url}/talk.webm`, start_at: 0, device: credential.deviceId });
  await playingPast(page, 0.5, "the item");

  const tracks = await page.evaluate(() => globalThis.__yolo.state.tracks.subtitles.map(({ id, language, auto, growing }) => ({ id, language, auto, growing })));
  assert.deepEqual(tracks, [
    { id: "ai-zh-Hans", language: "zh-Hans", auto: true, growing: true },
    { id: "ai-original", language: "", auto: true, growing: true },
  ]);
  await yolo.api(credential.token, "/v1/playback/tracks", { method: "PUT", body: { subtitles: ["ai-zh-Hans"] } });
  await waitFor(page, () => document.getElementById("subtitle-overlay").textContent.includes("译 heard 30s"), null, "the AI subtitle");

  // The first chunk is 30 s of the item's sound; its line went to the language model.
  await eventually(() => speech.calls.some((call) => call.path === "/v1/chat/completions"), "the translation");
  assert.deepEqual(speech.calls.find((call) => call.path === "/v1/audio/transcriptions"), { path: "/v1/audio/transcriptions", model: "whisper-fixture", seconds: 30 });
  assert.deepEqual(speech.calls.find((call) => call.path === "/v1/chat/completions"), { path: "/v1/chat/completions", model: "llm-fixture", lines: ["heard 30s"] });
});

// Without the stack: what a live stream's chunks wait for, and how a failure reaches a screen.

const until = async (read, done, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

// A transcriber that says how many seconds of sound it got, at 1–3 s.
function speechWith({ translate = true } = {}) {
  const speech = createSpeechRegistry();
  speech.add("transcriber", "fake", { transcribe: async ({ audio }) => ({ language: "ja", segments: [{ start: 1, end: 3, text: `heard ${heard(audio.length)}s` }] }) }, "fake");
  if (translate) speech.add("translator", "fake", { language: "zh-Hans", translate: async ({ lines }) => lines.map((line) => `译 ${line}`) }, "fake");
  return speech;
}

test("a live stream's chunk is read once its segments are published, from the segments themselves", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "yolo-ai-live-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "hls"));
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-c:a", "aac", "-f", "hls", "-hls_time", "5", "-hls_segment_filename", join(dir, "hls", "seg%d.ts"), join(dir, "hls", "live.m3u8")]);
  const origin = await mediaOrigin(t, dir);
  const subtitles = createAiSubtitles({ speech: speechWith({ translate: false }) });
  let latestSequence = 1;
  const source = () => ({ duration: null, input: null, live: { segmentDuration: 5, latestSequence, segmentUrl: (sequence) => `${origin.url}/hls/seg${sequence}.ts`, headers: null } });
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
