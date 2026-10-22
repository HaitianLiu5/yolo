import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

// How the plugin runs the owner's Codex CLI: what it passes, what the child
// process inherits, and how its JSONL events become Yolo's agent events
// (Agent Note 2026-10-18-agent-from-the-screen). Pure functions, so tests
// need no CLI.

// Yolo's tools that delete things: a screen in a moving car is not where the
// owner removes devices or clears a queue, so the agent never gets them.
export const DESTRUCTIVE_TOOLS = Object.freeze(["remove_device", "queue_remove", "queue_clear", "playlist_delete"]);
// Codex features that run commands, edit files, drive a browser or the
// computer, or reach the owner's other apps and plugins. Without them the
// agent has Yolo's tools and web search, and nothing else.
export const DISABLED_FEATURES = Object.freeze([
  "shell_tool", "unified_exec", "code_mode_host", "apps", "plugins", "browser_use", "computer_use",
  "in_app_browser", "image_generation", "memories", "multi_agent", "goals", "tool_suggest",
]);

// Where installers put the CLI, for a service whose PATH is not the login
// shell's (launchd and systemd units read no profile).
export function candidateCommands(home = homedir()) {
  return [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(home, ".local/bin/codex"),
    join(home, ".npm-global/bin/codex"),
  ];
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The command to run: an absolute path as given, else the first match on
// PATH, else a usual install location; null when there is none.
export function findCommand(command = "codex", { env = process.env, home = homedir(), isExecutable = executable } = {}) {
  if (isAbsolute(command)) return isExecutable(command) ? command : null;
  for (const dir of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    const path = join(dir, command);
    if (isExecutable(path)) return path;
  }
  if (command !== "codex") return null;
  return candidateCommands(home).find(isExecutable) ?? null;
}

// The child's environment: the node's, without Yolo's secrets and other
// credentials from its .env. Codex signs in with its own login under
// CODEX_HOME; an explicit CODEX_API_KEY is that login, so it stays.
const SECRET_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|CREDENTIAL|COOKIE/i;
const KEPT = new Set(["CODEX_API_KEY"]);

export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && (KEPT.has(key) || !SECRET_NAME.test(key))));
}

export function systemPrompt({ server, device, language }) {
  const where = device
    ? `They are at the screen named "${device.name}" (device id ${device.id}). Play there unless they name another screen.`
    : "Play on the active screen unless they name another one.";
  return [
    "You are the assistant inside Yolo, the owner's private media service. The owner asked you from one of their Yolo screens, which may be a car's touchscreen while someone drives.",
    `Act, don't chat: use the ${server} MCP tools to find what they want and play it, queue it, or control playback. Search the library first; for a video on the web, use web search to find its page, then play that URL.`,
    where,
    "Each request may begin with a line in parentheses saying what plays now, where in it, and on which screen. When they say this, here, or now, they mean that item and that moment; read it with the tools (get_transcript around the position, get_frame) instead of asking what it is.",
    "Play when they named one thing or one match clearly fits. When several are plausible, play nothing: name up to three of them in your reply and ask which one; their next request answers you.",
    `When you are done, reply with one short sentence saying what you did or asking which one, in the language they used${language ? ` (their screen is set to ${language})` : ""}. No Markdown, no lists, no links.`,
  ].join("\n");
}

// 75 → "1:15", 3725 → "1:02:05".
const clock = (seconds) => {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return `${hours ? `${hours}:${pad(minutes)}` : minutes}:${pad(whole % 60)}`;
};

// What the CLI reads on stdin: the request, after a line for what plays now
// and, in a resumed session, the screen it was asked at. A resumed session
// keeps the instructions it began with, and a conversation can move from
// a phone to the car.
export function requestInput(request, { resumed = false } = {}) {
  const lines = [];
  if (resumed && request.device) lines.push(`(Asked at the screen named "${request.device.name}", device id ${request.device.id}.)`);
  const playing = request.playing;
  if (playing) {
    const where = playing.device
      ? playing.device.id === request.device?.id ? "here" : `on the screen named "${playing.device.name}"`
      : "";
    const at = playing.duration ? `${clock(playing.position)} of ${clock(playing.duration)}` : clock(playing.position);
    const title = playing.title ? `"${playing.title}" ` : "";
    lines.push(`(Now ${playing.status || "playing"}${where ? ` ${where}` : ""}: ${title}(item id ${playing.itemId}) at ${at}.)`);
  }
  return [...lines, request.text].join("\n");
}

