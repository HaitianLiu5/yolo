import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { YoloError } from "@useyolo/core";
import { loadPluginConfig, OFFICIAL_CONFIG } from "@useyolo/plugin-api/host";
import { loadPlugins } from "../src/plugins.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const plugin = (name, factory, extra = {}) => ({ name, source: `./${name}`, enabled: true, options: {}, factory, ...extra });

// The plugin contract (Agent Note 2026-10-11-plugin-architecture): load
// order, isolation of a failing plugin, and registration checks.
test("claims go in load order; a plugin that fails to load or start is isolated with its error", async () => {
  const events = [];
  const host = await loadPlugins([
    plugin("first", (yolo) => yolo.registerSource("music", { claim: () => undefined })),
    plugin("second", (yolo) => yolo.registerSource("clips", { claim: (url) => (url.includes("clip") ? { id: "c1" } : undefined) })),
    plugin("third", (yolo) => {
      yolo.registerSource("pages", { claim: (url) => ({ id: url }) });
      yolo.on("shutdown", () => events.push("third shutdown"));
    }),
    plugin("broken", (yolo) => {
      yolo.registerSource("half", {});
      throw new Error("missing API key");
    }),
    plugin("flaky", (yolo) => {
      yolo.registerSource("flaky", {});
      yolo.on("start", () => {
        throw new Error("port in use");
      });
      yolo.on("shutdown", () => events.push("flaky released"));
    }),
    plugin("hung", (yolo) => yolo.on("start", () => new Promise(() => {}))),
    plugin("dup", (yolo) => yolo.registerSource("pages", {})),
    plugin("bad-id", (yolo) => yolo.registerSource("Pages", {})),
    plugin("bad-method", (yolo) => yolo.registerSource("misc", { claim: "yes" })),
    plugin("off", () => events.push("off ran"), { enabled: false }),
  ], { logger: quiet, startTimeoutMs: 20 });
  await host.start();
  assert.deepEqual(host.status().map((entry) => entry.error ?? entry.status), [
    "started", "started", "started", "missing API key", "start failed: port in use", "start failed: The start handler did not finish within 0s",
    'Source id "pages" is already registered', 'Source id "Pages" must be lowercase letters, digits and dashes, starting with a letter',
    "Source misc: claim must be a function", "disabled",
  ]);
  assert.deepEqual(host.sources.ids(), ["music", "clips", "pages"]);
  assert.deepEqual(await host.sources.claim("https://x.test/clip"), { plugin: "clips", id: "c1" });
  assert.deepEqual(await host.sources.claim("https://x.test/page"), { plugin: "pages", id: "https://x.test/page" });
  await assert.rejects(host.sources.claim("not a url"), { code: "invalid_request" });
  await Promise.all([host.shutdown(), host.shutdown()]);
  assert.deepEqual(events, ["flaky released", "third shutdown"], "shutdown runs once; a plugin that failed to start released what it opened");
});

test("a plugin installed outside the repository gets the host's @useyolo/plugin-api and frozen options", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yolo-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "outside"));
  writeFileSync(join(dir, "outside", "package.json"), JSON.stringify({ name: "outside-plugin", type: "module", yolo: { node: "./node.js" }, peerDependencies: { "@useyolo/plugin-api": "*" } }));
  writeFileSync(join(dir, "outside", "node.js"), `
    import { YoloError } from "@useyolo/plugin-api";
    export default function (yolo) {
      if (!Object.isFrozen(yolo.options.nested)) throw new Error("options are writable");
      yolo.registerSource("outside", { claim: () => { throw new YoloError("forbidden", "not this one"); } });
    }
  `);
  writeFileSync(join(dir, "yolo.config.json"), JSON.stringify({ plugins: [{ source: "./outside", options: { nested: { a: 1 } } }] }));
  const host = await loadPlugins(loadPluginConfig({ root: dir, env: {} }).plugins, { logger: quiet });
  await host.start();
  assert.equal(host.status()[0].status, "started", host.status()[0].error);
  await assert.rejects(host.sources.claim("https://x.test/a"), (error) => error instanceof YoloError && error.code === "forbidden");
});

test("the official plugins load and start with an empty environment", async () => {
  const config = loadPluginConfig({ root: ROOT, env: { YOLO_CONFIG: OFFICIAL_CONFIG } });
  const host = await loadPlugins(config.plugins, { env: {}, logger: quiet });
  await host.start();
  for (const entry of host.status()) assert.equal(entry.status, "started", `${entry.name}: ${entry.error}`);
  assert.equal(typeof (await host.sources.claim("https://example.com/watch?v=1")).plugin, "string");
  // An agent loads even where its CLI is missing, and says whether it can answer.
  assert.equal(typeof (await host.agents.status()).available, "boolean");
  await host.shutdown();
});
