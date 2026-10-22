import assert from "node:assert/strict";
import { test } from "node:test";
import { signNodeRequest } from "@useyolo/core";
import { createNodeApp } from "../src/app.js";
import { loadPlugins } from "../src/plugins.js";

const secret = "node-test-secret";

async function nodeWith(transcribe) {
  const factories = [
    (yolo) => yolo.registerAgent("helper", { async ask() { return { text: "ok" }; } }),
    ...(transcribe ? [(yolo) => yolo.registerTranscriber("speech", { transcribe })] : []),
  ];
  const plugins = await loadPlugins(factories.map((factory, index) => ({ name: `plugin-${index}`, enabled: true, options: {}, factory })));
  await plugins.start();
  return createNodeApp({ secret, plugins });
}

async function call(app, method, path, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = await signNodeRequest(secret, { method, path, body: payload });
  return app.request(path, { method, headers: { ...headers, "content-type": "application/json" }, body: payload || undefined });
}

// `seconds` of silence as the screen sends it: 16 kHz mono 16-bit WAV.
function wav(seconds, { rate = 16_000 } = {}) {
  const samples = Math.round(seconds * rate);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + samples * 2, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes.toString("base64");
}

test("a screen's recording comes back as the words of one request", async () => {
  const heard = [];
  const app = await nodeWith(async (request) => {
    heard.push(request);
    return { language: "zh", segments: [{ start: 0, end: 1, text: "播放" }, { start: 1, end: 2, text: "老友记 " }, { start: 2, end: 2.5, text: "season 2" }] };
  });
  assert.deepEqual(await (await call(app, "GET", "/internal/v1/agent")).json(), { available: true, id: "helper", title: "helper", agents: [{ id: "helper", title: "helper", available: true }], speech: true });

  const response = await call(app, "POST", "/internal/v1/speech/transcribe", { audio: wav(2.5), language: "zh-CN", device: "car" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "播放老友记 season 2", language: "zh" });
  // The transcriber gets the WAV itself; the language is detected, and a
  // Chinese browser's prompt keeps the characters simplified.
  assert.equal(heard[0].format, "wav");
  assert.equal(heard[0].audio.length, 44 + 2.5 * 32_000);
  assert.equal(heard[0].language, null);
  assert.equal(heard[0].prompt, "以下是普通话的句子。");

  await call(app, "POST", "/internal/v1/speech/transcribe", { audio: wav(1), language: "en-US" });
  assert.equal(heard[1].prompt, null);
});

test("only a short 16 kHz mono WAV is taken, and a moment of sound is no request", async () => {
  let asked = 0;
  const app = await nodeWith(async () => {
    asked += 1;
    return { segments: [] };
  });
  const status = async (body) => (await call(app, "POST", "/internal/v1/speech/transcribe", body)).status;
  assert.equal(await status({}), 400);
  assert.equal(await status({ audio: Buffer.from("not a wav file at all, but long enough to have a header").toString("base64") }), 400);
  assert.equal(await status({ audio: wav(1, { rate: 48_000 }) }), 400);
  assert.equal(await status({ audio: wav(31) }), 400);
  const short = await call(app, "POST", "/internal/v1/speech/transcribe", { audio: wav(0.1) });
  assert.deepEqual(await short.json(), { text: "", language: null });
  assert.equal(asked, 0);
});

test("without a transcriber there is no voice, and a newer recording from a screen stops its older one", async () => {
  const none = await nodeWith(null);
  assert.equal((await (await call(none, "GET", "/internal/v1/agent")).json()).speech, undefined);
  assert.equal((await call(none, "POST", "/internal/v1/speech/transcribe", { audio: wav(1) })).status, 404);

  const signals = [];
  const app = await nodeWith(({ signal }) => new Promise((resolve, reject) => {
    signals.push(signal);
    if (signals.length === 2) resolve({ segments: [{ start: 0, end: 1, text: "play friends" }] });
    signal.addEventListener("abort", () => reject(signal.reason));
  }));
  const first = call(app, "POST", "/internal/v1/speech/transcribe", { audio: wav(1), device: "car" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await call(app, "POST", "/internal/v1/speech/transcribe", { audio: wav(1), device: "car" });
  assert.deepEqual(await second.json(), { text: "play friends", language: null });
  const replaced = await first;
  assert.equal(replaced.status, 409);
  assert.equal((await replaced.json()).error.code, "superseded");
});

test("a speech server's failure says what failed", async () => {
  const app = await nodeWith(async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
  });
  const response = await call(app, "POST", "/internal/v1/speech/transcribe", { audio: wav(1) });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /^Speech to text failed: connect ECONNREFUSED/);
});
