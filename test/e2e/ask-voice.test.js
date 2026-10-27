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
// speech server, the words show while it still listens, and they go to the
// agent as soon as the pause ends it. Held down, the microphone listens
// through the pause until it is let go. It proves
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
    calls.push({ path: req.url, rate: file.readUInt32LE(24), channels: file.readUInt16LE(22), seconds: (file.length - 44) / 32_000, prompt: form.get("prompt"), language: form.get("language") });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      language: "chinese", text: "播放老友记", segments: [{ start: 0, end: 1, text: "播放老友记", no_speech_prob: 0.01, avg_logprob: -0.2 }],
    }));
  });
  return { url: `${url}/v1`, calls };
}

// An agent that says what it was asked, after `prefix`.
async function echoAgent(dir, { id = "echo", title = "Echo", prefix = "Heard: " } = {}) {
  const plugin = join(dir, `agent-${id}`);
  await mkdir(plugin);
  await writeFile(join(plugin, "package.json"), JSON.stringify({ name: `agent-${id}`, version: "0.0.0", type: "module", yolo: { node: "./node.js" } }));
  await writeFile(join(plugin, "node.js"), `export default function (yolo) {
  yolo.registerAgent(${JSON.stringify(id)}, { title: ${JSON.stringify(title)}, async ask(request) { return { text: ${JSON.stringify(prefix)} + request.text }; } });
}
`);
  return plugin;
}

test("a request said into the microphone shows as it is said and is asked when it ends", { timeout: 300_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "yolo-voice-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const speech = await speechServer(t);
  const yolo = await startYolo(t, {
    pluginConfig: {
      plugins: [
        join(root, "plugins/source-ytdlp"),
        { source: join(root, "plugins/subtitles-openai"), options: { url: speech.url, transcribeModel: "whisper-fixture" } },
        { source: await echoAgent(dir) },
        { source: await echoAgent(dir, { id: "parrot", title: "Parrot", prefix: "Parrot: " }) },
      ],
    },
  });
  const context = await launchBrowser(t, { context: { locale: "zh-CN" } });
  const { page, errors } = await openPage(context, yolo.origin, { onPage: (page) => page.addInitScript(FAKE_MICROPHONE) });
  await pair(yolo, page);
  // A browser in Chinese shows the player in Simplified Chinese (i18n.js).
  assert.deepEqual(await page.evaluate(() => [document.documentElement.lang, document.getElementById("ask-input").placeholder]), ["zh-Hans", "想看什么？"]);

  // One tap on the microphone beside Ask opens the panel already listening.
  await waitFor(page, () => !document.getElementById("btn-speak").classList.contains("hidden"), null, "the microphone beside Ask");
  await page.click("#btn-speak");
  await waitFor(page, () => document.getElementById("ask").open && document.getElementById("ask-mic").dataset.phase === "recording", null, "listening");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "ask-history-button", "no keyboard while it listens");

  // Speak: the words show while it still listens, the pause after them
  // stops the recording, and they are asked at once.
  await waitFor(page, () => document.getElementById("ask-mic").dataset.phase === "recording"
    && document.getElementById("ask-input").value === "播放老友记", null, "the words as they are said", 20_000);
  await waitFor(page, () => [...document.querySelectorAll(".ask-message")].some((item) => item.textContent === "Heard: 播放老友记"), null, "the answer", 15_000);
  assert.equal(await page.inputValue("#ask-input"), "");
  const [call] = speech.calls;
  assert.deepEqual([call.path, call.rate, call.channels, call.language, call.prompt], ["/v1/audio/transcriptions", 16_000, 1, "zh", "以下是普通话的句子。"]);
  assert.ok(speech.calls.at(-1).seconds > 1 && speech.calls.at(-1).seconds < 6, `${speech.calls.at(-1).seconds}s recorded`);

  // Held down, it listens through the pause and asks on letting go.
  const box = await page.locator("#ask-mic").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await waitFor(page, () => document.getElementById("ask-voice-status").textContent.startsWith("松开即发送"), null, "held to talk", 10_000);
  await new Promise((done) => setTimeout(done, 2_500));
  assert.equal(await page.evaluate(() => document.getElementById("ask-mic").dataset.phase), "recording");
  await page.mouse.up();
  await waitFor(page, () => document.querySelectorAll(".ask-message[data-role='user']").length === 2, null, "the held request", 15_000);

  // A question tapped goes back to the field to edit.
  await page.locator(".ask-message[data-role='user']").first().click();
  assert.equal(await page.inputValue("#ask-input"), "播放老友记");
  await eventually(async () => (await page.evaluate(() => document.getElementById("ask-mic").dataset.phase)) === "idle", "the microphone at rest");
  await page.keyboard.press("Escape");

  // Settings › This screen lists the node's agents, and the one chosen
  // answers this screen's questions from then on.
  await page.click("#btn-settings");
  await waitFor(page, () => document.querySelectorAll("#settings-agent input[type='radio']").length === 3, null, "the agents to choose from");
  assert.deepEqual(await page.locator("#settings-agent .segmented-face").allTextContents(), ["自动", "Echo", "Parrot"]);
  await page.click("#settings-agent .segmented-step:has(input[value='parrot'])");
  await page.click("#settings-close");
  await waitFor(page, () => document.getElementById("btn-ask").getAttribute("aria-label") === "问 Parrot", null, "Ask naming Parrot");
  await page.click("#btn-ask");
  await page.fill("#ask-input", "play the news");
  await page.press("#ask-input", "Enter");
  await waitFor(page, () => [...document.querySelectorAll(".ask-message")].some((item) => item.textContent === "Parrot: play the news"), null, "Parrot's answer", 15_000);
  // Echo's conversation gave way to a new one: agents share no session.
  assert.deepEqual(await page.locator(".ask-message[data-role='user']").allTextContents(), ["play the news"]);
  await page.keyboard.press("Escape");

  // The language chosen on this screen wins over the browser's: English
  // after the reload the choice makes.
  await page.click("#btn-settings");
  await waitFor(page, () => document.querySelector("#settings-language input[value='en']"), null, "the language row");
  await Promise.all([page.waitForEvent("load"), page.click("#settings-language .segmented-step:has(input[value='en'])")]);
  await waitFor(page, () => document.documentElement.lang === "en" && document.getElementById("btn-ask").getAttribute("aria-label") === "Ask Parrot", null, "the player in English");
  assert.equal(await page.evaluate(() => document.getElementById("ask-input").placeholder), "What do you want to watch?");

  assert.deepEqual(errors, []);
});
