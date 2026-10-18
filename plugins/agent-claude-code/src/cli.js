import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

// How the plugin runs the owner's Claude Code CLI: what it passes, what the
// child process inherits, and how its stream-json output becomes Yolo's agent
// events (Agent Note 2026-10-18-agent-from-the-screen). Pure functions, so
// tests need no CLI.

// Yolo's tools that delete things: a screen in a moving car is not where the
// owner removes devices or clears a queue, so the agent never gets them.
export const DESTRUCTIVE_TOOLS = Object.freeze(["remove_device", "queue_remove", "queue_clear", "playlist_delete"]);
// Built-in tools: finding a web video needs search and a page read; nothing
// that runs commands or edits files.
export const BUILT_IN_TOOLS = Object.freeze(["WebSearch", "WebFetch"]);

// Where installers put the CLI, for a service whose PATH is not the login
// shell's (launchd and systemd units read no profile).
export function candidateCommands(home = homedir()) {
  return [
    join(home, ".local/bin/claude"),
    join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".npm-global/bin/claude"),
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
export function findCommand(command = "claude", { env = process.env, home = homedir(), isExecutable = executable } = {}) {
  if (isAbsolute(command)) return isExecutable(command) ? command : null;
  for (const dir of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    const path = join(dir, command);
    if (isExecutable(path)) return path;
  }
  if (command !== "claude") return null;
  return candidateCommands(home).find(isExecutable) ?? null;
}

// The child's environment: the node's, without Yolo's secrets and other
// credentials from its .env. Claude Code signs in with its own login; an
// explicit CLAUDE_CODE_OAUTH_TOKEN is that login, so it stays.
const SECRET_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|CREDENTIAL|COOKIE/i;
const KEPT = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && (KEPT.has(key) || !SECRET_NAME.test(key))));
}

export function systemPrompt({ server, device, language }) {
  const where = device
    ? `They are at the screen named "${device.name}" (device id ${device.id}). Play there unless they name another screen.`
    : "Play on the active screen unless they name another one.";
  return [
    "You are the assistant inside Yolo, the owner's private media service. The owner asked you from one of their Yolo screens, which may be a car's touchscreen while someone drives.",
    `Act, don't chat: use the ${server} MCP tools to find what they want and play it, queue it, or control playback. Search the library first; for a video on the web, use WebSearch to find its page, then play that URL.`,
    where,
    "Choose the best match yourself; ask a question only when nothing reasonable fits.",
    `When you are done, reply with one short sentence saying what you did, in the language they used${language ? ` (their screen is set to ${language})` : ""}. No Markdown, no lists, no links.`,
  ].join("\n");
}

// The owner's own entry for Yolo's MCP server in Claude Code's user config
// (~/.claude.json, or under CLAUDE_CONFIG_DIR), or null. The agent runs with
// this server alone, and the same name, type, url, and headers find the OAuth
// token Claude Code already keeps for it.
export function serverConfig(server, { env = process.env, home = env.HOME || homedir(), read = (path) => readFileSync(path, "utf8") } = {}) {
  try {
    const entry = JSON.parse(read(join(env.CLAUDE_CONFIG_DIR || home, ".claude.json")))?.mcpServers?.[server];
    return entry && typeof entry === "object" ? entry : null;
  } catch {
    return null;
  }
}

// The CLI's arguments. The request itself goes in on stdin, so nothing a
// person says is read as a flag.
export function cliArgs({ server = "yolo", mcp, device = null, language = null, model = null, resume = null }) {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--append-system-prompt", systemPrompt({ server, device, language }),
    // Only Yolo's server, none of the owner's other MCP servers or plugins,
    // and none of their settings files, whose allow rules would otherwise add
    // to the ones below.
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: { [server]: mcp } }),
    "--setting-sources", "",
    "--tools", BUILT_IN_TOOLS.join(","),
    "--allowedTools", [`mcp__${server}`, ...BUILT_IN_TOOLS].join(","),
    "--disallowedTools", DESTRUCTIVE_TOOLS.map((name) => `mcp__${server}__${name}`).join(","),
    // Whatever is not allowed above is refused, never asked: no one answers
    // a permission prompt here.
    "--permission-mode", "dontAsk",
    ...(model ? ["--model", model] : []),
    ...(resume ? ["--resume", resume] : []),
  ];
}

// A tool's name as a screen shows it: Yolo's own without the server prefix.
export function toolName(name, server) {
  const prefix = `mcp__${server}__`;
  return String(name).startsWith(prefix) ? String(name).slice(prefix.length) : String(name);
}

// Reads one stream-json line into what it means for the request:
// { session?, mcp?, events: [], result? }.
export function readLine(line, { server }) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  if (!message || typeof message !== "object") return { events: [] };
  if (message.type === "system" && message.subtype === "init") {
    const servers = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
    const found = servers.find((entry) => entry?.name === server);
    return { session: message.session_id ?? null, mcp: found ? String(found.status ?? "unknown") : "missing", events: [] };
  }
  if (message.type === "assistant") {
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    const events = [];
    for (const block of content) {
      if (block?.type === "tool_use") events.push({ type: "tool", name: toolName(block.name, server) });
      else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) events.push({ type: "text", text: block.text.trim() });
    }
    return { events };
  }
  if (message.type === "result") {
    return {
      session: message.session_id ?? null,
      events: [],
      result: { ok: !message.is_error && message.subtype === "success", text: typeof message.result === "string" ? message.result.trim() : "", subtype: message.subtype ?? null },
    };
  }
  return { events: [] };
}
