import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_FILE, pluginConfigPath, readOfficialList, sourceFor } from "@useyolo/plugin-api/host";
import { compareVersions } from "./changelog.js";

// The plugin config across the release that made every plugin a choice
// (Agent Note 2026-10-31-home-cold-start). Before it, a node with no config
// of its own loaded the official list below; after it, such a node loads only
// built-in link playback. An instance that ran before keeps what it loaded:
// with no config, it gets yolo.config.json with the old list; with one, the
// yt-dlp entry is marked built in, so plugins turned on from a screen go
// before it. Both steps are idempotent and leave a new instance alone.

// The first release whose node loads only built-in link playback by default.
export const CATALOG_RELEASE = "0.13.0";

// The official list of the releases before CATALOG_RELEASE.
export const PREVIOUS_DEFAULTS = Object.freeze([
  "./source-plex", "./source-ytdlp", "./agent-claude-code", "./agent-codex", "./model-subscriptions",
  "./metadata-local", "./metadata-wikimedia", "./metadata-bangumi", "./metadata-tvmaze", "./metadata-tmdb",
]);
const BUILT_IN = "./source-ytdlp";

// Whether this instance deployed, migrated, or upgraded a release before
// CATALOG_RELEASE, by its deployment records.
export function ranBefore(records) {
  return records.some((entry) => [entry.version, entry.from].some((version) => typeof version === "string" && compareVersions(version, CATALOG_RELEASE) < 0));
}

function writeAtomically(path, config) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * @param {object} options
 * @param {string} options.root  the checkout
 * @param {object} [options.env]  YOLO_CONFIG
 * @param {boolean} options.earlier  whether the instance ran a release before CATALOG_RELEASE
 * @returns a step: { id, status, message }
 */
export function migratePluginConfig({ root, env = process.env, earlier }) {
  const { path, explicit } = pluginConfigPath({ root, env });
  const official = readOfficialList({ root });
  const officialDir = dirname(official.path);
  if (!explicit) {
    if (!earlier) return { id: "plugins", status: "unchanged", message: "The node loads the official list: built-in link playback, and what the owner chooses" };
    const file = join(root, CONFIG_FILE);
    const plugins = PREVIOUS_DEFAULTS.map((source) => ({ source: sourceFor(join(officialDir, source), root), ...(source === BUILT_IN ? { builtIn: true } : {}) }));
    writeAtomically(file, { plugins });
    return { id: "plugins", status: "done", message: `Wrote ${file} with the plugins this instance loaded before, so it keeps them` };
  }
  if (!existsSync(path)) return { id: "plugins", status: "unchanged", message: `No plugin config at ${path}` };
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(config?.plugins)) return { id: "plugins", status: "warn", message: `${path} has no "plugins" list` };
  const builtIn = join(officialDir, BUILT_IN);
  let marked = false;
  config.plugins = config.plugins.map((value) => {
    const entry = typeof value === "string" ? { source: value } : value;
    if (!entry || typeof entry.source !== "string" || entry.builtIn) return value;
    const dir = entry.source.startsWith(".") || entry.source.startsWith("/") ? resolve(dirname(path), entry.source) : null;
    if (dir !== resolve(builtIn)) return value;
    marked = true;
    return { ...entry, builtIn: true };
  });
  if (!marked) return { id: "plugins", status: "unchanged", message: `${path} stays as it is` };
  writeAtomically(path, config);
  return { id: "plugins", status: "done", message: `Marked web links (source-ytdlp) built in, in ${path}, so plugins turned on from a screen go before it` };
}
