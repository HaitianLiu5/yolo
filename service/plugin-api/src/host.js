import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
// listed, or is listed with "enabled": false, does not load. An entry marked
// "builtIn" is one the official list loads on every node (built-in link
// playback); plugins turned on from a screen go before the first of them
// (Agent Note 2026-10-31-home-cold-start).

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
// The zero-setup default: built-in link playback, with its options taken from
// environment variables, and the catalog of official plugins an owner can
// turn on.
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
    return { source: entry.source.trim(), enabled: entry.enabled !== false, options: entry.options ?? {}, builtIn: entry.builtIn === true };
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
  if (!entry.enabled) {
    // Not loaded, but named: screens list it and a switch turns it on.
    const dir = packageDir(entry.source, baseDir);
    if (dir) Object.assign(result, { root: dir, name: readManifest(dir)?.name ?? entry.source });
    return result;
  }
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

// Everything the node and the control build need: which file applied (and
// its digest when it is the owner's), the resolved plugins in order, and the
// raw `egress` section or null. Throws
// only for an unreadable config file.
export function loadPluginConfig({ root, env = process.env }) {
  const { path, explicit } = pluginConfigPath({ root, env });
  const config = readConfigFile(path);
  // The file as read, so a writer can tell an owner's edit since (changePluginConfig).
  const digest = explicit ? configDigest(readFileSync(path, "utf8")) : null;
  return { path, explicit, digest, plugins: resolvePlugins(readPluginConfig(path, config), dirname(path)), egress: config.egress ?? null };
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

// --- The manifest and the catalog (Agent Note 2026-10-31-home-cold-start) ---
//
// A plugin describes itself in its package.json's `yolo` field, beside its
// entries: what screens show (`title`, `summary`), what it registers
// (`kinds`), the place it offers in the guide (`place`), how a screen
// connects it (`connect`), the options a form shows, and what it reads,
// keeps, and sends (`privacy`). The host reads these without importing any
// code, so the catalog is cheap and a broken plugin still shows. Fields
// that are missing or malformed are left out rather than failing the plugin.

export const PLUGIN_KINDS = Object.freeze(["source", "account", "metadata", "agent", "model", "speech", "proxy", "dns"]);
export const CONNECT_KINDS = Object.freeze(["qr", "code", "folder", "fields", "instructions"]);
export const OPTION_TYPES = Object.freeze(["string", "number", "boolean", "folder", "folders", "url"]);
export const PLACE_GROUPS = Object.freeze(["files", "site", "agent"]);
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/;
const PLACE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const OPTION_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

// A text a screen shows: a string, or { en, zh, … } with English required.
function manifestText(value, max = 400) {
  const clean = (text) => String(text).trim().slice(0, max);
  if (typeof value === "string" && value.trim()) return { en: clean(value) };
  if (!isObject(value) || typeof value.en !== "string" || !value.en.trim()) return null;
  return Object.fromEntries(Object.entries(value)
    .filter(([tag, text]) => LANGUAGE_TAG.test(tag) && typeof text === "string" && text.trim())
    .map(([tag, text]) => [tag, clean(text)]));
}

function manifestPlace(value) {
  if (!isObject(value) || !PLACE_ID.test(String(value.id ?? ""))) return null;
  return {
    id: value.id,
    ...(manifestText(value.title, 60) ? { title: manifestText(value.title, 60) } : {}),
    ...(manifestText(value.summary) ? { summary: manifestText(value.summary) } : {}),
    icon: typeof value.icon === "string" && PLACE_ID.test(value.icon) ? value.icon : value.id,
    group: PLACE_GROUPS.includes(value.group) ? value.group : "site",
    // The languages whose screens list this place first among sites.
    languages: Array.isArray(value.languages) ? value.languages.filter((tag) => typeof tag === "string" && LANGUAGE_TAG.test(tag)) : [],
  };
}

function manifestOption(value) {
  if (!isObject(value) || !OPTION_KEY.test(String(value.key ?? "")) || !OPTION_TYPES.includes(value.type)) return null;
  return {
    key: value.key,
    type: value.type,
    title: manifestText(value.title, 80) ?? { en: value.key },
    ...(manifestText(value.help) ? { help: manifestText(value.help) } : {}),
    ...(value.secret === true ? { secret: true } : {}),
    ...(typeof value.env === "string" && /^[A-Z][A-Z0-9_]*$/.test(value.env) ? { env: value.env } : {}),
    ...(value.default !== undefined && !isObject(value.default) ? { default: value.default } : {}),
  };
}

/**
 * A plugin's package.json read as a manifest, or null when there is none.
 * @returns {{ name, version, description, title, summary, kinds, place, connect, options, privacy, terms,
 *   hosts, reload, api, entries: { node, control, setup } } | null}
 */
export function readManifest(dir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (!isObject(manifest)) return null;
  const yolo = isObject(manifest.yolo) ? manifest.yolo : {};
  const name = typeof manifest.name === "string" && manifest.name ? manifest.name : basename(dir);
  const description = typeof manifest.description === "string" ? manifest.description : "";
  return {
    name,
    version: typeof manifest.version === "string" ? manifest.version : null,
    description,
    title: manifestText(yolo.title, 60) ?? { en: name.replace(/^@[^/]+\//, "") },
    summary: manifestText(yolo.summary) ?? (description ? { en: description } : null),
    kinds: Array.isArray(yolo.kinds) ? yolo.kinds.filter((kind) => PLUGIN_KINDS.includes(kind)) : [],
    place: manifestPlace(yolo.place),
    connect: CONNECT_KINDS.includes(yolo.connect) ? yolo.connect : null,
    options: Array.isArray(yolo.options) ? yolo.options.map(manifestOption).filter(Boolean) : [],
    privacy: manifestText(yolo.privacy, 600),
    terms: manifestText(yolo.terms, 600),
    hosts: Array.isArray(yolo.hosts) ? yolo.hosts.filter((host) => typeof host === "string" && host).slice(0, 50) : [],
    reload: yolo.reload === "restart" ? "restart" : "in-place",
    api: typeof yolo.api === "string" ? yolo.api : null,
    entries: Object.fromEntries(["node", "control", "setup"].map((side) => [side, typeof yolo[side] === "string" ? yolo[side] : null])),
  };
}

/**
 * The official list: what a node with no config of its own loads
 * (`plugins`), what an owner can turn on (`catalog`, package directories),
 * and the plugins a place brings along (`with`, place id → directories).
 */
export function readOfficialList({ root }) {
  const path = join(root, OFFICIAL_CONFIG);
  const config = readConfigFile(path);
  const dir = dirname(path);
  const dirs = (list) => (Array.isArray(list) ? list.filter((source) => typeof source === "string" && source).map((source) => packageDir(source, dir)).filter(Boolean) : []);
  const bringsAlong = isObject(config.with) ? config.with : {};
  return {
    path,
    plugins: readPluginConfig(path, config),
    catalog: dirs(config.catalog),
    with: Object.fromEntries(Object.entries(bringsAlong).filter(([id]) => PLACE_ID.test(id)).map(([id, list]) => [id, dirs(list)])),
  };
}

// A package directory as a config entry's source in a config file in
// `configDir`: relative when it is inside, absolute otherwise.
export function sourceFor(dir, configDir) {
  const inside = relative(configDir, dir);
  return inside.startsWith("..") || isAbsolute(inside) ? dir : `./${inside.split(sep).join("/")}`;
}

// --- Writing the config -----------------------------------------------------
//
// The node owns the plugin config once a screen changes it: it writes the
// file it loaded (YOLO_CONFIG, else yolo.config.json), and a node on the
// defaults creates yolo.config.json from the official list on its first
// change. It changes only the entry it was asked to, keeps every other field
// (`egress` included) and the order, puts a new entry before the first
// built-in source, and writes atomically with 2-space JSON.

export const configDigest = (text) => createHash("sha256").update(text).digest("hex");

function readConfigText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Turn the plugin in package directory `dir` on or off, or change its
 * options, in the config the node loads.
 * @param {object} change  { enabled?: boolean, options?: object } — options replace the entry's own
 * @param {string} [expected]  configDigest() of the file as its writer last saw it: a file changed since
 *   (an owner's edit by hand) is refused, never overwritten
 * @param {string[]} [order]  package directories in the order plugins should load (the official catalog's):
 *   a new entry goes before the first listed entry that comes after it there, so metadata merges in its order
 * @returns {{ path, digest }} the file written and its digest
 */
export function changePluginConfig({ root, env = process.env, dir, change, expected = null, order = [] }) {
  const found = pluginConfigPath({ root, env });
  const path = found.explicit ? found.path : join(root, CONFIG_FILE);
  const text = found.explicit ? readConfigText(path) : null;
  if (expected && text != null && configDigest(text) !== expected) {
    throw Object.assign(new Error(`${path} changed since the media node read it; restart the node to load it, then try again`), { code: "conflict" });
  }
  let config;
  const configDir = dirname(path);
  if (text != null) {
    config = JSON.parse(text);
    if (!isObject(config) || !Array.isArray(config.plugins)) throw new Error(`${path}: "plugins" must be an array`);
  } else {
    // The defaults become the owner's file, with sources from its directory.
    const official = readOfficialList({ root });
    config = {
      plugins: official.plugins.map((entry) => {
        const source = entry.source.startsWith(".") ? sourceFor(resolve(dirname(official.path), entry.source), configDir) : entry.source;
        return { source, ...(entry.builtIn ? { builtIn: true } : {}), ...(entry.enabled ? {} : { enabled: false }), ...(Object.keys(entry.options).length ? { options: entry.options } : {}) };
      }),
    };
  }
  // Entries other than the one changed keep their form, a string included.
  const entries = config.plugins.map((value) => ({ entry: typeof value === "string" ? { source: value } : value, original: value }));
  const index = entries.findIndex(({ entry }) => isObject(entry) && typeof entry.source === "string" && packageDir(entry.source.trim(), configDir) === dir);
  const entry = index >= 0 ? { ...entries[index].entry } : { source: sourceFor(dir, configDir) };
  if (change.enabled === true) delete entry.enabled;
  if (change.enabled === false) entry.enabled = false;
  if (change.options !== undefined) {
    if (isObject(change.options) && Object.keys(change.options).length) entry.options = change.options;
    else delete entry.options;
  }
  if (index >= 0) {
    entries[index] = { entry, original: entry };
  } else {
    const builtIn = entries.findIndex(({ entry: other }) => isObject(other) && other.builtIn === true);
    const end = builtIn >= 0 ? builtIn : entries.length;
    const rank = order.indexOf(dir);
    const later = rank < 0 ? -1 : entries.slice(0, end).findIndex(({ entry: other }) => {
      const at = isObject(other) && typeof other.source === "string" ? order.indexOf(packageDir(other.source.trim(), configDir)) : -1;
      return at > rank;
    });
    entries.splice(later >= 0 ? later : end, 0, { entry, original: entry });
  }
  config.plugins = entries.map(({ original }) => original);
  const written = `${JSON.stringify(config, null, 2)}\n`;
  mkdirSync(configDir, { recursive: true });
  const temporary = join(configDir, `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, written);
  renameSync(temporary, path);
  return { path, digest: configDigest(written) };
}
