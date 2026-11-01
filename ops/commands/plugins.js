import { changePluginConfig, loadPluginConfig, loadYoloEnv, readManifest, readOfficialList } from "@useyolo/plugin-api/host";
import { localSocketPath, requestLocal } from "../../service/node/src/local.js";
import { history } from "../lib/deployments.js";
import { migratePluginConfig, ranBefore } from "../lib/plugin-config.js";

// The home machine's view of the plugin catalog
// (Agent Note 2026-10-31-home-cold-start): list what the node can offer,
// turn a plugin or a place on or off, and migrate the config across the
// release that made every plugin a choice. On and off go through the running
// node's Unix socket, which applies them in place; with no node running they
// are written to the config and apply when it starts. Anyone with a shell as
// the node's user can already edit the config, so these need no passkey.

export const summary = "List the plugins the node can offer, turn one or a place on or off, or keep an upgraded instance's plugins (migrate)";
export const usage = "plugins list | on <plugin|place> | off <plugin|place> | migrate";
export const options = {};

const english = (text) => text?.en ?? "";

// The node's catalog over its socket, or null when no node answers.
async function ask(path, { method = "GET", body } = {}) {
  const secret = process.env.NODE_SECRET;
  if (!secret) return { offline: "NODE_SECRET is not set in .env" };
  try {
    const response = await requestLocal(path, { socketPath: localSocketPath(), secret, method, body, timeoutMs: 60_000 });
    if (response.status === 404 && response.body?.error?.message === "No such endpoint") return { offline: "the running node is older than this checkout; restart it" };
    if (response.status !== 200) return { error: response.body?.error?.message ?? `HTTP ${response.status}` };
    return { body: response.body };
  } catch (error) {
    return { offline: ["ENOENT", "ECONNREFUSED", "ETIMEDOUT"].includes(error.code) ? "the media node is not running" : error.message };
  }
}

// The catalog read from the files, for a node that is not running.
function offlineCatalog(root) {
  const official = readOfficialList({ root });
  const config = loadPluginConfig({ root, env: process.env });
  const byDir = new Map();
  for (const entry of config.plugins) if (entry.root) byDir.set(entry.root, entry);
  const dirs = [...new Set([...config.plugins.map((entry) => entry.root).filter(Boolean), ...official.catalog])];
  const plugins = dirs.map((dir) => {
    const manifest = readManifest(dir);
    const entry = byDir.get(dir);
    return { dir, name: manifest?.name ?? dir, title: manifest?.title, place: manifest?.place, builtIn: Boolean(entry?.builtIn), enabled: Boolean(entry?.enabled), state: entry?.enabled ? "on (when the node starts)" : "off" };
  });
  return { plugins, config: config.path };
}

// A plugin by its package name, its name without the scope, or a place id.
function pick(plugins, wanted) {
  const exact = plugins.filter((plugin) => plugin.name === wanted || plugin.name.replace(/^@[^/]+\//, "") === wanted);
  if (exact.length) return { plugins: exact };
  const place = plugins.filter((plugin) => plugin.place?.id === wanted);
  return place.length ? { place: wanted, plugins: place } : null;
}

function listing(plugins) {
  return plugins.map((plugin) => ({
    id: plugin.name,
    status: plugin.state === "on" || plugin.state?.startsWith?.("on") ? "ok" : plugin.state === "failed" ? "fail" : "info",
    message: `${plugin.name}: ${english(plugin.title) || plugin.name}, ${plugin.builtIn ? "built in" : plugin.state}${plugin.place ? ` (place ${plugin.place.id})` : ""}${plugin.error ? `: ${plugin.error}` : ""}`,
  }));
}

export async function run({ positionals, p }) {
  const command = "plugins";
  const [action, wanted] = positionals;
  loadYoloEnv({ root: p.root });
  if (action === "migrate") {
    const step = migratePluginConfig({ root: p.root, env: process.env, earlier: ranBefore(history(p)) });
    return { command, status: step.status === "warn" ? "failed" : "ok", summary: step.message, steps: [step] };
  }
  if (action === "list" && !wanted) {
    const online = await ask("/local/v1/plugins");
    if (online.error) return { command, status: "failed", summary: online.error };
    if (online.body) return { command, status: "ok", summary: `The node's plugins, from ${online.body.config.path ?? "the official list"}`, steps: listing(online.body.plugins) };
    const offline = offlineCatalog(p.root);
    return { command, status: "ok", summary: `The plugins in ${offline.config} (${online.offline})`, steps: listing(offline.plugins) };
  }
  if ((action !== "on" && action !== "off") || !wanted || positionals.length !== 2) {
    return { command, status: "failed", summary: `Usage: npm run yolo -- ${usage}` };
  }
  const enabled = action === "on";
  const online = await ask("/local/v1/plugins");
  if (online.error) return { command, status: "failed", summary: online.error };
  const catalog = online.body?.plugins ?? offlineCatalog(p.root).plugins;
  const found = pick(catalog, wanted);
  if (!found) return { command, status: "failed", summary: `No plugin or place named ${wanted}; npm run yolo -- plugins list shows them` };
  if (online.body) {
    const answer = found.place
      ? await ask(`/local/v1/plugins/places/${encodeURIComponent(found.place)}`, { method: "PUT", body: { enabled } })
      : await ask(`/local/v1/plugins/${encodeURIComponent(found.plugins[0].name)}`, { method: "PATCH", body: { enabled } });
    if (answer.error || answer.offline) return { command, status: "failed", summary: answer.error ?? answer.offline };
    const restart = answer.body.restart ? `; ${answer.body.restart.plugins.join(", ")} ${answer.body.restart.automatic ? "apply when the node restarts by itself, once nothing plays" : "apply when you restart the node: npm run yolo -- service restart node"}` : "";
    return { command, status: "ok", summary: `Turned ${found.place ? `the place ${found.place}` : found.plugins[0].name} ${action}${restart}` };
  }
  // No node: the config alone, applied when the node starts.
  const targets = found.place && enabled ? [...found.plugins] : found.plugins;
  for (const plugin of targets) {
    if (plugin.builtIn && !enabled) return { command, status: "failed", summary: `${plugin.name} is built in and has no switch` };
    changePluginConfig({ root: p.root, env: process.env, dir: plugin.dir, change: { enabled } });
  }
  return { command, status: "ok", summary: `Turned ${targets.map((plugin) => plugin.name).join(", ")} ${action} in the plugin config; it applies when the node starts (${online.offline})` };
}
