import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { YoloError } from "@useyolo/core";
import { changePluginConfig, loadPluginConfig, pluginDirectory, readManifest, readOfficialList } from "@useyolo/plugin-api/host";

// The node's plugin manager (Agent Note 2026-10-31-home-cold-start): the
// catalog a screen shows, and turning plugins on and off, or changing their
// options, from a screen, an agent's approved request, or the home machine's
// terminal. It writes the plugin config (changePluginConfig in
// @useyolo/plugin-api/host) and applies it in place through the loader
// (plugins.js apply()). A plugin whose manifest says `reload: "restart"`
// waits for a node restart instead, which the node does itself once nothing
// plays when a service manager runs it.
//
// The catalog is every official plugin the official list names in its
// `catalog`, the plugins it loads by default (built-in link playback), and
// every plugin the config lists. Plugins share a place by its id; choosing a
// place turns on its plugins and the ones the official list's `with` brings
// along. An option a manifest marks secret never goes into the config: it is
// kept in .yolo/plugin-options/<plugin>.json (mode 600) and merged into the
// plugin's options at load.

const OPTIONS_DIR = [".yolo", "plugin-options"];
const PLACE_GROUP_ORDER = ["files", "site", "agent"];
const MAX_OPTION_LENGTH = 2000;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keyOf = (entry) => entry.root ?? entry.node ?? entry.name;

const secretsFile = (runtimeDir, name) => `${pluginDirectory(join(runtimeDir, ...OPTIONS_DIR), name)}.json`;

