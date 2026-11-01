import assert from "node:assert/strict";
import { test } from "node:test";
import { signNodeRequest } from "@useyolo/core";
import { createNodeApp } from "../src/app.js";
import { loadPlugins } from "../src/plugins.js";

const secret = "node-test-secret";

async function nodeWith(transcribe, more = {}) {
  const factories = [
    (yolo) => yolo.registerAgent("helper", { async ask() { return { text: "ok" }; } }),
    ...(transcribe ? [(yolo) => yolo.registerTranscriber("speech", { transcribe, ...more })] : []),
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
  // The transcriber gets the WAV itself. A Chinese browser's is Chinese,
  // and its prompt keeps the characters simplified; another's language is
  // detected.
  assert.equal(heard[0].format, "wav");
  assert.equal(heard[0].audio.length, 44 + 2.5 * 32_000);
  assert.deepEqual([heard[0].language, heard[0].prompt], ["zh", "以下是普通话的句子。"]);

  await call(app, "POST", "/internal/v1/speech/transcribe", { audio: wav(1), language: "en-US" });
  assert.deepEqual([heard[1].language, heard[1].prompt], [null, null]);
});

test("the owner's languages decide what a recording is heard as, and the first wins what is unclear", async () => {
  const heard = [];
  let chances = null;
  const app = await nodeWith(async (request) => {
    heard.push([request.language, request.prompt]);
    return { language: "zh", segments: [{ start: 0, end: 1, text: "下一集" }] };
  }, { detectLanguage: async () => ({ probabilities: chances }) });
  const say = (languages, body = {}) => call(app, "POST", "/internal/v1/speech/transcribe", { audio: wav(1), language: "en-US", languages, ...body });
  const SIMPLIFIED = "以下是普通话的句子。";

  // One language is heard as it, whatever the browser's, in its script.
  await say(["zh-Hans"]);
  await say(["zh-TW"]);
  // Among several, the first unless another is more than even and ahead;
  // never one the owner does not speak, however sure the detection is.
  chances = { zh: 0.3, en: 0.45 };
  await say(["zh-Hans", "en"]);
  chances = { zh: 0.01, en: 0.97 };
  await say(["zh-Hans", "en"]);
  chances = { ko: 0.9, zh: 0.05, en: 0.04 };
  await say(["zh-Hans", "en"]);
  assert.deepEqual(heard, [
    ["zh-Hans", SIMPLIFIED],
    ["zh-Hant", "以下是普通話的句子。"],
    ["zh-Hans", SIMPLIFIED],
    ["en", null],
    ["zh-Hans", SIMPLIFIED],
  ]);

  // A transcriber that cannot tell detects as it transcribes; a language
  // the owner does not speak is heard again as the first.
  const plain = [];
  let said = "ko";
  const other = await nodeWith(async (request) => {
    plain.push([request.language, request.prompt]);
    return { language: request.language ? "zh" : said, segments: [{ start: 0, end: 1, text: "下一集" }] };
  });
  await call(other, "POST", "/internal/v1/speech/transcribe", { audio: wav(1), languages: ["zh-Hans", "en"] });
  said = "en";
  await call(other, "POST", "/internal/v1/speech/transcribe", { audio: wav(1), languages: ["zh-Hans", "en"] });
  assert.deepEqual(plain, [[null, SIMPLIFIED], ["zh-Hans", SIMPLIFIED], [null, SIMPLIFIED]]);
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
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const app = await nodeWith(({ signal }) => new Promise((resolve, reject) => {
    signals.push(signal);
    if (signals.length === 1) firstStarted();
    if (signals.length === 2) resolve({ segments: [{ start: 0, end: 1, text: "play friends" }] });
    signal.addEventListener("abort", () => reject(signal.reason));
  }));
  const first = call(app, "POST", "/internal/v1/speech/transcribe", { audio: wav(1), device: "car" });
  // The newer recording is the one that reaches the transcriber later: the
  // second goes once the first is being transcribed, however slow the machine.
  await started;
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
