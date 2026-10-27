import { bumpTool, installTools, MANIFEST, toolStatus } from "../lib/tools.js";

// The programs tools.json pins (Agent Note 2026-10-25-pinned-node-tools).
// `npm install` runs `tools install --postinstall`, so every install,
// upgrade, and rollback links the builds its own checkout pins.

export const summary = `Install, check, or bump the programs ${MANIFEST} pins for the node (yt-dlp, Deno)`;
export const usage = "tools [install | status | bump <tool>]";
export const options = {
  postinstall: { type: "boolean" },
};

const command = "tools";
const log = (text) => process.stderr.write(`${text}\n`);

export async function run({ values, positionals, p, env = process.env }) {
  const [action = "install", name] = positionals;
  if (action === "install") {
    // CI and other installs that never run a node set YOLO_TOOLS=skip.
    if (values.postinstall && env.YOLO_TOOLS === "skip") return { command, status: "ok", summary: "Skipped the pinned tools (YOLO_TOOLS=skip)" };
    try {
      const result = await installTools({ root: p.root, env, log });
      if (result.skipped) return { command, status: "ok", summary: `Skipped the pinned tools: ${result.skipped}` };
      const steps = result.tools.map((tool) => ({ id: `tools.${tool.name}`, status: tool.downloaded ? "done" : "unchanged", message: `${tool.name} ${tool.release} at ${tool.path}` }));
      return { command, status: "ok", summary: `The pinned tools are installed in ${p.root}/.tools/bin`, steps };
    } catch (error) {
      return { command, status: "failed", summary: `The pinned tools are not installed: ${error.message}`, next: ["npm run yolo -- tools install"] };
    }
  }
  if (action === "status") {
    const tools = toolStatus({ root: p.root, env });
    if (!tools) return { command, status: "ok", summary: `${MANIFEST} has no builds for ${process.platform}-${process.arch}` };
    const checks = tools.map((tool) => ({ id: `tools.${tool.name}`, status: tool.status === "ok" ? "ok" : "fail", message: `${tool.name} ${tool.release}: ${tool.status}`, fix: "npm run yolo -- tools install" }));
    return { command, status: checks.every((check) => check.status === "ok") ? "ok" : "failed", summary: `The tools ${MANIFEST} pins`, checks };
  }
  if (action === "bump" && name) {
    try {
      const bumped = await bumpTool(name, { root: p.root });
      if (bumped.from === bumped.to) return { command, status: "ok", summary: `${name} ${bumped.to} is already the latest release` };
      return { command, status: "ok", summary: `${MANIFEST} pins ${name} ${bumped.to} (was ${bumped.from})`, next: ["npm run yolo -- tools install", "npm run check, then release it (skills: yolo-release)"] };
    } catch (error) {
      return { command, status: "failed", summary: error.message };
    }
  }
  return { command, status: "failed", summary: `Usage: npm run yolo -- ${usage}` };
}
