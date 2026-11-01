import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { YoloError } from "@useyolo/core";
import { loadPluginConfig, OFFICIAL_CONFIG, readManifest, readOfficialList, resolvePlugins } from "@useyolo/plugin-api/host";
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
      yolo.registerTranscriber("flaky", { transcribe: async () => ({ segments: [] }) });
      yolo.on("start", () => {
        throw new Error("port in use");
      });
      yolo.on("shutdown", () => events.push("flaky released"));
    }),
    plugin("hung", (yolo) => yolo.on("start", () => new Promise(() => {}))),
    plugin("speech", (yolo) => {
      yolo.registerTranscriber("ears", { transcribe: async () => ({ segments: [] }) });
      yolo.registerTranslator("words", { language: "zh-Hans", translate: async ({ lines }) => lines });
    }),
    plugin("dup", (yolo) => yolo.registerSource("pages", {})),
    plugin("bad-id", (yolo) => yolo.registerSource("Pages", {})),
    plugin("bad-method", (yolo) => yolo.registerSource("misc", { claim: "yes" })),
    plugin("bad-language", (yolo) => yolo.registerTranslator("words2", { translate: async ({ lines }) => lines })),
    plugin("off", () => events.push("off ran"), { enabled: false }),
  ], { logger: quiet, startTimeoutMs: 20 });
  await host.start();
  assert.deepEqual(host.status().map((entry) => entry.error ?? entry.status), [
    "started", "started", "started", "missing API key", "start failed: port in use", "start failed: The start handler did not finish within 0s", "started",
    'Source id "pages" is already registered', 'Source id "Pages" must be lowercase letters, digits and dashes, starting with a letter',
    "Source misc: claim must be a function", 'Translator words2: language must be a language tag, such as "zh-Hans"', "disabled",
  ]);
  // A plugin that failed to start took its transcriber with it.
  assert.deepEqual([host.speech.transcriber()?.id, host.speech.translator()?.id], ["ears", "words"]);
  assert.deepEqual(host.status().find((entry) => entry.name === "speech"), { name: "speech", version: null, source: "./speech", status: "started", sources: [], transcribers: ["ears"], translators: ["words"] });
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

test("every plugin in the official catalog loads and starts with an empty environment", async () => {
  const official = readOfficialList({ root: ROOT });
  const config = loadPluginConfig({ root: ROOT, env: { YOLO_CONFIG: OFFICIAL_CONFIG } });
  // A speech plugin cannot start without its server's address.
  const optionsFor = (dir) => (readManifest(dir).kinds.includes("speech") ? { url: "http://127.0.0.1:9/v1" } : {});
  const catalog = resolvePlugins(official.catalog.map((dir) => ({ source: dir, enabled: true, options: optionsFor(dir) })), ROOT);
  const host = await loadPlugins([...catalog, ...config.plugins], { env: {}, logger: quiet });
  await host.start();
  for (const entry of host.status()) assert.equal(entry.status, "started", `${entry.name}: ${entry.error}`);
  assert.equal(typeof (await host.sources.claim("https://example.com/watch?v=1")).plugin, "string");
  // An agent loads even where its CLI is missing, and says whether it can answer.
  assert.equal(typeof (await host.agents.status()).available, "boolean");
  await host.shutdown();
});

// Plugins turned on and off from a screen (Agent Note 2026-10-31-home-cold-start).
test("a changed config applies in place: on loads and starts, off drains its streams, options reload, claim order is config order", async () => {
  const events = [];
  const links = plugin("links", (yolo) => yolo.registerSource("links", { claim: (url) => ({ id: url }) }));
  const site = (options = {}) => plugin("site", (yolo) => {
    yolo.registerSource("site", { claim: (url) => (url.includes("site.test") ? { id: `${yolo.options.mode ?? "plain"}` } : undefined) });
    yolo.on("start", () => events.push(`site start ${yolo.options.mode ?? "plain"}`));
    yolo.on("shutdown", () => events.push(`site shutdown ${yolo.options.mode ?? "plain"}`));
  }, { options });
  let playing = true;
  const host = await loadPlugins([links], { logger: quiet, serving: (ids) => playing && ids.includes("site"), drainCheckMs: 5 });
  await host.start();
  assert.equal((await host.sources.claim("https://site.test/a")).plugin, "links");

  // Turned on, before link playback: it claims its URLs first.
  await host.apply([site(), links]);
  assert.deepEqual(events, ["site start plain"]);
  assert.equal((await host.sources.claim("https://site.test/a")).plugin, "site");
  assert.deepEqual(host.status().map(({ name, status }) => [name, status]), [["site", "started"], ["links", "started"]]);

  // New options: the factory runs again; the old instance drains.
  await host.apply([site({ mode: "fast" }), links]);
  assert.equal((await host.sources.claim("https://site.test/a")).id, "fast");
  assert.deepEqual(events, ["site start plain", "site start fast"]);

  // Off: no new claims at once, its shutdown once its streams end.
  await host.apply([links]);
  assert.equal((await host.sources.claim("https://site.test/a")).plugin, "links");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(!events.includes("site shutdown fast"), "a stream still plays");
  playing = false;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(events.slice(2).sort(), ["site shutdown fast", "site shutdown plain"]);
  await host.shutdown();
});
