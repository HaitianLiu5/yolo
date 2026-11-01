import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { YoloError } from "@useyolo/core";
import { loadPluginConfig } from "@useyolo/plugin-api/host";
import { createPluginManager, withSecretOptions } from "../src/plugin-manager.js";
import { loadPlugins } from "../src/plugins.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

// A checkout with its own official list: built-in links, a place with a
// metadata plugin it brings along, and a plugin that needs a restart.
function checkout(t) {
  const root = mkdtempSync(join(tmpdir(), "yolo-manager-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const add = (name, yolo, code) => {
    mkdirSync(join(root, "plugins", name), { recursive: true });
    writeFileSync(join(root, "plugins", name, "package.json"), JSON.stringify({ name, type: "module", yolo: { node: "./node.js", ...yolo } }));
    writeFileSync(join(root, "plugins", name, "node.js"), code);
  };
  add("links", { title: "Web links" }, `export default (yolo) => yolo.registerSource("links", { claim: (url) => ({ id: url }) });`);
  add("library", {
    title: "Library", place: { id: "library", group: "files" }, connect: "fields",
    options: [{ key: "url", type: "url", title: "Address" }, { key: "token", type: "string", secret: true, title: "Token" }],
  }, `export default (yolo) => yolo.registerSource("library", { claim: (url) => (url.includes("library.test") ? { id: String(yolo.options.token) } : undefined) });`);
  add("names", { title: "Names" }, "export default () => {};");
  add("proxy", { title: "Proxy", reload: "restart" }, "export default () => {};");
  writeFileSync(join(root, "plugins", "official.json"), JSON.stringify({
    plugins: [{ source: "./links", builtIn: true }],
    catalog: ["./library", "./names", "./proxy"],
    with: { library: ["./names"] },
  }));
  return root;
}

async function start(root, { restart = () => true } = {}) {
  const env = {};
  const config = loadPluginConfig({ root, env });
  const plugins = await loadPlugins(withSecretOptions(config.plugins, root), { env, logger: quiet });
  await plugins.start();
  return { plugins, manager: createPluginManager({ root, env, runtimeDir: root, plugins, config, restart, logger: quiet }) };
}

test("a place turns on its plugins and what it brings along, in place, with secret options kept apart", async (t) => {
  const root = checkout(t);
  const { plugins, manager } = await start(root);
  const before = manager.catalog();
  assert.deepEqual(before.places.map(({ id, state, plugins: names, with: along }) => [id, state, names, along]), [["library", "off", ["library"], ["names"]]]);
  assert.deepEqual(before.plugins.map(({ name, state, builtIn }) => [name, state, builtIn]), [["links", "on", true], ["library", "off", false], ["names", "off", false], ["proxy", "off", false]]);

  await manager.setPlace("library", { without: [] });
  assert.deepEqual(plugins.status().map(({ name, status }) => [name, status]), [["library", "started"], ["names", "started"], ["links", "started"]]);
  assert.equal((await plugins.sources.claim("https://library.test/x")).plugin, "library");

  const { plugin } = await manager.change("library", { options: { url: "http://10.0.0.2:32400", token: "s3cret" } });
  assert.deepEqual(plugin.options.map(({ key, value, set }) => [key, value ?? set]), [["url", "http://10.0.0.2:32400"], ["token", true]]);
  const config = readFileSync(join(root, "yolo.config.json"), "utf8");
  assert.ok(!config.includes("s3cret"), "a secret never goes into the config");
  const secrets = join(root, ".yolo", "plugin-options", "library.json");
  assert.equal(statSync(secrets).mode & 0o777, 0o600);
  assert.equal((await plugins.sources.claim("https://library.test/x")).id, "s3cret");

  // Off: the place's own plugins; what it brought along may serve others.
  await manager.setPlace("library", { enabled: false });
  assert.equal(manager.catalog().plugins.find(({ name }) => name === "names").state, "on");
  await assert.rejects(manager.change("library", { options: { url: "ftp://x" } }), (error) => error instanceof YoloError && /http or https/.test(error.message));
  await plugins.shutdown();
});

test("built-in link playback has no switch, and a plugin that needs a restart waits for one", async (t) => {
  const root = checkout(t);
  let asked = 0;
  const { plugins, manager } = await start(root, { restart: () => ++asked > 0 });
  await assert.rejects(manager.change("links", { enabled: false }), /built in and has no switch/);
  const answer = await manager.change("proxy", { enabled: true });
  assert.deepEqual(answer.restart, { plugins: ["proxy"], automatic: true });
  assert.equal(answer.plugin.state, "restart");
  assert.equal(asked, 1);
  assert.ok(!plugins.status().some(({ name }) => name === "proxy"), "it does not load in place");
  // The next node start loads it from the config.
  assert.match(readFileSync(join(root, "yolo.config.json"), "utf8"), /"\.\/plugins\/proxy"/);
  await plugins.shutdown();
});
