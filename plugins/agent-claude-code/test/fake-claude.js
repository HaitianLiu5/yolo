#!/usr/bin/env node
// A stand-in for the Claude Code CLI: it prints stream-json the way `claude -p
// --output-format stream-json --verbose` does, driven by FAKE_CLAUDE_MODE
// (play, lost-session, overloaded, fail-after-tool, no-yolo, needs-auth,
// signed-out, refresh-lock, hang), and writes its arguments, environment, and
// stdin to FAKE_CLAUDE_LOG. FAKE_CLAUDE_STATUS (in, out, broken) makes
// `claude auth status` say something other than the mode's.
import { appendFileSync } from "node:fs";

// `claude auth status --json` reads no stdin, and exits 1 when signed out.
if (process.argv[2] === "auth") {
  const status = process.env.FAKE_CLAUDE_STATUS ?? (process.env.FAKE_CLAUDE_MODE === "signed-out" ? "out" : "in");
  if (status === "broken") {
    process.stderr.write("error: unknown command 'auth'\n");
    process.exit(2);
  }
  const loggedIn = status === "in";
  process.stdout.write(`${JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" })}\n`);
  process.exit(loggedIn ? 0 : 1);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
  if (process.env.FAKE_CLAUDE_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, input, cwd: process.cwd(), env: process.env, pid: process.pid })}\n`);
  }
  const mode = process.env.FAKE_CLAUDE_MODE || "play";
  const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const session = resume || "session-1";
  if (mode === "signed-out") {
    const result = "Failed to authenticate: OAuth session expired and could not be refreshed";
    say({ type: "assistant", error: "authentication_failed", session_id: session, message: { content: [{ type: "text", text: result }] } });
    say({ type: "result", subtype: "success", is_error: true, session_id: session, result });
    process.exit(1);
  }
  if (mode === "refresh-lock") {
    say({ type: "result", subtype: "error_during_execution", is_error: true, session_id: session, result: "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again" });
    process.exit(1);
  }
  if (mode === "lost-session" && resume) {
    say({ type: "result", subtype: "error_during_execution", is_error: true, result: `No conversation found with session ID: ${resume}` });
    process.exit(1);
  }
  if (mode === "overloaded" && resume) {
    say({ type: "result", subtype: "error_during_execution", is_error: true, session_id: session, result: "Overloaded" });
    process.exit(1);
  }
  if (mode === "fail-after-tool" && resume) {
    say({ type: "system", subtype: "init", session_id: session, mcp_servers: [{ name: "yolo", status: "connected" }] });
    say({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__yolo__queue_add", input: {} }] } });
    say({ type: "result", subtype: "error_during_execution", is_error: true, session_id: session, result: "Overloaded" });
    process.exit(1);
  }
  say({ type: "system", subtype: "init", session_id: session, mcp_servers: mode === "no-yolo" ? [] : [{ name: "yolo", status: mode === "needs-auth" ? "needs-auth" : "connected" }] });
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__yolo__search", input: { query: input } }] } });
  say({ type: "user", message: { content: [{ type: "tool_result", content: "[]" }] } });
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: input } }, { type: "text", text: "Found it." }] } });
  say({ type: "result", subtype: "success", is_error: false, session_id: session, result: `Playing ${input}.` });
});
