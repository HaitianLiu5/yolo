// Core, control, and node code must not know specific providers (Agent Note
// 2026-10-11-plugin-architecture). This finds every line of a tracked file
// under service/ that names one, outside the few files that convert 0.1 rows.
// `provider-names.test.js` runs it over this repository, so `npm run check`
// enforces the rule.
//
// The names come from the plugins themselves, so a new official plugin is
// covered without touching this file: every tracked `plugins/<kind>-<provider>/`
// directory with a package.json gives its <provider> (`source-plex` gives
// `plex`, `dns-desec` gives `desec`). A name matches case-insensitively: as a
// substring when it is spelled whole (`plexToken`), and as a whole word when
// a hyphen or underscore sits between its letters (`ytdlp` also catches
// `yt-dlp` and `YT_DLP_PATH`, while `desec` does not catch `NODE_SECRET`).

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const NOTE = ".agents/notes/implemented/architecture/2026-10-11-plugin-architecture.md";

/**
 * Other names a provider is known by, which its directory does not spell.
 * Keyed by the derived name; an entry applies only while that plugin exists.
 */
const ALIASES = {
  ytdlp: ["youtube"],
  desec: ["dedyn"],
  transocks: ["fobwifi", "kolavpn"],
};

/**
 * Plugin directories that name no provider. `source-example` is the template a
 * new plugin starts from, and its derived name, "example", is the generic word
 * service/ uses for placeholder hosts and example files. `proxy-url` is the
 * generic proxy provider, a fixed URL from the environment, and "url" is a
 * word every part of service/ uses.
 */
const TEMPLATES = new Set(["source-example", "proxy-url"]);

/**
 * The only files under service/ that may name a provider, listed one by one so
 * that no new file inherits the exception.
 */
const ALLOWED = new Set([
  // The 0.1 schema; a comment shows 0.1's source JSON.
  "service/control/migrations/0001_init.sql",
  // Converts 0.1's rows into the official plugins' sources.
  "service/control/migrations/0003_plugin_sources.sql",
  // Tests that conversion with 0.1's rows.
  "service/control/test/unit/source-migration.test.js",
]);

/**
 * Tracked paths under one directory.
 * @param {string} root Repository root.
 * @param {string} dir Repository-relative directory, with a trailing slash.
 * @returns {string[]}
 */
function trackedFiles(root, dir) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z", "--", dir], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (result.error) throw new Error(`git ls-files ${dir} failed: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`git ls-files ${dir} failed with status ${result.status}: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter(Boolean);
}

/**
 * Every provider name the plugins give, with their aliases, sorted.
 * @param {string} root Repository root.
 * @returns {string[]}
 */
export function providerNames(root) {
  const names = new Set();
  for (const path of trackedFiles(root, "plugins/")) {
    const dir = /^plugins\/([^/]+)\/package\.json$/.exec(path)?.[1];
    if (dir === undefined || TEMPLATES.has(dir)) continue;
    const provider = /^[a-z0-9]+-(.+)$/.exec(dir)?.[1];
    if (provider === undefined) throw new Error(`plugins/${dir}: expected a <kind>-<provider> directory, such as source-<provider>`);
    const name = bare(provider);
    names.add(name);
    for (const alias of ALIASES[name] ?? []) names.add(bare(alias));
  }
  return [...names].sort();
}

/** A name in lower case without hyphens or underscores. */
function bare(name) {
  return name.toLowerCase().replace(/[-_]/g, "");
}

/**
 * The bare name anywhere (`plexToken`), and a spelling with a hyphen or
 * underscore between its letters only as a whole word (`yt-dlp`,
 * `YT_DLP_PATH`), so that a word which merely contains the letters across a
 * separator does not count (`NODE_SECRET` does not spell `desec`).
 */
function namePattern(name) {
  const letters = [...name].map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`${letters.join("")}|(?<![a-z0-9])${letters.join("[-_]?")}(?![a-z0-9])`, "i");
}

/**
 * One line of service/ that names a provider.
 * @typedef {{ file: string, line: number, names: string[], text: string }} Violation
 */

/**
 * Every line of a tracked file under service/ that names a provider, outside
 * the allowed files.
 * @param {string} root Repository root.
 * @param {object} [options]
 * @param {ReadonlySet<string>} [options.allowed] Repository paths that may name providers.
 * @returns {{ names: string[], violations: Violation[] }}
 */
export function findProviderNames(root, { allowed = ALLOWED } = {}) {
  const names = providerNames(root);
  const patterns = names.map((name) => ({ name, pattern: namePattern(name) }));
  const violations = [];
  for (const file of trackedFiles(root, "service/").sort()) {
    if (allowed.has(file)) continue;
    const abs = join(root, file);
    // A tracked file deleted from the worktree, or a symlink, has no text of its own.
    if (!existsSync(abs) || !lstatSync(abs).isFile()) continue;
    const text = readFileSync(abs, "utf8");
    if (text.includes("\0")) continue;
    text.split("\n").forEach((content, index) => {
      const found = patterns.filter(({ pattern }) => pattern.test(content)).map(({ name }) => name);
      if (found.length > 0) violations.push({ file, line: index + 1, names: found, text: content.trim() });
    });
  }
  return { names, violations };
}

/**
 * The failure message: each file:line, the rule, the names checked, and the note.
 * @param {{ names: string[], violations: Violation[] }} result
 * @returns {string}
 */
export function providerNameReport({ names, violations }) {
  const lines = violations.map(({ file, line, names: found, text }) => {
    const shown = text.length > 100 ? `${text.slice(0, 100)}…` : text;
    return `  ${file}:${line}  [${found.join(", ")}]  ${shown}`;
  });
  return [
    `service/ names a provider on ${violations.length} line(s):`,
    ...lines,
    "",
    "Rule (AGENTS.md): core, control, and node code must not know specific providers. Under service/, only the D1 migrations and the migration test that convert 0.1 rows may name one (ALLOWED in scripts/provider-names.js). Move provider code into its plugin, and keep comments provider-neutral.",
    `Names checked: ${names.join(", ")}: each plugins/<kind>-<provider>, with the aliases in scripts/provider-names.js; a spelling with a hyphen or underscore between letters counts as a whole word.`,
    `Why: ${NOTE}`,
  ].join("\n");
}