function readSecrets(runtimeDir, name) {
  try {
    const value = JSON.parse(readFileSync(secretsFile(runtimeDir, name), "utf8"));
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

function writeSecrets(runtimeDir, name, values) {
  const path = secretsFile(runtimeDir, name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Config entries with each plugin's secret options merged into its options. */
export function withSecretOptions(entries, runtimeDir) {
  return entries.map((entry) => {
    if (!entry.enabled || !entry.name) return entry;
    const secrets = readSecrets(runtimeDir, entry.name);
    return Object.keys(secrets).length ? { ...entry, options: { ...entry.options, ...secrets } } : entry;
  });
}

// An option's value from a screen, by its manifest type; null removes it.
function optionValue(option, value) {
  if (value === null || value === undefined || value === "") return null;
  const where = `Option ${option.key}`;
  switch (option.type) {
    case "number": {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new YoloError("invalid_request", `${where} must be a number`);
      return number;
    }
    case "boolean":
      if (typeof value !== "boolean") throw new YoloError("invalid_request", `${where} must be true or false`);
      return value;
    case "folders": {
      const list = Array.isArray(value) ? value : [value];
      if (!list.every((item) => typeof item === "string" && item.trim())) throw new YoloError("invalid_request", `${where} must be a list of folders`);
      return list.map((item) => item.trim().slice(0, MAX_OPTION_LENGTH));
    }
    case "url": {
      const text = String(value).trim();
      let url;
      try {
        url = new URL(text);
      } catch {
        throw new YoloError("invalid_request", `${where} must be a web address`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new YoloError("invalid_request", `${where} must be an http or https address`);
      return text.slice(0, MAX_OPTION_LENGTH);
    }
    default:
      if (typeof value !== "string" && typeof value !== "number") throw new YoloError("invalid_request", `${where} must be text`);
      return String(value).trim().slice(0, MAX_OPTION_LENGTH) || null;
  }
}

/**
 * @param {object} options
 * @param {string} options.root  the checkout, where plugins/official.json lives
 * @param {object} options.env  the node's environment (YOLO_CONFIG, and the variables options name)
 * @param {string} options.runtimeDir  where .yolo/plugin-options and .yolo/local-plugins live
 * @param {object} options.plugins  the loader's host (plugins.js)
 * @param {object} options.config  loadPluginConfig()'s result the node started with
 * @param {() => boolean} [options.restart]  asks the node to restart once nothing plays; true when it will
 */
export function createPluginManager({ root, env = process.env, runtimeDir = root, plugins, config, restart = () => false, logger = console }) {
  let file = { path: config.path, explicit: config.explicit, digest: config.digest ?? null };
  // Plugins whose change waits for a restart, by name.
  const waiting = new Set();
  let restartScheduled = false;
  let changing = Promise.resolve();
  const officialDir = join(root, "plugins") + sep;
  const localDir = join(runtimeDir, ".yolo", "local-plugins") + sep;

  const originOf = (dir) => (dir?.startsWith(officialDir) ? "official" : dir?.startsWith(localDir) ? "local" : "package");

  function writable() {
    const path = file.explicit ? file.path : join(root, "yolo.config.json");
    try {
      accessSync(existsSync(path) ? path : dirname(path), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  // Every plugin the node can offer, with its manifest, its config entry,
  // and its state. Read again on each call: manifests are small files.
  function entries() {
    const official = readOfficialList({ root });
    const loaded = loadPluginConfig({ root, env });
    const running = new Map(plugins.status().map((status) => [status.root ?? status.name, status]));
    const byDir = new Map();
    const add = (dir, entry = null) => {
      const key = dir ?? entry?.source;
      if (!key || byDir.has(key)) return;
      byDir.set(key, { dir, entry });
    };
    for (const entry of loaded.plugins) add(entry.root, entry);
    for (const entry of official.plugins.filter((plugin) => plugin.builtIn)) add(join(dirname(official.path), entry.source).replace(/\/$/, ""));
    for (const dir of official.catalog) add(dir);
    const builtInDirs = new Set(official.plugins.filter((plugin) => plugin.builtIn).map((plugin) => join(dirname(official.path), plugin.source)));
    return {
      official,
      list: [...byDir.values()].map(({ dir, entry }) => {
        const manifest = dir ? readManifest(dir) : null;
        const name = manifest?.name ?? entry?.name ?? dir;
        const status = running.get(dir ?? name) ?? running.get(name);
        return { dir, entry, manifest, name, status, builtIn: Boolean(entry?.builtIn || builtInDirs.has(dir)) };
      }),
    };
  }

  function stateOf({ entry, status, name, manifest }) {
    const enabled = Boolean(entry?.enabled);
    if (waiting.has(name)) return "restart";
    if (!enabled) return status?.status === "stopping" ? "stopping" : "off";
    if (entry.error || status?.status === "failed") return "failed";
    if (status?.status === "started" || status?.status === "loaded") return "on";
    // A control entry alone runs in the Worker, applied by a redeploy.
    if (manifest?.entries.control && !manifest.entries.node) return "redeploy";
    return "restart";
  }

  function present(item) {
    const { dir, entry, manifest, name, status, builtIn } = item;
    const secrets = readSecrets(runtimeDir, name);
    const options = (manifest?.options ?? []).map((option) => {
      const fromEnv = Boolean(option.env && env[option.env]);
      const value = option.secret ? undefined : entry?.options?.[option.key];
      return {
        ...option,
        ...(option.secret ? { set: secrets[option.key] != null && secrets[option.key] !== "" } : { value: value ?? null }),
        ...(fromEnv ? { fromEnv: true } : {}),
      };
    });
    const error = entry?.error ?? status?.error ?? null;
    return {
      name,
      version: manifest?.version ?? entry?.version ?? null,
      title: manifest?.title ?? { en: name },
      summary: manifest?.summary ?? null,
      kinds: manifest?.kinds ?? [],
      place: manifest?.place ?? null,
      connect: manifest?.connect ?? null,
      privacy: manifest?.privacy ?? null,
      terms: manifest?.terms ?? null,
      hosts: manifest?.hosts ?? [],
      reload: manifest?.reload ?? "in-place",
      origin: originOf(dir),
      builtIn,
      enabled: Boolean(entry?.enabled),
      state: stateOf(item),
      ...(error ? { error } : {}),
      options,
      ...(manifest?.entries.control ? { control: true } : {}),
    };
  }

  function places(list, official) {
    const nameOf = new Map(list.map((item) => [item.dir, item.name]));
    const byId = new Map();
    for (const item of list) {
      const place = item.manifest?.place;
      if (!place || item.builtIn) continue;
      const known = byId.get(place.id);
      if (known) {
        known.plugins.push(item.name);
        known.on ||= Boolean(item.entry?.enabled);
        continue;
      }
      byId.set(place.id, {
        id: place.id,
        title: place.title ?? item.manifest.title,
        summary: place.summary ?? item.manifest.summary,
        icon: place.icon,
        group: place.group,
        languages: place.languages,
        plugins: [item.name],
        with: (official.with[place.id] ?? []).map((dir) => nameOf.get(dir)).filter(Boolean),
        on: Boolean(item.entry?.enabled),
      });
    }
    return [...byId.values()]
      .map(({ on, ...place }) => ({ ...place, state: on ? "on" : "off" }))
      .sort((left, right) => PLACE_GROUP_ORDER.indexOf(left.group) - PLACE_GROUP_ORDER.indexOf(right.group));
  }

  function catalog() {
    const { list, official } = entries();
    const presented = list.map(present);
    return {
      config: { path: file.explicit ? file.path : null, writable: writable() },
      plugins: presented,
      places: places(list, official),
      restart: waiting.size ? { plugins: [...waiting], automatic: restartScheduled } : null,
    };
  }

  function find(name) {
    const { list } = entries();
    const item = list.find((candidate) => candidate.name === name);
    if (!item) throw new YoloError("not_found", `No plugin named ${name} is in this node's catalog`);
    if (!item.dir) throw new YoloError("invalid_request", `${name} is not installed: ${item.entry?.error ?? "its package is missing"}`);
    return item;
  }

  // One plugin's change written: its secret options to their file, the rest
  // to the config. Returns whether it waits for a restart.
  function write(item, { enabled, options }) {
    if (item.builtIn && enabled === false) {
      throw new YoloError("invalid_request", `${item.name} is built in and has no switch; set "enabled": false in your plugin config by hand to turn it off`);
    }
    if (enabled !== undefined && typeof enabled !== "boolean") throw new YoloError("invalid_request", "enabled must be true or false");
    if (options !== undefined && !isObject(options)) throw new YoloError("invalid_request", "options must be an object");
    if (item.dir.startsWith(localDir) && item.manifest?.entries.control) {
      throw new YoloError("invalid_request", `${item.name} is a local plugin with a control entry, which would run in the Worker`);
    }
    const change = {};
    if (enabled !== undefined) change.enabled = enabled;
    if (options) {
      const described = new Map((item.manifest?.options ?? []).map((option) => [option.key, option]));
      const secrets = readSecrets(runtimeDir, item.name);
      const plain = { ...(item.entry?.options ?? {}) };
      let secretsChanged = false;
      for (const [key, raw] of Object.entries(options)) {
        const option = described.get(key);
        if (!option) throw new YoloError("invalid_request", `${item.name} has no option ${key}`);
        const value = optionValue(option, raw);
        const target = option.secret ? secrets : plain;
        if (value === null) delete target[key];
        else target[key] = value;
        if (option.secret) secretsChanged = true;
        // A secret never stays in the config, should an owner have put it there.
        if (option.secret) delete plain[key];
      }
      if (secretsChanged) writeSecrets(runtimeDir, item.name, secrets);
      change.options = plain;
    }
    if (!writable()) throw new YoloError("invalid_request", `The media node cannot write ${file.explicit ? file.path : join(root, "yolo.config.json")}; change the plugin there by hand`);
    try {
      file = { ...changePluginConfig({ root, env, dir: item.dir, change, expected: file.digest, order: readOfficialList({ root }).catalog }), explicit: true };
    } catch (error) {
      if (error.code === "conflict") throw new YoloError("invalid_request", error.message);
      throw error;
    }
    logger.info?.({ plugin: item.name, ...(enabled !== undefined ? { enabled } : {}), ...(options ? { options: Object.keys(options) } : {}) }, "Changed a plugin");
    const changesRunning = enabled !== undefined || options;
    return item.manifest?.reload === "restart" && changesRunning;
  }

  // The config as written, applied: plugins that need a restart keep their
  // running entry until then.
  async function apply() {
    const loaded = loadPluginConfig({ root, env });
    const current = new Map(plugins.entries().map((entry) => [keyOf(entry), entry]));
    const next = [];
    for (const entry of withSecretOptions(loaded.plugins, runtimeDir)) {
      if (!waiting.has(entry.name)) {
        next.push(entry);
        continue;
      }
      const running = current.get(keyOf(entry));
      if (running) next.push(running);
    }
    await plugins.apply(next);
    if (waiting.size && !restartScheduled) restartScheduled = restart() === true;
  }

  function serialized(work) {
    const run = changing.then(work);
    changing = run.catch(() => {});
    return run;
  }

  return {
    catalog,

    /** One plugin's change: { enabled?, options? } with option values by key (null removes one). */
    change(name, change = {}) {
      return serialized(async () => {
        const item = find(name);
        if (write(item, change)) waiting.add(item.name);
        await apply();
        return { plugin: catalog().plugins.find((plugin) => plugin.name === item.name), restart: catalog().restart };
      });
    },

    /**
     * A place turned on, with its plugins and the ones it brings along but
     * those in `without`; or off, its own plugins only (the ones it brought
     * along may serve other places).
     */
    setPlace(id, { enabled = true, without = [] } = {}) {
      return serialized(async () => {
        if (typeof enabled !== "boolean") throw new YoloError("invalid_request", "enabled must be true or false");
        const { list, official } = entries();
        const place = places(list, official).find((candidate) => candidate.id === id);
        if (!place) throw new YoloError("not_found", `No place ${id} is in this node's catalog`);
        const skipped = new Set(Array.isArray(without) ? without : []);
        const names = enabled ? [...place.plugins, ...place.with.filter((name) => !skipped.has(name))] : place.plugins;
        for (const name of names) {
          const item = find(name);
          if (Boolean(item.entry?.enabled) === enabled) continue;
          if (write(item, { enabled })) waiting.add(item.name);
        }
        await apply();
        const after = catalog();
        return { place: after.places.find((candidate) => candidate.id === id), plugins: after.plugins.filter((plugin) => names.includes(plugin.name)), restart: after.restart };
      });
    },

    /** Whether a plugin's change waits for the node's restart. */
    restartPending: () => waiting.size > 0,
  };
}
