#!/usr/bin/env node
// The operator's command line: `npm run yolo -- <command> [--json]`.
// It sets up, checks, deploys, and upgrades one Yolo instance from this
// checkout; agents drive it through skills/yolo-deploy and skills/yolo-upgrade
// (Agent Note 2026-10-11-distribution-to-other-owners). Agents control
// playback through MCP, not through this command.
//
// Every command prints one result (see lib/output.js); --json prints it as
// JSON. Exit codes: 0 ok, 1 failed, 2 stopped for the owner's approval,
// 3 stopped for a step only a human can do.
import { parseArgs } from "node:util";
import { finish } from "./lib/output.js";
import { paths } from "./lib/paths.js";

const COMMANDS = {
  init: () => import("./commands/init.js"),
  config: () => import("./commands/config.js"),
};

async function help() {
  const lines = ["Usage: npm run yolo -- <command> [options] [--json]", ""];
  for (const [name, load] of Object.entries(COMMANDS)) {
    const module = await load();
    lines.push(`  ${module.usage ?? name}`, `      ${module.summary}`);
  }
  lines.push("", "Exit codes: 0 ok, 1 failed, 2 needs the owner's approval, 3 needs a human step.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

const [name, ...rest] = process.argv.slice(2);
if (!name || name === "help" || name === "--help" || name === "-h") {
  await help();
} else if (!COMMANDS[name]) {
  finish({ command: name, status: "failed", summary: `Unknown command "${name}". Run \`npm run yolo -- help\`.` });
} else {
  const module = await COMMANDS[name]();
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...module.options, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    finish({ command: name, status: "failed", summary: `${error.message}\nUsage: npm run yolo -- ${module.usage ?? name}` });
    process.exit();
  }
  const json = Boolean(parsed.values.json);
  if (parsed.values.help) {
    process.stdout.write(`Usage: npm run yolo -- ${module.usage ?? name}\n${module.summary}\n`);
  } else {
    let result;
    try {
      result = await module.run({ values: parsed.values, positionals: parsed.positionals, p: paths(), json });
    } catch (error) {
      result = { command: name, status: "failed", summary: `Unexpected error: ${error.stack || error.message}` };
    }
    finish(result, { json });
  }
}
