import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeArgs, createClaudeCodeSource, readClaudeAnswer } from "../src/claude-code.js";
import { createCodexSource, ENDPOINT, parseCodexModel, responsesBody } from "../src/codex.js";
import { createCredentialFile } from "../src/credentials.js";
import { createCustomSource } from "../src/custom.js";
import { createSubscriptionsProvider } from "../src/node.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["show", "episode"],
  properties: { show: { type: "string" }, episode: { type: ["integer", "null"] } },
};
const request = (extra = {}) => ({
  purpose: "identify",
  system: "Identify it.",
  messages: [{ role: "user", content: "Nathan For You p08 S01E08" }],
  schema: SCHEMA,
  maxTokens: 400,
  signal: new AbortController().signal,
  ...extra,
});

// A JWT whose payload expires `seconds` from `now`.
const jwt = (expires) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1000) })).toString("base64url")}.s`;

function codexHome(t, { expires = Date.now() + 86_400_000, config = 'model = "gpt-test"\n\n[mcp_servers.yolo]\nmodel = "other"\n' } = {}) {
  const home = mkdtempSync(join(tmpdir(), "yolo-models-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const codex = join(home, ".codex");
  mkdirSync(codex);
  const auth = (token) => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, refresh_token: "r1", account_id: "acct" } });
  writeFileSync(join(codex, "auth.json"), auth(jwt(expires)));
  if (config) writeFileSync(join(codex, "config.toml"), config);
  return { home, codex, auth, file: join(codex, "auth.json") };
}

const completed = (text, model = "gpt-test") => [
  'event: response.created\ndata: {"type":"response.created"}\n',
  `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model, output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 133, output_tokens: 41 } } })}\n`,
].join("\n");

test("the codex source sends Codex's own token to Codex's endpoint and never writes its sign-in", async (t) => {
  const { home, file } = codexHome(t);
  const before = readFileSync(file);
  const sent = [];
  const source = createCodexSource({
    env: { HOME: home, PATH: "" },
    fetch: async (url, init) => {
      sent.push({ url, init });
      return new Response(completed('{"show":"Nathan for You","episode":8}'));
    },
  });

  assert.deepEqual(source.status(), { id: "codex", available: true });
  const answer = await source.complete(request());
  assert.deepEqual(answer, { text: '{"show":"Nathan for You","episode":8}', model: "gpt-test", source: "codex", usage: { input: 133, output: 41 } });
  assert.equal(sent[0].url, `${ENDPOINT}/responses`);
  assert.match(sent[0].init.headers.authorization, /^Bearer h\./);
  assert.equal(sent[0].init.headers["chatgpt-account-id"], "acct");
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.model, "gpt-test");
  assert.equal(body.instructions, "Identify it.");
  assert.deepEqual(body.text.format, { type: "json_schema", name: "answer", schema: SCHEMA, strict: true });
  assert.equal(body.store, false);
  assert.deepEqual(readFileSync(file), before);
});

test("an expired Codex sign-in is renewed by running Codex, at most once in ten minutes", async (t) => {
  let now = Date.now();
  const { home, file, auth } = codexHome(t, { expires: now - 1000 });
  const runs = [];
  const source = createCodexSource({
    env: { HOME: home, PATH: "" },
    options: { command: process.execPath },
    now: () => now,
    run: async (command, args) => {
      runs.push(args);
      writeFileSync(file, auth(jwt(now + 86_400_000)));
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
      return { code: 0, stdout: "", stderr: "" };
    },
    fetch: async () => new Response(completed("{}")),
  });
  await source.complete(request({ schema: undefined }));
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].slice(0, 5), ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only"]);

  // Refused again within ten minutes: the owner must sign Codex in.
  writeFileSync(file, auth(jwt(now - 1000)));
  utimesSync(file, new Date(), new Date(Date.now() + 10_000));
  now += 60_000;
  await assert.rejects(source.complete(request()), /run codex login/);
  assert.equal(runs.length, 1);
});

test("without Codex signed in with ChatGPT, the codex source is unavailable", async (t) => {
  const { home, file } = codexHome(t);
  writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: "sk-x", tokens: null }));
  const source = createCodexSource({ env: { HOME: home, PATH: "" }, fetch: async () => assert.fail("called") });
  assert.equal(source.status().available, false);
  assert.match(source.status().reason, /not signed in with ChatGPT/);
});

test("Codex's model comes from the plugin's options, else Codex's own config", () => {
  assert.equal(parseCodexModel('# comment\nmodel = "gpt-a"\n[profiles.x]\nmodel = "gpt-b"\n'), "gpt-a");
  assert.equal(parseCodexModel('[profiles.x]\nmodel = "gpt-b"\n'), null);
  // A schema with an optional property cannot be strict.
  const loose = responsesBody(request({ schema: { type: "object", properties: { a: { type: "string" } } } }), "m");
  assert.equal(loose.text.format.strict, false);
});

test("the claude-code source runs claude without tools and reads its structured answer", async () => {
  const runs = [];
  const stdout = JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: '{"show":"Nathan For You","episode":8}',
    structured_output: { show: "Nathan For You", episode: 8 },
    usage: { input_tokens: 1368, output_tokens: 271 }, modelUsage: { "claude-haiku": {} },
  });
  const source = createClaudeCodeSource({
    env: { PATH: "" },
    options: { command: process.execPath },
    run: async (command, args, options) => {
      runs.push({ command, args, options });
      return { code: 0, stdout, stderr: "" };
    },
  });
  const answer = await source.complete(request());
  assert.deepEqual(answer, { text: '{"show":"Nathan For You","episode":8}', json: { show: "Nathan For You", episode: 8 }, model: "claude-haiku", usage: { input: 1368, output: 271 }, source: "claude-code" });
  assert.deepEqual(runs[0].args, claudeArgs(request(), "haiku"));
  assert.ok(runs[0].args.includes("--strict-mcp-config"));
  assert.equal(runs[0].args[runs[0].args.indexOf("--tools") + 1], "");
  assert.equal(runs[0].options.input, "Nathan For You p08 S01E08");
});

test("a Claude Code that is not signed in makes the source unavailable for a while", async () => {
  let now = 0;
  const source = createClaudeCodeSource({
    env: { PATH: "" },
    options: { command: process.execPath },
    now: () => now,
    run: async () => ({ code: 1, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }), stderr: "" }),
  });
  await assert.rejects(source.complete(request()), /not signed in/);
  assert.equal(source.status().available, false);
  now += 11 * 60_000;
  assert.equal(source.status().available, true);
  assert.throws(() => readClaudeAnswer("nope"), /not JSON/);
});

test("the custom source speaks Chat Completions to the owner's server", async () => {
  const sent = [];
  const source = createCustomSource({
    env: { MODEL_CUSTOM_API_KEY: "k" },
    options: { url: "http://127.0.0.1:3425/v1/", model: "small" },
    fetch: async (url, init) => {
      sent.push({ url, init });
      return Response.json({ model: "small", choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 9, completion_tokens: 2 } });
    },
  });
  assert.deepEqual(await source.complete(request()), { text: "{}", model: "small", source: "custom", usage: { input: 9, output: 2 } });
  assert.equal(sent[0].url, "http://127.0.0.1:3425/v1/chat/completions");
  assert.equal(sent[0].init.headers.authorization, "Bearer k");
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.messages[0], { role: "system", content: "Identify it." });
  assert.equal(body.max_tokens, 400);
  assert.equal(createCustomSource({ options: {} }).status().available, false);
});

test("a request goes to the first available source and on to the next when it fails", async (t) => {
  const { home } = codexHome(t);
  const warned = [];
  const provider = createSubscriptionsProvider({
    env: { HOME: home, PATH: "" },
    options: { sources: ["codex", "custom", "nonsense"], custom: { url: "http://local/v1", model: "small" } },
    log: { warn: (line) => warned.push(line) },
    fetch: async (url) => (url.startsWith(ENDPOINT)
      ? new Response("gone", { status: 404 })
      : Response.json({ choices: [{ message: { content: "{}" } }] })),
  });
  assert.equal((await provider.complete(request())).source, "custom");
  assert.ok(warned.some((line) => /nonsense/.test(line)));
  assert.ok(warned.some((line) => /^codex: .*404/.test(line)));
  assert.deepEqual(provider.status().sources.map(({ id, available }) => [id, available]), [["codex", true], ["custom", true]]);

  const off = createSubscriptionsProvider({ env: { HOME: home }, options: { sources: [] } });
  assert.deepEqual(off.status(), { available: false, reason: "Every model source is turned off", sources: [] });
  await assert.rejects(off.complete(request()), (error) => error.code === "not_found");
});

test("Yolo's own sign-ins live in one private file, written under a lock", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yolo-credentials-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createCredentialFile(join(dir, "state"));
  // Two writers at once both land.
  await Promise.all([
    store.modify("openai", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 })),
    store.modify("openrouter", async () => ({ type: "api_key", key: "k" })),
  ]);
  assert.deepEqual(store.providers().sort(), ["openai", "openrouter"]);
  assert.deepEqual(await store.list(), [{ providerId: "openai", type: "oauth" }, { providerId: "openrouter", type: "api_key" }]);
  assert.equal(statSync(store.file).mode & 0o777, 0o600);
  await store.delete("openai");
  assert.deepEqual(store.providers(), ["openrouter"]);
});
