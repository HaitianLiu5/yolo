import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NODE_PROTOCOL } from "@useyolo/core";
import { compareVersions, parseChangelog } from "../lib/changelog.js";
import { localMigrations } from "../lib/d1.js";
import { ROOT } from "../lib/paths.js";

// Yolo has one version: every workspace package carries the root's, and
// every dependency on a Yolo package pins it
// (Agent Note 2026-10-13-versions-and-releases).

const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const root = read("package.json");

test("every package carries the repository's version", () => {
  assert.match(root.version, /^\d+\.\d+\.\d+$/);
  for (const workspace of root.workspaces) {
    const manifest = read(join(workspace, "package.json"));
    assert.equal(manifest.version, root.version, `${workspace}/package.json`);
    for (const field of ["dependencies", "devDependencies"]) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith("@useyolo/")) assert.equal(range, root.version, `${workspace} ${field} ${name}`);
      }
    }
  }
});

test("CHANGELOG.md describes the current version with the code's protocol", () => {
  const releases = parseChangelog(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"));
  const entry = releases.find((release) => release.version === root.version);
  assert.ok(entry, `CHANGELOG.md needs a "## v${root.version} (YYYY-MM-DD)" section`);
  assert.equal(entry.error, null);
  assert.equal(entry.upgrade.protocol, NODE_PROTOCOL);
  assert.ok(["code", "restore"].includes(entry.upgrade.rollback));
  assert.ok(["restart", "none"].includes(entry.upgrade.node));
  // Newest first, and every listed migration exists.
  assert.deepEqual(releases.map((release) => release.version), [...releases.map((release) => release.version)].sort(compareVersions).reverse());
  const migrations = new Set(localMigrations(join(ROOT, "service/control/migrations")));
  for (const release of releases) for (const name of release.upgrade?.migrations ?? []) assert.ok(migrations.has(name), `${release.version}: ${name}`);
});