// A server name Codex can take in a dotted config path.
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// One TOML string value: a basic "…" string with its escapes, or a literal
// '…' one.
function tomlString(raw) {
  const value = raw.trim();
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end > 0 ? value.slice(1, end) : null;
  }
  if (!value.startsWith('"')) return null;
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

// The owner's own entry for Yolo's MCP server in Codex's user config
// ($CODEX_HOME/config.toml, ~/.codex by default), as `codex mcp add yolo
// --url …` writes it: { url, enabled }, or null. The agent runs with this
// server alone, and the same name and url find the OAuth token `codex mcp
// login` keeps for it.
export function serverConfig(server, { env = process.env } = {}) {
  if (!SERVER_NAME.test(server)) return null;
  let text;
  try {
    text = readFileSync(join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "config.toml"), "utf8");
  } catch {
    return null;
  }
  const headers = new Set([`[mcp_servers.${server}]`, `[mcp_servers."${server}"]`]);
  let inside = false;
  let entry = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inside = headers.has(trimmed.replace(/\s+/g, ""));
      if (inside) entry ??= { url: null, enabled: true };
      continue;
    }
    if (!inside) continue;
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!pair) continue;
    if (pair[1] === "url") entry.url = tomlString(pair[2]);
    if (pair[1] === "enabled") entry.enabled = !/^false\b/.test(pair[2].trim());
  }
  return entry?.url ? entry : null;
}

// The CLI's arguments. The request itself goes in on stdin (`-`), so nothing
// a person says is read as a flag. The owner's config is not loaded: Yolo's
// server comes in by `-c`, and Codex still signs in from CODEX_HOME.
export function cliArgs({ server = "yolo", mcp, device = null, language = null, model = null, resume = null }) {
  const config = (key, value) => ["-c", `${key}=${JSON.stringify(value)}`];
  return [
    "exec",
    ...(resume ? ["resume"] : []),
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    ...config("sandbox_mode", "read-only"),
    // Nothing is ever asked: no one answers a prompt here.
    ...config("approval_policy", "never"),
    ...config("web_search", "live"),
    ...config("developer_instructions", systemPrompt({ server, device, language })),
    ...config(`mcp_servers.${server}.url`, mcp.url),
    ...config(`mcp_servers.${server}.disabled_tools`, DESTRUCTIVE_TOOLS),
    ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    ...(model ? ["-m", model] : []),
    ...(resume ? [resume] : []),
    "-",
  ];
}

// A tool's name as a screen shows it: Yolo's own as they are, web search as
// the other agents name it.
export function toolName(item, server) {
  if (item.type === "web_search") return "WebSearch";
  return item.server === server ? String(item.tool) : `${item.server}.${item.tool}`;
}

// What a Codex error says about Yolo's MCP server, or null: it did not start,
// or it needs `codex mcp login`.
function serverProblem(message, server) {
  const text = String(message);
  if (!new RegExp(`\\b${server}\\b`).test(text) || !/mcp/i.test(text)) return null;
  return /login|auth|401|unauthori[sz]ed/i.test(text) ? "needs-auth" : "failed";
}

// Reads one JSONL event into what it means for the request:
// { session?, mcp?, events: [], message?, result? }. `seen` holds the ids of
// tool calls already shown, since Codex reports a call as it starts and
// again when it completes.
export function readLine(line, { server, seen = new Set() }) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  if (!event || typeof event !== "object") return { events: [] };
  if (event.type === "thread.started") return { session: event.thread_id ?? null, events: [] };
  if (event.type === "item.started" || event.type === "item.completed") {
    const item = event.item ?? {};
    if (item.type === "mcp_tool_call" || item.type === "web_search") {
      if (item.id && seen.has(item.id)) return { events: [] };
      if (item.id) seen.add(item.id);
      return { events: [{ type: "tool", name: toolName(item, server) }] };
    }
    if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      return { events: [{ type: "text", text: item.text.trim() }], message: item.text.trim() };
    }
    if (event.type === "item.completed" && item.type === "error") {
      const problem = serverProblem(item.message, server);
      return problem ? { mcp: problem, events: [], error: String(item.message) } : { events: [] };
    }
    return { events: [] };
  }
  if (event.type === "turn.completed") return { events: [], result: { ok: true } };
  if (event.type === "turn.failed") return { events: [], result: { ok: false, text: String(event.error?.message ?? "") } };
  if (event.type === "error") {
    const problem = serverProblem(event.message, server);
    return { events: [], error: String(event.message ?? ""), ...(problem ? { mcp: problem } : {}) };
  }
  return { events: [] };
}
