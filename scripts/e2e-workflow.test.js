import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

// The E2E workflow writes its matrix out, so no job runs first to list the
// files (Agent Note 2026-07-21-test-layers); this keeps that list whole.

const ROOT = resolve(import.meta.dirname, "..");

test("the E2E workflow runs every e2e test file, each on a runner of its own", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/e2e.yml"), "utf8");
  const list = /^ +file:\n((?: +- .+\n)+)/m.exec(workflow);
  assert.ok(list, "e2e.yml needs a matrix `file:` list");
  const matrix = list[1].split("\n").filter(Boolean).map((line) => line.replace(/^ +- /, "").trim());
  const files = readdirSync(join(ROOT, "test/e2e")).filter((name) => name.endsWith(".test.js")).map((name) => name.slice(0, -".test.js".length));
  assert.deepEqual([...matrix].sort(), files.sort(), "e2e.yml's matrix lists each file under test/e2e/ once, by its name without .test.js");
});
