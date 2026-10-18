import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findCommand } from "../src/cli.js";
import plugin, { createClaudeCodeAgent } from "../src/node.js";

const FAKE = fileURLToPath(new URL("./fake-claude.js", import.meta.url));
chmodSync(FAKE, 0o755);

const YOLO_SERVER = { type: "http", url: "https://yolo.example/mcp" };

function setup(t, mode = "play", { connected = true, ...options } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "yolo-agent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Claude Code's user config, as `claude mcp add --scope user yolo` leaves it.
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: connected ? { yolo: YOLO_SERVER, mail: { type: "http", url: "https://mail.example/mcp" } } : {} }));
  const log = join(dir, "calls.ndjson");
  const env = { PATH: process.env.PATH, HOME: dir, NODE_SECRET: "node-secret", PLEX_TOKEN: "plex", CLAUDE_CODE_OAUTH_TOKEN: "login", FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log };
  const agent = createClaudeCodeAgent({ command: FAKE, cwd: join(dir, "work"), env, log: { warn() {} }, ...options });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { agent, calls, dir };
}

const device = { id: "dev-1", name: "Model Y" };

test("a request runs the CLI with the request on stdin and streams what it does", async (t) => {
  const { agent, calls, dir } = setup(t);
  const events = [];
  const answer = await agent.ask({ text: "--play 老友记", device, language: "zh-CN" }, { emit: (event) => events.push(event) });
  assert.deepEqual(answer, { text: "Playing --play 老友记." });
  assert.deepEqual(events, [{ type: "tool", name: "search" }, { type: "tool", name: "WebSearch" }, { type: "text", text: "Found it." }]);
  const [call] = calls();
  assert.equal(call.input, "--play 老友记");
  assert.equal(call.cwd, join(dir, "work"));
  // Web search and page reads of the built-in tools, Yolo's tools without
  // the deleting ones, and a refusal for anything else, never a prompt.
  const flag = (name) => call.args[call.args.indexOf(name) + 1];
  assert.equal(flag("--tools"), "WebSearch,WebFetch");
  assert.equal(flag("--allowedTools"), "mcp__yolo,WebSearch,WebFetch");
  assert.equal(flag("--disallowedTools"), "mcp__yolo__remove_device,mcp__yolo__queue_remove,mcp__yolo__queue_clear,mcp__yolo__playlist_delete");
  assert.equal(flag("--permission-mode"), "dontAsk");
  assert.ok(!call.args.some((arg) => /skip-permissions|bypassPermissions/.test(arg)));
  assert.match(call.args[call.args.indexOf("--append-system-prompt") + 1], /screen named "Model Y" \(device id dev-1\)/);
  // Yolo's server alone, as the owner configured it, and none of their
  // other servers or settings files.
  assert.ok(call.args.includes("--strict-mcp-config"));
  assert.deepEqual(JSON.parse(flag("--mcp-config")), { mcpServers: { yolo: YOLO_SERVER } });
  assert.equal(flag("--setting-sources"), "");
  // Yolo's secrets stay with the node; Claude Code's own login does not.
  assert.equal(call.env.NODE_SECRET, undefined);
  assert.equal(call.env.PLEX_TOKEN, undefined);
  assert.equal(call.env.CLAUDE_CODE_OAUTH_TOKEN, "login");
});

test("a request soon after continues the conversation, a later one starts anew", async (t) => {
  let clock = 0;
  const { agent, calls } = setup(t, "play", { now: () => clock });
  await agent.ask({ text: "play friends", device });
  clock += 60_000;
  await agent.ask({ text: "the next one", device });
  clock += 11 * 60_000;
  await agent.ask({ text: "something else", device });
  const resumes = calls().map(({ args }) => (args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null));
  assert.deepEqual(resumes, [null, "session-1", null]);
});

test("another screen's request starts its own conversation", async (t) => {
  const { agent, calls } = setup(t, "play", { now: () => 0 });
  await agent.ask({ text: "play friends", device });
  await agent.ask({ text: "play news", device: { id: "dev-2", name: "Living room" } });
  await agent.ask({ text: "the next one", device });
  const resumes = calls().map(({ args }) => (args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null));
  assert.deepEqual(resumes, [null, null, "session-1"]);
});

test("a conversation the CLI lost is started again", async (t) => {
  const { agent, calls } = setup(t, "lost-session", { now: () => 0 });
  await agent.ask({ text: "one", device });
  const answer = await agent.ask({ text: "two", device });
  assert.equal(answer.text, "Playing two.");
  assert.equal(calls().length, 3);
});

test("Claude Code without Yolo's MCP server says how to connect it", async (t) => {
  const unconfigured = setup(t, "play", { connected: false });
  await assert.rejects(unconfigured.agent.ask({ text: "play", device }), (error) => error.code === "resolve_failed" && /yolo-connect-agent/.test(error.message));
  assert.deepEqual(unconfigured.calls(), []);
  for (const mode of ["no-yolo", "needs-auth"]) {
    const { agent } = setup(t, mode);
    await assert.rejects(agent.ask({ text: "play", device }), (error) => error.code === "resolve_failed" && /yolo-connect-agent/.test(error.message));
  }
});

test("a cancelled request stops the CLI", async (t) => {
  const { agent } = setup(t, "hang");
  const controller = new AbortController();
  const asking = agent.ask({ text: "play", device }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("changed my mind")), 200);
  await assert.rejects(asking, /changed my mind/);
});

test("a request that runs too long fails", async (t) => {
  const { agent } = setup(t, "hang", { timeoutSeconds: 0.3 });
  await assert.rejects(agent.ask({ text: "play", device }), /did not finish within/);
});

test("the plugin registers one agent with its options", () => {
  const registered = [];
  plugin({ options: { command: FAKE }, env: {}, cacheDir: null, log: console, registerAgent: (id, impl) => registered.push({ id, impl }) });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, "claude-code");
  assert.deepEqual(registered[0].impl.health(), { available: true });
  // Without the CLI it loads all the same, and says it cannot answer.
  const missing = createClaudeCodeAgent({ command: "/nowhere/claude" });
  assert.deepEqual(missing.health(), { available: false, reason: "Claude Code (/nowhere/claude) is not installed on the media node's machine" });
});

test("the command is found on PATH or where installers put it", () => {
  const exists = (paths) => (path) => paths.includes(path);
  assert.equal(findCommand("claude", { env: { PATH: "/a:/b" }, home: "/h", isExecutable: exists(["/b/claude"]) }), "/b/claude");
  assert.equal(findCommand("claude", { env: { PATH: "/a" }, home: "/h", isExecutable: exists(["/h/.local/bin/claude"]) }), "/h/.local/bin/claude");
  assert.equal(findCommand("/opt/claude", { env: {}, isExecutable: exists([]) }), null);
});
