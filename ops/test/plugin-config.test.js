import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migratePluginConfig, PREVIOUS_DEFAULTS, ranBefore } from "../lib/plugin-config.js";

// Existing instances keep their plugins across the release that made every
// plugin a choice (Agent Note 2026-10-31-home-cold-start).
function checkout(t) {
  const root = mkdtempSync(join(tmpdir(), "yolo-plugin-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plugins"));
  writeFileSync(join(root, "plugins", "official.json"), JSON.stringify({ plugins: [{ source: "./source-ytdlp", builtIn: true }], catalog: [] }));
  return root;
}

test("an instance that ran before keeps the old default list; a new one keeps the official list", (t) => {
  const root = checkout(t);
  assert.equal(ranBefore([{ kind: "deploy", version: "0.13.0" }]), false);
  assert.equal(ranBefore([{ kind: "deploy", version: "0.12.0" }, { kind: "deploy", version: "0.13.0" }]), true);
  assert.equal(migratePluginConfig({ root, env: {}, earlier: false }).status, "unchanged");
  assert.equal(migratePluginConfig({ root, env: {}, earlier: true }).status, "done");
  const written = JSON.parse(readFileSync(join(root, "yolo.config.json"), "utf8")).plugins;
  assert.deepEqual(written.map((entry) => entry.source), PREVIOUS_DEFAULTS.map((source) => source.replace("./", "./plugins/")));
  assert.deepEqual(written.filter((entry) => entry.builtIn).map((entry) => entry.source), ["./plugins/source-ytdlp"]);
});

test("an owner's own config only gets link playback marked built in, once", (t) => {
  const root = checkout(t);
  const config = { plugins: ["./plugins/source-plex", { source: "./plugins/source-ytdlp", options: { cookiesFile: "/c" } }], egress: { rules: [] } };
  writeFileSync(join(root, "yolo.config.json"), JSON.stringify(config));
  assert.equal(migratePluginConfig({ root, env: {}, earlier: true }).status, "done");
  assert.deepEqual(JSON.parse(readFileSync(join(root, "yolo.config.json"), "utf8")), {
    plugins: ["./plugins/source-plex", { source: "./plugins/source-ytdlp", options: { cookiesFile: "/c" }, builtIn: true }],
    egress: { rules: [] },
  });
  assert.equal(migratePluginConfig({ root, env: {}, earlier: true }).status, "unchanged");
});
