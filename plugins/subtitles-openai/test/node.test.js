import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import plugin from "../src/node.js";

// The plugin speaks OpenAI's audio transcription and chat completion
// interfaces to the owner's own server (Agent Note 2026-10-18-ai-subtitles).
// A fake server stands in for it.

async function fakeServer(t, answer) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const seen = { path: request.url, authorization: request.headers.authorization ?? null };
    if (/multipart/.test(request.headers["content-type"] ?? "")) {
      const form = await new Request("http://x", { method: "POST", headers: { "content-type": request.headers["content-type"] }, body }).formData();
      seen.form = Object.fromEntries([...form.keys()].map((key) => [key, form.get(key) instanceof Blob ? `${form.get(key).size} bytes` : form.get(key)]));
    } else {
      seen.json = JSON.parse(body.toString("utf8"));
    }
    requests.push(seen);
    const [status, reply] = answer(seen);
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

function load(options, env = {}) {
  const registered = {};
  plugin({
    options,
    env,
    registerTranscriber: (id, impl) => { registered.transcriber = { id, impl }; },
    registerTranslator: (id, impl) => { registered.translator = { id, impl }; },
  });
  return registered;
}

// Two seconds of 16 kHz mono 16-bit WAV.
const wav = Buffer.alloc(44 + 64_000);

test("speech becomes timed text without what Whisper takes for silence, and lines are translated one for one with the glossary's terms", async (t) => {
  const server = await fakeServer(t, ({ path, json }) => {
    if (path === "/v1/audio/transcriptions") {
      return [200, {
        language: "japanese",
        text: "ご視聴ありがとうございました 行くぞ",
        segments: [
          { start: 0, end: 1.2, text: " ご視聴ありがとうございました", no_speech_prob: 0.9, avg_logprob: -1.4 },
          { start: 1.2, end: 2, text: " 行くぞ", no_speech_prob: 0.1, avg_logprob: -0.3 },
        ],
      }];
    }
    const { lines } = JSON.parse(json.messages[1].content);
    return [200, { choices: [{ message: { content: `Here you go:\n${JSON.stringify(lines.map((line) => `[zh] ${line}`))}` } }] }];
  });
  // A JSON glossary file, named without .json.
  const dir = await mkdtemp(join(tmpdir(), "yolo-glossary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const glossary = join(dir, "sf6-terms");
  await writeFile(glossary, JSON.stringify({ "ドライブラッシュ": "绿冲", "確反": "确反" }));
  const { transcriber, translator } = load({
    url: `${server.url}/`, transcribeModel: "large-v3-turbo", translateModel: "qwen3", glossary,
  }, { SUBTITLES_OPENAI_API_KEY: "key-1" });

  assert.deepEqual(await transcriber.impl.transcribe({ audio: wav, format: "wav", language: null, prompt: "スト6", signal: AbortSignal.timeout(5000) }), {
    language: "ja", segments: [{ start: 1.2, end: 2, text: " 行くぞ" }],
  });
  assert.deepEqual(server.requests[0], {
    path: "/v1/audio/transcriptions",
    authorization: "Bearer key-1",
    form: { file: `${wav.length} bytes`, model: "large-v3-turbo", response_format: "verbose_json", "timestamp_granularities[]": "segment", prompt: "スト6" },
  });

  assert.equal(translator.impl.language, "zh-Hans");
  assert.deepEqual(await translator.impl.translate({ lines: ["行くぞ", "ドライブラッシュ"], from: "ja", to: "zh-Hans", title: "スト6", previous: ["よし"], signal: AbortSignal.timeout(5000) }), [
    "[zh] 行くぞ", "[zh] ドライブラッシュ",
  ]);
  const chat = server.requests[1].json;
  assert.equal(chat.model, "qwen3");
  assert.match(chat.messages[0].content, /into Simplified Chinese/);
  // Only the glossary entries these lines use go with them.
  assert.deepEqual(JSON.parse(chat.messages[1].content), {
    title: "スト6", spoken_language: "Japanese", glossary: { "ドライブラッシュ": "绿冲" }, previous_lines: ["よし"], lines: ["行くぞ", "ドライブラッシュ"],
  });
});

test("without a translation model there is no translator, and a server's refusal says who refused and why", async (t) => {
  const server = await fakeServer(t, () => [404, { error: { message: "model 'whisper-1' not found" } }]);
  // A glossary that cannot be read is only the translator's problem.
  const { transcriber, translator } = load({ url: server.url, glossary: "/nonexistent/glossary.json" });
  assert.equal(translator, undefined);
  await assert.rejects(transcriber.impl.transcribe({ audio: wav, format: "wav", signal: AbortSignal.timeout(5000) }), {
    code: "resolve_failed", message: /^The speech server at 127\.0\.0\.1:\d+ answered 404: .*model 'whisper-1' not found/,
  });
  assert.throws(() => load({}), /needs the `url` option/);
});
