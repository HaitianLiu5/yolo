#!/usr/bin/env node
// A stand-in for the Claude Code CLI: it prints stream-json the way `claude -p
// --output-format stream-json --verbose` does, driven by FAKE_CLAUDE_MODE
// (play, lost-session, overloaded, fail-after-tool, no-yolo, needs-auth,
// hang), and writes its arguments, environment, and stdin to FAKE_CLAUDE_LOG.
import { appendFileSync } from "node:fs";

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
