import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DESTRUCTIVE_TOOLS, findCommand, serverConfig } from "../src/cli.js";
import plugin, { createCodexAgent } from "../src/node.js";

const FAKE = fileURLToPath(new URL("./fake-codex.js", import.meta.url));
chmodSync(FAKE, 0o755);

// Codex's user config, as `codex mcp add yolo --url …` leaves it, beside
// the owner's other servers.
const CONFIG = `model = "gpt-5"

[mcp_servers.mail]
url = "https://mail.example/mcp"

[mcp_servers.yolo]
url = "https://yolo.example/mcp"

[mcp_servers.yolo.tools.play]
approval_mode = "approve"
`;

function setup(t, mode = "play", { config = CONFIG, ...options } = {}) {
  // The real path: macOS's temp directory is behind a link (/var is
  // /private/var), and the CLI reports the directory it really runs in.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "yolo-codex-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".codex"));
  if (config !== null) writeFileSync(join(dir, ".codex", "config.toml"), config);
  const log = join(dir, "calls.ndjson");
  const env = { PATH: process.env.PATH, HOME: dir, NODE_SECRET: "node-secret", PLEX_TOKEN: "plex", CODEX_API_KEY: "login", FAKE_CODEX_MODE: mode, FAKE_CODEX_LOG: log };
  const agent = createCodexAgent({ command: FAKE, cwd: join(dir, "work"), env, log: { warn() {} }, ...options });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { agent, calls, dir };
}

const device = { id: "dev-1", name: "Model Y" };
const resumed = ({ args }) => (args[1] === "resume" ? args.at(-2) : null);
const configValue = (args, key) => {
  const entry = args.find((arg, index) => args[index - 1] === "-c" && arg.startsWith(`${key}=`));
  return entry === undefined ? undefined : JSON.parse(entry.slice(key.length + 1));
};

test("a request runs Codex with Yolo's server alone, the request on stdin, and streams what it does", async (t) => {
  const { agent, calls, dir } = setup(t);
  const events = [];
  const answer = await agent.ask({ text: "--play 老友记", device, language: "zh-CN" }, { emit: (event) => events.push(event) });
  // The last message is the answer; each tool shows once, though Codex
  // reports it starting and completing.
  assert.deepEqual(answer, { text: "Playing --play 老友记.", session: "thread-1" });
  assert.deepEqual(events, [
    { type: "tool", name: "search" },
    { type: "tool", name: "WebSearch" },
    { type: "text", text: "Found it." },
    { type: "text", text: "Playing --play 老友记." },
  ]);
  const [call] = calls();
  assert.equal(call.input, "--play 老友记");
  assert.equal(call.cwd, join(dir, "work"));
  assert.deepEqual([call.args[0], call.args.at(-1)], ["exec", "-"]);
  // None of the owner's config, other servers, or rules; Yolo's server by
  // its url without the deleting tools; read-only, never asking, web search
  // on, and nothing that runs commands or reaches other apps.
  for (const flag of ["--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) assert.ok(call.args.includes(flag), flag);
  assert.equal(configValue(call.args, "mcp_servers.yolo.url"), "https://yolo.example/mcp");
  assert.deepEqual(configValue(call.args, "mcp_servers.yolo.disabled_tools"), DESTRUCTIVE_TOOLS);
  assert.equal(configValue(call.args, "mcp_servers.mail.url"), undefined);
  assert.equal(configValue(call.args, "sandbox_mode"), "read-only");
  assert.equal(configValue(call.args, "approval_policy"), "never");
  assert.equal(configValue(call.args, "web_search"), "live");
  assert.match(configValue(call.args, "developer_instructions"), /screen named "Model Y" \(device id dev-1\)/);
  // Several plausible matches are a question, not a guess.
  assert.match(configValue(call.args, "developer_instructions"), /When several are plausible, play nothing/);
  const disabled = call.args.filter((arg, index) => call.args[index - 1] === "--disable");
  for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "computer_use"]) assert.ok(disabled.includes(feature), feature);
  assert.ok(!call.args.some((arg) => /dangerously|full-access/.test(arg)));
  // Yolo's secrets stay with the node; Codex's own login does not.
  assert.equal(call.env.NODE_SECRET, undefined);
  assert.equal(call.env.PLEX_TOKEN, undefined);
  assert.equal(call.env.CODEX_API_KEY, "login");
});

