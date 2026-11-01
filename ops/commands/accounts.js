import { join } from "node:path";
import { pluginDirectory, runtimeDirectory } from "@useyolo/plugin-api/host";
import { renderUnicodeCompact } from "uqr";
import { readEnvFile } from "../lib/env-file.js";
import { findSetupPlugin } from "../lib/setup-entry.js";

// Yolo's own sign-ins to the sites a source plugin plays from, such as a
// subscription that unlocks full replays and paid live games. Runs on the
// node's machine, where the plugin keeps the sign-in; the node reads it
// without a restart (Agent Note 2026-10-26-tencent-sports-replays).

export const summary = "Show or sign Yolo in to the video site accounts its source plugins play with";
export const usage = "accounts status|login|logout [account]";
export const options = {};

const NO_PROVIDER = "No loaded plugin signs in to an account: add ./plugins/source-ytdlp to yolo.config.json, or remove yolo.config.json to load the official plugins";

// The plugin with an accounts setup entry, its state directory, and the
// environment it sees.
async function provider(p) {
  const env = { ...(readEnvFile(p.envFile) ?? {}), ...process.env };
  const found = await findSetupPlugin({ root: p.root, env, provider: "accounts" });
  if (!found.plugin) return { found, env };
  const stateDir = pluginDirectory(join(runtimeDirectory({ root: p.root, env }), ".yolo", "plugins"), found.plugin.name);
  return { found, env, stateDir };
}

const via = { wechat: "Yolo's own sign-in", cookies: "the sign-in in the cookies file" };

async function status({ p, command }) {
  const { found, env, stateDir } = await provider(p);
  if (!found.plugin) return { command, status: "failed", summary: found.error ?? NO_PROVIDER };
  const { accounts } = await found.setup.status({ stateDir, env, options: found.plugin.options });
  const steps = accounts.map((account) => ({
    id: `account.${account.id}`,
    status: account.signedIn ? "ok" : "info",
    message: account.signedIn
      ? `${account.label}: signed in, with ${via[account.via] ?? account.via}${account.sessionUntil ? `; session until ${account.sessionUntil}` : ""}`
      : `${account.label}: not signed in`,
  }));
  const missing = accounts.filter((account) => !account.signedIn);
  return {
    command,
    status: "ok",
    summary: missing.length ? `${missing.length} of ${accounts.length} accounts are not signed in` : "Every account is signed in",
    steps,
    ...(missing.length ? { next: missing.map((account) => `npm run yolo -- accounts login ${account.id}`) } : {}),
  };
}

// The sign-in's messages on this terminal, on stderr, so --json output on
// stdout stays clean; a QR code is drawn for the phone to scan.
function terminalInteraction() {
  const say = (text) => process.stderr.write(`${text}\n`);
  return {
    notify(event) {
      if (event.message) say(`\n${event.message}`);
      if (event.type === "qr") {
        say(`\n${renderUnicodeCompact(event.text, { border: 2 })}`);
        if (event.url) say(`If the code does not scan, open this picture on another screen: ${event.url}\n`);
      }
    },
  };
}

async function login({ p, command, account }) {
  const { found, stateDir } = await provider(p);
  if (!found.plugin) return { command, status: "failed", summary: found.error ?? NO_PROVIDER };
  if (!process.stdin.isTTY) {
    return { command, status: "needs_human", summary: "Signing in needs the owner at a terminal on the node's machine (an SSH session works) and their phone", next: ["The owner, in their own terminal: npm run yolo -- accounts login"] };
  }
  const offered = await found.setup.offered();
  const chosen = account ?? offered[0]?.id;
  if (!offered.some(({ id }) => id === chosen)) return { command, status: "failed", summary: `Yolo signs in to ${offered.map(({ id }) => id).join(", ")}, not ${chosen}` };
  try {
    const result = await found.setup.login({ stateDir, account: chosen, interaction: terminalInteraction() });
    return { command, status: "ok", summary: `Yolo is signed in to ${chosen}; the node uses it from its next play (no restart needed)`, steps: [{ id: "credential", status: "done", message: `Stored in ${stateDir}${result.sessionUntil ? `; renewed on demand from ${result.sessionUntil}` : ""}` }] };
  } catch (error) {
    return { command, status: "failed", summary: `The sign-in did not finish: ${error.message}` };
  }
}

async function logout({ p, command, account }) {
  const { found, stateDir } = await provider(p);
  if (!found.plugin) return { command, status: "failed", summary: found.error ?? NO_PROVIDER };
  const offered = await found.setup.offered();
  const chosen = account ?? offered[0]?.id;
  if (!offered.some(({ id }) => id === chosen)) return { command, status: "failed", summary: `Yolo signs in to ${offered.map(({ id }) => id).join(", ")}, not ${chosen}` };
  await found.setup.logout({ stateDir, account: chosen });
  return { command, status: "ok", summary: `Yolo's own sign-in to ${chosen} is removed; a sign-in in the cookies file is still used` };
}

export async function run({ positionals, p }) {
  const [action = "status", account = null] = positionals;
  const command = `accounts ${action}`;
  if (action === "status") return status({ p, command });
  if (action === "login") return login({ p, command, account });
  if (action === "logout") return logout({ p, command, account });
  return { command, status: "failed", summary: `Unknown action "${action}". Usage: npm run yolo -- ${usage}` };
}
