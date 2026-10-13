import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
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
