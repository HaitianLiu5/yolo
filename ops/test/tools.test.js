import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installTools, platformKey, readManifest, toolStatus } from "../lib/tools.js";
import { ROOT } from "../lib/paths.js";

// Each checkout links the builds its tools.json pins, verified by SHA-256
// before they are unpacked (Agent Note 2026-10-25-pinned-node-tools).

const key = platformKey();
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// A checkout pinning `release` of one tool, whose "archive" is a text that
// the fake extractor turns into a script printing the release.
function checkout(release, { cache, archive = `archive ${release}` } = {}) {
  const root = mkdtempSync(join(tmpdir(), "yolo-tools-"));
  const platforms = { [key]: { asset: "tool.zip", sha256: sha256(`archive ${release}`), executable: "tool-bin" } };
  writeFileSync(join(root, "tools.json"), JSON.stringify({ tools: { tool: { repository: "example/tool", release, platforms } } }));
  const downloads = [];
  const fetchImpl = async (url) => {
    downloads.push(url);
    return new Response(archive);
  };
  const extract = async (zip, dir) => writeFileSync(join(dir, "tool-bin"), `#!/bin/sh\necho ${release}\n`);
  return { root, downloads, run: () => installTools({ root, env: { YOLO_TOOLS_CACHE: cache, PATH: process.env.PATH }, fetchImpl, extract }) };
}

test("a checkout links the release it pins, downloads it once, and another checkout's release stays cached for a rollback", { skip: !key }, async () => {
  const cache = mkdtempSync(join(tmpdir(), "yolo-tools-cache-"));
  const env = { YOLO_TOOLS_CACHE: cache };
  const older = checkout("1.0", { cache });
  assert.deepEqual(toolStatus({ root: older.root, env }).map((tool) => tool.status), ["missing"]);
  await older.run();
  await older.run();
  assert.deepEqual(older.downloads, ["https://github.com/example/tool/releases/download/1.0/tool.zip"]);
  assert.deepEqual(toolStatus({ root: older.root, env }).map((tool) => tool.status), ["ok"]);

  // The same checkout moved to a newer release (an upgrade) is stale until npm install links it.
  const newer = checkout("2.0", { cache });
  writeFileSync(join(older.root, "tools.json"), JSON.stringify(readManifest(newer.root)));
  assert.deepEqual(toolStatus({ root: older.root, env }).map((tool) => tool.status), ["stale"]);
  await newer.run();
  assert.match(readlinkSync(join(newer.root, ".tools/bin/tool")), /2\.0/);
  assert.ok(existsSync(join(cache, "tool", `1.0-${key}`, "tool-bin")), "the older release stays cached");
});

test("a download whose SHA-256 is not the pinned one is refused and never linked", { skip: !key }, async () => {
  const cache = mkdtempSync(join(tmpdir(), "yolo-tools-cache-"));
  const tampered = checkout("1.0", { cache, archive: "something else" });
  await assert.rejects(tampered.run(), /SHA-256 .* not the pinned/);
  assert.equal(existsSync(join(tampered.root, ".tools/bin/tool")), false);
  assert.equal(existsSync(join(cache, "tool", `1.0-${key}`)), false);
});

test("tools.json pins every tool for macOS and Linux on arm64 and x64, each archive with a SHA-256", () => {
  for (const [name, tool] of Object.entries(readManifest(ROOT).tools)) {
    assert.deepEqual(Object.keys(tool.platforms).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"], name);
    for (const build of Object.values(tool.platforms)) assert.match(build.sha256, /^[0-9a-f]{64}$/, name);
  }
});
