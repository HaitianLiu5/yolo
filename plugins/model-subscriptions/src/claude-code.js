import { tmpdir } from "node:os";
import { YoloError } from "@useyolo/plugin-api";
import { childEnv, findCommand, runCommand } from "./command.js";

// The `claude-code` source (Agent Note 2026-10-25-models-for-plugins): the
// claude command Ask already runs, driven for one answer with no tools, no
// MCP servers, no session, and Yolo's own system prompt. It does not read
// Claude Code's credential: Claude Code itself answers, under its own terms,
// wherever it can read its sign-in.

const DEFAULT_MODEL = "haiku";
const DEFAULT_SYSTEM = "Answer the request.";
// After Claude Code says it is not signed in, the source is unavailable for
// this long, so the plugins take their path without a model.
const SIGNED_OUT_MS = 10 * 60_000;

/** The arguments of one `claude -p` run. */
export function claudeArgs(request, model) {
  return [
    "-p",
    "--model", model,
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format", "json",
    "--system-prompt", request.system || DEFAULT_SYSTEM,
    ...(request.schema ? ["--json-schema", JSON.stringify(request.schema)] : []),
  ];
}

// The conversation as one prompt on stdin: the message itself, or each turn
// under its speaker.
export function claudePrompt(messages) {
  if (messages.length === 1) return messages[0].content;
  return messages.map(({ role, content }) => `${role === "user" ? "User" : "Assistant"}: ${content}`).join("\n\n");
}

/** `claude -p --output-format json`'s answer: { text, json?, model, usage }. */
export function readClaudeAnswer(stdout) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new YoloError("resolve_failed", "Claude Code's answer is not JSON");
  }
  const text = typeof result.result === "string" ? result.result : "";
  if (result.is_error || result.subtype !== "success") {
    throw new YoloError("resolve_failed", `Claude Code: ${text || result.subtype || "the request failed"}`);
  }
  const usage = result.usage ?? {};
  const input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
    .reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
  return {
    text,
    ...(result.structured_output !== undefined && result.structured_output !== null ? { json: result.structured_output } : {}),
    model: Object.keys(result.modelUsage ?? {})[0] ?? null,
    usage: { input: input || null, output: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null },
  };
}

const notSignedIn = (text) => /not logged in|please run \/login|invalid api key|oauth token has expired/i.test(text);

export function createClaudeCodeSource({ env = process.env, options = {}, run = runCommand, now = Date.now } = {}) {
  let signedOutAt = null;
  const command = () => findCommand(options.command ?? env.CLAUDE_CODE_COMMAND ?? "claude", { env });

  return {
    id: "claude-code",

    status() {
      if (!command()) return { id: "claude-code", available: false, reason: "The claude command is not on this machine" };
      if (signedOutAt !== null && now() - signedOutAt < SIGNED_OUT_MS) {
        return { id: "claude-code", available: false, reason: "Claude Code is not signed in for the media node: run claude and /login" };
      }
      return { id: "claude-code", available: true };
    },

    async models() {
      return [...new Set([options.models?.default ?? DEFAULT_MODEL, "haiku", "sonnet", "opus"])].map((id) => ({ id, name: id, source: "claude-code" }));
    },

    async complete(request) {
      const binary = command();
      if (!binary) throw new YoloError("not_found", "The claude command is not on this machine");
      const model = options.models?.[request.purpose] ?? options.models?.default ?? DEFAULT_MODEL;
      const { code, stdout, stderr } = await run(binary, claudeArgs(request, model), {
        input: claudePrompt(request.messages),
        env: childEnv(env),
        cwd: tmpdir(),
        signal: request.signal,
      });
      if (notSignedIn(stdout) || notSignedIn(stderr)) {
        signedOutAt = now();
        throw new YoloError("resolve_failed", "Claude Code is not signed in for the media node: run claude and /login");
      }
      if (code !== 0 && !stdout.trim()) {
        throw new YoloError("resolve_failed", `Claude Code exited with ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""}`);
      }
      signedOutAt = null;
      return { ...readClaudeAnswer(stdout), source: "claude-code" };
    },
  };
}
