import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { findProviderNames, providerNameReport, providerNames } from "./provider-names.js";

// Core, control, and node code know no provider (Agent Note
// 2026-10-11-plugin-architecture). The check runs first over fixture
// repositories, then over this one: that last test is the gate `npm run check`
// runs.

const ROOT = resolve(import.meta.dirname, "..");
const NOTE = ".agents/notes/implemented/architecture/2026-10-11-plugin-architecture.md";

// The fixture repositories must not inherit GIT_DIR and friends: a hook or
// `git rebase --exec` sets them, and git would then list the real index.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

// Plugins as `plugins/` lays them out: an invented source, a source whose
// provider is spelled with a hyphen and has an alias, a DNS provider with an
// alias, the template, and the default load list.
const PLUGINS = {
  "plugins/official.json": "{ \"plugins\": [] }\n",
  "plugins/source-acme/package.json": "{ \"name\": \"@useyolo/source-acme\" }\n",
  "plugins/source-ytdlp/package.json": "{ \"name\": \"@useyolo/source-ytdlp\" }\n",
  "plugins/dns-desec/package.json": "{ \"name\": \"@useyolo/dns-desec\" }\n",
  "plugins/source-example/package.json": "{ \"name\": \"@useyolo/source-example\" }\n",
};

/** A Git repository with `tracked` in its index and `untracked` beside it. */
function repo(tracked, untracked = {}) {
  const root = mkdtempSync(join(tmpdir(), "yolo-provider-names-"));
  roots.push(root);
  for (const [rel, content] of Object.entries({ ...PLUGINS, ...tracked })) write(root, rel, content);
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  for (const [rel, content] of Object.entries(untracked)) write(root, rel, content);
  return root;
}

const CLEAN = {
  "service/core/src/sources.js": "// A source claims a URL; the core never knows which one.\nexport const host = \"yolo.example.com\";\n",
  "service/node/src/plugins.js": "// Loads every plugin the config lists, in order.\n",
};

describe("provider names", () => {
  it("derives one name per plugin directory, adds its aliases, and skips the template", () => {
    assert.deepEqual(providerNames(repo({})), ["acme", "dedyn", "desec", "youtube", "ytdlp"]);
  });

  it("fails on a provider name in service/ and reports each file:line, the rule, and the note", () => {
    const root = repo({
      ...CLEAN,
      "service/core/src/sources.js": "// A source claims a URL.\n// Acme answers first.\nexport const x = 1;\n",
      "service/node/src/tools.js": "const bin = \"yt-dlp\";\nconst path = process.env.YT_DLP_PATH;\nconst id = \"YouTube\";\n",
      "service/control/src/edge/names.js": "// a dedyn.io name\n",
    });
    const result = findProviderNames(root);
    assert.deepEqual(result.violations.map(({ file, line, names }) => `${file}:${line} ${names.join(",")}`), [
      "service/control/src/edge/names.js:1 dedyn",
      "service/core/src/sources.js:2 acme",
      "service/node/src/tools.js:1 ytdlp",
      "service/node/src/tools.js:2 ytdlp",
      "service/node/src/tools.js:3 youtube",
    ]);
    const report = providerNameReport(result);
    assert.match(report, /service\/core\/src\/sources\.js:2\b.*Acme answers first/);
    assert.match(report, /service\/node\/src\/tools\.js:3\b/);
    assert.match(report, /must not know specific providers/);
    assert.match(report, /D1 migrations and the migration test that convert 0\.1 rows/);
    assert.ok(report.includes(NOTE), "the report links the plugin-architecture note");
  });

  it("passes on a clean service/, where the template's name and untracked files do not count", () => {
    const root = repo(CLEAN, { "service/node/src/scratch.js": "// try Acme here\n" });
    assert.deepEqual(findProviderNames(root).violations, []);
  });

  it("allows only the named migration files that convert 0.1 rows", () => {
    const names = "-- {\"kind\":\"acme\"} becomes the yt-dlp plugin's source\n";
    const allowed = {
      "service/control/migrations/0001_init.sql": names,
      "service/control/migrations/0003_plugin_sources.sql": names,
      "service/control/test/unit/source-migration.test.js": names,
    };
    assert.deepEqual(findProviderNames(repo({ ...CLEAN, ...allowed })).violations, []);
    const result = findProviderNames(repo({
      ...CLEAN,
      ...allowed,
      "service/control/migrations/0009_more.sql": names,
      "service/control/test/unit/other-migration.test.js": names,
    }));
    assert.deepEqual(result.violations.map(({ file }) => file), [
      "service/control/migrations/0009_more.sql",
      "service/control/test/unit/other-migration.test.js",
    ]);
  });
});

describe("this repository", () => {
  it("derives the official plugins' names, not the template's", () => {
    const names = providerNames(ROOT);
    for (const name of ["plex", "ytdlp", "youtube"]) assert.ok(names.includes(name), `${name} in ${names.join(", ")}`);
    assert.ok(!names.includes("example"), "source-example is a template, not a provider");
  });

  it("names no provider in service/ outside the D1 migrations and the migration test that convert 0.1 rows", () => {
    const result = findProviderNames(ROOT);
    if (result.violations.length > 0) assert.fail(providerNameReport(result));
  });
});
