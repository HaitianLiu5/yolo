import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { eventually, launchBrowser, openPage, pair, waitFor } from "./browser.js";
import { listen } from "./fixtures.js";
import { startYolo } from "./yolo-stack.js";

// Asking by voice (Agent Note 2026-10-18-agent-from-the-screen): a microphone
// made with Web Audio speaks for a second, the player records it from the
// microphone beside Ask, sends it as
// WAV, the official speech plugin takes it to a stand-in for the owner's
// speech server, and the words go to the agent two seconds later. It proves
// the path, not a car: the car's browser, its prompt, and its cabin
// microphone are checked in the car. (Chrome's own fake microphone waits on
// macOS's microphone permission, so the page's getUserMedia is replaced.)

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Each getUserMedia gets a second of tone, loud enough to count as speech,
// then quiet.
const FAKE_MICROPHONE = () => {
  navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext();
    await context.resume();
    const tone = context.createOscillator();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.4, context.currentTime);
    gain.gain.setValueAtTime(0, context.currentTime + 1);
    const destination = context.createMediaStreamDestination();
    tone.connect(gain).connect(destination);
    tone.start();
    return destination.stream;
  };
};

// The owner's speech server: what it was sent, and always the same words.
async function speechServer(t) {
  const calls = [];
  const url = await listen(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = await new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"] }, body: Buffer.concat(chunks) }).formData();
    const file = Buffer.from(await form.get("file").arrayBuffer());
    calls.push({ path: req.url, rate: file.readUInt32LE(24), channels: file.readUInt16LE(22), seconds: (file.length - 44) / 32_000, prompt: form.get("prompt") });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      language: "chinese", text: "播放老友记", segments: [{ start: 0, end: 1, text: "播放老友记", no_speech_prob: 0.01, avg_logprob: -0.2 }],
    }));
  });
  return { url: `${url}/v1`, calls };
}

// An agent that says what it was asked.
async function echoAgent(dir) {
  const plugin = join(dir, "agent-echo");
  await mkdir(plugin);
  await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "agent-echo", version: "0.0.0", type: "module", yolo: { node: "./node.js" } }));
  await writeFile(join(plugin, "node.js"), `export default function (yolo) {
  yolo.registerAgent("echo", { title: "Echo", async ask(request) { return { text: "Heard: " + request.text }; } });
}
`);
  return plugin;
}

test("a request said into the microphone is turned into words and sent two seconds later", { timeout: 300_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "yolo-voice-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const speech = await speechServer(t);
  const yolo = await startYolo(t, {
    pluginConfig: {
      plugins: [
        join(root, "plugins/source-ytdlp"),
        { source: join(root, "plugins/subtitles-openai"), options: { url: speech.url, transcribeModel: "whisper-fixture" } },
        { source: await echoAgent(dir) },
      ],
    },
  });
  const context = await launchBrowser(t, { context: { locale: "zh-CN" } });
  const { page, errors } = await openPage(context, yolo.origin, { onPage: (page) => page.addInitScript(FAKE_MICROPHONE) });
  await pair(yolo, page);

  // One tap on the microphone beside Ask opens the panel already listening.
  await waitFor(page, () => !document.getElementById("btn-speak").classList.contains("hidden"), null, "the microphone beside Ask");
  await page.click("#btn-speak");
  await waitFor(page, () => document.getElementById("ask").open && document.getElementById("ask-mic").dataset.phase === "recording", null, "listening");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "ask-history-button", "no keyboard while it listens");

  // Speak, and the pause after the words stops the recording.
  await waitFor(page, () => document.getElementById("ask-mic").dataset.phase === "countdown", null, "the words back", 20_000);
  assert.equal(await page.inputValue("#ask-input"), "播放老友记");
  assert.equal(speech.calls.length, 1);
  const [call] = speech.calls;
  assert.deepEqual([call.path, call.rate, call.channels, call.prompt], ["/v1/audio/transcriptions", 16_000, 1, "以下是普通话的句子。"]);
  assert.ok(call.seconds > 1 && call.seconds < 6, `${call.seconds}s recorded`);

  // Sent by itself: the agent's answer shows under the question.
  await waitFor(page, () => [...document.querySelectorAll(".ask-message")].some((item) => item.textContent === "Heard: 播放老友记"), null, "the answer", 15_000);
  assert.equal(await page.inputValue("#ask-input"), "");

  // Touching the field keeps the next words to edit.
  await page.click("#ask-mic");
  await waitFor(page, () => document.getElementById("ask-mic").dataset.phase === "countdown", null, "the second words", 20_000);
  await page.click("#ask-input");
  await new Promise((done) => setTimeout(done, 2_500));
  assert.equal(await page.inputValue("#ask-input"), "播放老友记");
  assert.equal(await page.locator(".ask-message[data-role='user']").count(), 1);
  await eventually(async () => (await page.evaluate(() => document.getElementById("ask-mic").dataset.phase)) === "idle", "the microphone at rest");

  assert.deepEqual(errors, []);
});