test("a request in a conversation continues its session, and a lost one starts anew", async (t) => {
  const { agent, calls } = setup(t, "play", { now: () => 0 });
  assert.equal((await agent.ask({ text: "play friends", device, session: null })).session, "thread-1");
  await agent.ask({ text: "the next one", device, session: "thread-7" });
  assert.deepEqual(calls().map(resumed), [null, "thread-7"]);
  assert.equal(calls()[1].input, '(Asked at the screen named "Model Y", device id dev-1.)\nthe next one');
  // What plays now comes before the words, here or on another screen.
  await agent.ask({ text: "who is this", device, session: "thread-7", playing: { itemId: "library:42", title: "Friends", position: 3725.4, duration: 5400, status: "paused", device } });
  assert.equal(calls()[2].input, '(Asked at the screen named "Model Y", device id dev-1.)\n(Now paused here: "Friends" (item id library:42) at 1:02:05 of 1:30:00.)\nwho is this');

  // Without a conversation, the same screen's last session within a while.
  let clock = 0;
  const memory = setup(t, "play", { now: () => clock });
  await memory.agent.ask({ text: "one", device });
  await memory.agent.ask({ text: "two", device });
  clock += 11 * 60_000;
  await memory.agent.ask({ text: "three", device });
  assert.deepEqual(memory.calls().map(resumed), [null, "thread-1", null]);

  const lost = setup(t, "lost-session", { now: () => 0 });
  assert.equal((await lost.agent.ask({ text: "two", device, session: "gone" })).session, "thread-1");
  assert.deepEqual(lost.calls().map(resumed), ["gone", null]);

  // Any other failure, or one after a tool ran, is not asked again.
  const overloaded = setup(t, "overloaded", { now: () => 0 });
  await assert.rejects(overloaded.agent.ask({ text: "two", device, session: "t-9" }), /Codex failed: Overloaded/);
  assert.equal(overloaded.calls().length, 1);
  const acted = setup(t, "fail-after-tool", { now: () => 0 });
  await assert.rejects(acted.agent.ask({ text: "queue two", device, session: "t-9" }), /Overloaded/);
  assert.equal(acted.calls().length, 1);
});

test("Codex without Yolo's MCP server, or not logged in to it, says how to connect it", async (t) => {
  for (const config of [null, "[mcp_servers.mail]\nurl = \"https://mail.example/mcp\"\n", "[mcp_servers.yolo]\nurl = \"https://yolo.example/mcp\"\nenabled = false\n"]) {
    const { agent, calls } = setup(t, "play", { config });
    assert.equal(agent.health().available, false);
    assert.match(agent.health().reason, /yolo-connect-agent/);
    await assert.rejects(agent.ask({ text: "play", device }), (error) => error.code === "resolve_failed");
    assert.deepEqual(calls(), []);
  }
  const { agent } = setup(t, "needs-auth");
  await assert.rejects(agent.ask({ text: "play", device }), (error) => error.code === "resolve_failed" && /codex mcp login yolo/.test(error.message));
});

test("a cancelled or overlong request stops Codex", async (t) => {
  const { agent } = setup(t, "hang");
  const controller = new AbortController();
  const asking = agent.ask({ text: "play", device }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("changed my mind")), 200);
  await assert.rejects(asking, /changed my mind/);
  const slow = setup(t, "hang", { timeoutSeconds: 0.3 });
  await assert.rejects(slow.agent.ask({ text: "play", device }), /did not finish within/);
});

test("the plugin registers one agent with its options, and finds Codex's config", (t) => {
  const { dir } = setup(t);
  const registered = [];
  plugin({ options: { command: FAKE }, env: { HOME: dir }, cacheDir: null, log: console, registerAgent: (id, impl) => registered.push({ id, impl }) });
  assert.deepEqual(registered.map(({ id, impl }) => [id, impl.title, impl.health()]), [["codex", "Codex", { available: true }]]);
  assert.deepEqual(createCodexAgent({ command: "/nowhere/codex" }).health(), { available: false, reason: "Codex (/nowhere/codex) is not installed on the media node's machine" });

  // CODEX_HOME moves the config; a quoted table name is the same server.
  writeFileSync(join(dir, "config.toml"), "[mcp_servers.\"yolo\"]\nurl = 'https://home.example/mcp' # Yolo\n");
  assert.deepEqual(serverConfig("yolo", { env: { CODEX_HOME: dir } }), { url: "https://home.example/mcp", enabled: true });
  assert.equal(serverConfig("yo lo", { env: { CODEX_HOME: dir } }), null);

  const exists = (paths) => (path) => paths.includes(path);
  assert.equal(findCommand("codex", { env: { PATH: "/a:/b" }, home: "/h", isExecutable: exists(["/b/codex"]) }), "/b/codex");
  assert.equal(findCommand("codex", { env: { PATH: "/a" }, home: "/h", isExecutable: exists(["/opt/homebrew/bin/codex"]) }), "/opt/homebrew/bin/codex");
});
