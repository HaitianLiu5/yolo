import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pluginDirectory, runtimeDirectory } from "@useyolo/plugin-api/host";
import { readEnvFile } from "../lib/env-file.js";
import { nodeHealth } from "../lib/node-health.js";
import { overall } from "../lib/output.js";
import { readSecret } from "../lib/secret-input.js";
import { findSetupPlugin } from "../lib/setup-entry.js";

// The model the node's plugins call (Agent Note 2026-10-25-models-for-plugins):
// which source answers, and Yolo's own sign-in for a node with no signed-in
// agent. Runs on the node's machine, where the credential is kept.

export const summary = "Show the model other plugins use, or sign Yolo in to a subscription of its own";
export const usage = "models status|login|logout [subscription]";
export const options = {};

const NO_PROVIDER = "No model provider plugin is loaded: add ./plugins/model-subscriptions to yolo.config.json, or remove yolo.config.json to load the official plugins";

// The provider plugin, its state directory, and the environment it sees.
async function provider(p) {
  const envValues = readEnvFile(p.envFile) ?? {};
  const env = { ...envValues, ...process.env };
  const found = await findSetupPlugin({ root: p.root, env, provider: "models" });
  if (!found.plugin) return { found, env };
  const stateDir = pluginDirectory(join(runtimeDirectory({ root: p.root, env }), ".yolo", "plugins"), found.plugin.name);
  return { found, env, envValues, stateDir };
}

async function status({ p, command }) {
  const { found, env, envValues, stateDir } = await provider(p);
  if (!found.plugin) return { command, status: "failed", summary: found.error ?? NO_PROVIDER, steps: found.skipped.map((message, index) => ({ id: `skipped.${index}`, status: "warn", message })) };
  const steps = [];
  const local = await found.setup.status({ stateDir, env, options: found.plugin.options });
  for (const source of local.sources ?? []) {
    steps.push({
      id: `source.${source.id}`,
      status: source.available ? "ok" : "info",
      message: `${source.id}: ${source.available ? "answers" : source.reason ?? "unavailable"}`,
    });
  }
  // What the running node says: the provider it uses and today's calls.
  if (envValues?.NODE_SECRET) {
    try {
      const { json } = await nodeHealth({ secret: envValues.NODE_SECRET, host: envValues.NODE_HOST || "127.0.0.1", port: Number(envValues.NODE_PORT || 9191) });
      if (json?.models) {
        const calls = Object.entries(json.models.calls ?? {}).map(([plugin, count]) => `${plugin} ${count}`).join(", ") || "none";
        steps.push({ id: "node", status: "info", message: `The node uses ${json.models.provider ?? "no provider"}; calls today: ${calls} (at most ${json.models.callsPerDay} per plugin)` });
      }
    } catch {
      steps.push({ id: "node", status: "info", message: "The node is not running on this machine" });
    }
  }
  const answers = local.available;
  return {
    command,
    status: overall(steps),
    summary: answers
      ? `Plugins have a model through ${found.plugin.name}`
      : "No model: plugins take their path without AI",
    steps,
    ...(answers ? {} : { next: ["Sign Codex (codex login) or Claude Code (claude, then /login) in on this machine, or sign Yolo in: npm run yolo -- models login"] }),
  };
}

// pi-ai's sign-in interaction on this terminal: prompts on stderr, so --json
// output on stdout stays clean.
function terminalInteraction() {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  const say = (text) => process.stderr.write(`${text}\n`);
  return {
    close: () => lines.close(),
    interaction: {
      async prompt(prompt) {
        if (prompt.type === "secret") {
          lines.pause();
          try {
            return await readSecret({ prompt: `${prompt.message} ` });
          } finally {
            lines.resume();
          }
        }
        if (prompt.type === "select") {
          prompt.options.forEach((option, index) => say(`  ${index + 1}. ${option.label}${option.description ? ` (${option.description})` : ""}`));
          const answer = (await lines.question(`${prompt.message} `, { signal: prompt.signal })).trim();
          return prompt.options[Number(answer) - 1]?.id ?? answer;
        }
        // manual_code: the redirected address pasted back, racing the local
        // callback server, which aborts the question when it wins.
        try {
          return (await lines.question(`${prompt.message} `, { signal: prompt.signal })).trim();
        } catch (error) {
          if (prompt.signal?.aborted) return "";
          throw error;
        }
      },
      notify(event) {
        if (event.type === "auth_url") say(`\nOpen this address on any device and sign in:\n  ${event.url}${event.instructions ? `\n${event.instructions}` : ""}\nIf the browser then fails to open a 127.0.0.1 address, copy that address and paste it here.\n`);
        else if (event.type === "device_code") say(`\nOpen ${event.verificationUri} and enter the code ${event.userCode}\n`);
        else if (event.message) say(event.message);
        for (const link of event.links ?? []) say(`  ${link.label ?? "More"}: ${link.url}`);
      },
    },
  };
}

async function login({ p, command, subscription }) {
  const { found, stateDir } = await provider(p);
  if (!found.plugin) return { command, status: "failed", summary: found.error ?? NO_PROVIDER };
  if (!process.stdin.isTTY) {
    return { command, status: "needs_human", summary: "Signing in needs the owner at a terminal on the node's machine (an SSH session works)", next: ["The owner, in their own terminal: npm run yolo -- models login"] };
  }
  const offered = await found.setup.offered();
  const { interaction, close } = terminalInteraction();
  try {
    let chosen = subscription;
    if (!chosen) {
      chosen = await interaction.prompt({ type: "select", message: "Sign Yolo in to which subscription?", options: offered.map(({ id, label }) => ({ id, label })) });
    }
    if (!offered.some(({ id }) => id === chosen)) return { command, status: "failed", summary: `Yolo signs in to ${offered.map(({ id }) => id).join(", ")}, not ${chosen}` };
    await found.setup.login({ stateDir, subscription: chosen, interaction });
    return { command, status: "ok", summary: `Yolo is signed in to ${chosen}; the node uses it when no agent's sign-in answers (no restart needed)`, steps: [{ id: "credential", status: "done", message: `Stored in ${stateDir}` }] };
  } finally {
    close();
  }
}

async function logout({ p, command, subscription }) {
  const { found, stateDir } = await provider(p);
  if (!found.plugin) return { command, status: "failed", summary: found.error ?? NO_PROVIDER };
  if (!subscription) return { command, status: "failed", summary: `Name the subscription: npm run yolo -- ${usage}` };
  await found.setup.logout({ stateDir, subscription });
  return { command, status: "ok", summary: `Yolo's own sign-in to ${subscription} is removed` };
}

export async function run({ positionals, p }) {
  const [action = "status", subscription = null] = positionals;
  const command = `models ${action}`;
  if (action === "status") return status({ p, command });
  if (action === "login") return login({ p, command, subscription });
  if (action === "logout") return logout({ p, command, subscription });
  return { command, status: "failed", summary: `Unknown action "${action}". Usage: npm run yolo -- ${usage}` };
}
