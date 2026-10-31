import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";

// How Yolo finds plugins (Agent Note 2026-10-11-plugin-architecture). The media
// node uses this at startup, and the control plane's build uses it to write the
// static imports that Workers need. Node only; plugins do not import it.
//
// The config is JSON: { "plugins": [ { "source", "enabled"?, "options"? } ],
// "egress"? }, where `egress` holds the media node's proxy rules
// (Agent Note 2026-10-13-node-egress-proxy), which the node reads itself.
// `source` is a path relative to the config file (starting with "." or "/"),
// or an npm package name installed next to it. A string entry is shorthand
// for { "source": … }. The list is complete and ordered: a plugin that is not
// listed, or is listed with "enabled": false, does not load.

// The node's settings file: the repository .env, or the file YOLO_ENV_FILE
// names; an empty value loads none (tests).
export function envFilePath({ root, env = process.env }) {
  return env.YOLO_ENV_FILE ?? join(root, ".env");
}

// Loads that file into process.env (variables already set win) and returns
// its path, or null when there is none.
export function loadYoloEnv({ root, env = process.env }) {
  const file = envFilePath({ root, env });
  if (!file) return null;
  try {
    loadEnvFile(file);
    return file;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export const CONFIG_FILE = "yolo.config.json";
// The zero-setup default: the official plugins, with their options taken from
// environment variables.
export const OFFICIAL_CONFIG = "plugins/official.json";

// YOLO_CONFIG, else yolo.config.json in the repository, else the official list.
export function pluginConfigPath({ root, env = process.env }) {
  if (env.YOLO_CONFIG) return { path: resolve(root, env.YOLO_CONFIG), explicit: true };
  const file = join(root, CONFIG_FILE);
  if (existsSync(file)) return { path: file, explicit: true };
  return { path: join(root, OFFICIAL_CONFIG), explicit: false };
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function readConfigFile(path) {
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the plugin config ${path}: ${error.message}`, { cause: error });
  }
  if (!isObject(config) || !Array.isArray(config.plugins)) throw new Error(`${path}: "plugins" must be an array`);
  return config;
}

export function readPluginConfig(path, config = readConfigFile(path)) {
  return config.plugins.map((value, index) => {
    const entry = typeof value === "string" ? { source: value } : value;
    const where = `${path}: plugins[${index}]`;
    if (!isObject(entry) || typeof entry.source !== "string" || !entry.source.trim()) {
      throw new Error(`${where}.source must be a path or an npm package name`);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") throw new Error(`${where}.enabled must be true or false`);
    if (entry.options !== undefined && !isObject(entry.options)) throw new Error(`${where}.options must be an object`);
    return { source: entry.source.trim(), enabled: entry.enabled !== false, options: entry.options ?? {} };
  });
}

function packageDir(source, baseDir) {
  if (source.startsWith(".") || isAbsolute(source)) return resolve(baseDir, source);
  // An npm package: the nearest node_modules from the config file upwards,
  // the way Node resolves it, without depending on the package's "exports".
  for (let dir = baseDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", source);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

// One config entry → { name, version, source, enabled, options, root, node,
// control, error }. `node` and `control` are absolute entry paths or null.
// Problems land in `error` so one broken plugin does not stop the others.
export function resolvePlugin(entry, baseDir) {
  const result = { ...entry, name: entry.source, version: null, root: null, node: null, control: null, error: null };
  if (!entry.enabled) return result;
  try {
    const dir = packageDir(entry.source, baseDir);
    if (!dir) throw new Error(`npm package ${entry.source} is not installed`);
    result.root = dir;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch (error) {
      throw new Error(`cannot read ${join(dir, "package.json")}: ${error.message}`, { cause: error });
    }
    result.name = typeof manifest.name === "string" && manifest.name ? manifest.name : basename(dir);
    result.version = typeof manifest.version === "string" ? manifest.version : null;
    if (!isObject(manifest.yolo)) throw new Error(`${result.name} is not a Yolo plugin: its package.json has no "yolo" field`);
    for (const side of ["node", "control"]) {
      const relative = manifest.yolo[side];
      if (relative == null) continue;
      if (typeof relative !== "string") throw new Error(`"yolo.${side}" in ${result.name}'s package.json must be a path`);
      const path = resolve(dir, relative);
      if (!existsSync(path)) throw new Error(`${result.name}'s ${side} entry ${relative} does not exist`);
      result[side] = path;
    }
    if (!result.node && !result.control) throw new Error(`${result.name} has neither a "node" nor a "control" entry`);
  } catch (error) {
    result.error = error.message;
    result.node = null;
    result.control = null;
  }
  return result;
}

export function resolvePlugins(entries, baseDir) {
  const seen = new Set();
  return entries.map((entry) => {
    const plugin = resolvePlugin(entry, baseDir);
    if (plugin.enabled && !plugin.error) {
      if (seen.has(plugin.name)) return { ...plugin, node: null, control: null, error: `${plugin.name} is listed twice` };
      seen.add(plugin.name);
    }
    return plugin;
  });
}

// Everything the node and the control build need: which file applied, the
// resolved plugins in order, and the raw `egress` section or null. Throws
// only for an unreadable config file.
export function loadPluginConfig({ root, env = process.env }) {
  const { path, explicit } = pluginConfigPath({ root, env });
  const config = readConfigFile(path);
  return { path, explicit, plugins: resolvePlugins(readPluginConfig(path, config), dirname(path)), egress: config.egress ?? null };
}

// The directory of a plugin's own under `root`, named after its package:
// its cacheDir under the runtime directory's .media-cache/plugins, and its
// stateDir under .yolo/plugins, which the operator's command line opens too.
export function pluginDirectory(root, name) {
  return join(root, String(name).replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "-"));
}

// Where the node keeps its runtime state: YOLO_RUNTIME_DIR, else the checkout.
export function runtimeDirectory({ root, env = process.env }) {
  return resolve(env.YOLO_RUNTIME_DIR || root);
}
