import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NODE_PROTOCOL } from "@useyolo/core";
import { APPLE_VERSION, APPLE_VERSION_FILE } from "../commands/release.js";
import { parseChangelog } from "../lib/changelog.js";
import { localMigrations } from "../lib/d1.js";
import { ROOT } from "../lib/paths.js";

// Yolo has one version, on every package, every dependency on a Yolo
// package, and the Apple clients, and every release has a CHANGELOG entry
// with its yolo-upgrade block (Agent Note 2026-10-13-versions-and-releases).

const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

test("every package carries the root's version, CHANGELOG.md describes it with the code's protocol, and listed migrations exist", () => {
  const { version, workspaces } = read("package.json");
  for (const workspace of workspaces) {
    const manifest = read(join(workspace, "package.json"));
    assert.equal(manifest.version, version, workspace);
    for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (name.startsWith("@useyolo/")) assert.equal(range, version, `${workspace} ${name}`);
    }
  }
  assert.equal(readFileSync(join(ROOT, APPLE_VERSION_FILE), "utf8").match(APPLE_VERSION)?.[1], version, APPLE_VERSION_FILE);
  const releases = parseChangelog(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"));
  const entry = releases.find((release) => release.version === version);
  assert.ok(entry, `CHANGELOG.md needs a "## v${version} (YYYY-MM-DD)" section`);
  assert.deepEqual([entry.error, entry.upgrade.protocol], [null, NODE_PROTOCOL]);
  const migrations = new Set(localMigrations(join(ROOT, "service/control/migrations")));
  for (const release of releases) for (const name of release.upgrade?.migrations ?? []) assert.ok(migrations.has(name), `${release.version}: ${name}`);
});
