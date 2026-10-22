#!/usr/bin/env node
// A stand-in for the Codex CLI: it prints JSONL the way `codex exec --json`
// does, driven by FAKE_CODEX_MODE (play, lost-session, overloaded,
// fail-after-tool, needs-auth, hang), and writes its arguments, environment,
// and stdin to FAKE_CODEX_LOG.
import { appendFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  // `exec resume … <id> -`
  const resume = args[1] === "resume" ? args.at(-2) : null;
  if (process.env.FAKE_CODEX_LOG) {
    appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ args, input, cwd: process.cwd(), env: process.env, pid: process.pid })}\n`);
  }
  const mode = process.env.FAKE_CODEX_MODE || "play";
  const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const thread = resume || "thread-1";
  if (mode === "lost-session" && resume) {
    say({ type: "error", message: `thread/resume failed: no rollout found for thread id ${resume}` });
    process.exit(1);
  }
  say({ type: "thread.started", thread_id: thread });
  say({ type: "turn.started" });
  if (mode === "overloaded" && resume) {
    say({ type: "turn.failed", error: { message: "Overloaded" } });
    process.exit(1);
  }
  if (mode === "needs-auth") {
    say({ type: "item.completed", item: { id: "item_0", type: "error", message: "MCP client for `yolo` failed to start: The yolo MCP server is not logged in. Run `codex mcp login yolo`." } });
  }
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  // A warning Codex prints on its own, not about Yolo.
  say({ type: "item.completed", item: { id: "item_1", type: "error", message: "Skill descriptions were shortened to fit the context budget." } });
  say({ type: "item.started", item: { id: "item_2", type: "mcp_tool_call", server: "yolo", tool: "search", status: "in_progress" } });
  say({ type: "item.completed", item: { id: "item_2", type: "mcp_tool_call", server: "yolo", tool: "search", status: "completed" } });
  if (mode === "fail-after-tool" && resume) {
    say({ type: "turn.failed", error: { message: "Overloaded" } });
    process.exit(1);
  }
  say({ type: "item.completed", item: { id: "item_3", type: "web_search", query: input } });
  say({ type: "item.completed", item: { id: "item_4", type: "agent_message", text: "Found it." } });
  say({ type: "item.completed", item: { id: "item_5", type: "agent_message", text: `Playing ${input}.` } });
  say({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
});
