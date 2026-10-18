import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { findProviderNames, providerNameReport, providerNames } from "./provider-names.js";

// Core, control, and node code know no provider (Agent Note
// 2026-10-11-plugin-architecture). The last test is the gate `npm run check`
// runs over this repository; the first shows, on a fixture repository, that
// the check fires.

// The fixture repository must not inherit GIT_DIR and friends from a hook.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];

test("a provider name in a tracked file under service/ fails, by plugin directory and alias, as a whole word when hyphenated", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yolo-provider-names-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (files) => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
  };
  write({
    "plugins/source-ytdlp/package.json": "{}\n",
    "plugins/dns-desec/package.json": "{}\n",
    "plugins/source-example/package.json": "{}\n",
    "service/core/src/sources.js": "// YouTube answers first.\n",
    "service/node/src/tools.js": "const bin = \"yt-dlp\";\nif (!env.NODE_SECRET) throw new Error();\n",
    "service/control/migrations/0003_plugin_sources.sql": "-- the yt-dlp plugin's source\n",
    "service/control/migrations/0009_more.sql": "-- the yt-dlp plugin's source\n",
  });
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  write({ "service/node/src/scratch.js": "// try ytdlp here\n" });

  assert.deepEqual(providerNames(root), ["dedyn", "desec", "youtube", "ytdlp"], "the template gives none");
  const result = findProviderNames(root);
  assert.deepEqual(result.violations.map(({ file, line, names }) => `${file}:${line} ${names}`), [
    "service/control/migrations/0009_more.sql:1 ytdlp",
    "service/core/src/sources.js:1 youtube",
    "service/node/src/tools.js:1 ytdlp",
  ], "only the migrations that convert 0.1 rows may name one; untracked files and NODE_SECRET do not count");
  assert.match(providerNameReport(result), /2026-10-11-plugin-architecture/);
});

test("this repository names no provider in service/ outside the D1 migrations and the migration test that convert 0.1 rows", () => {
  const root = resolve(import.meta.dirname, "..");
  for (const name of ["plex", "ytdlp", "youtube"]) assert.ok(providerNames(root).includes(name), name);
  const result = findProviderNames(root);
  if (result.violations.length > 0) assert.fail(providerNameReport(result));
});
