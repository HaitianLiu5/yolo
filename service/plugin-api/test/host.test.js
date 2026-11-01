import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changePluginConfig, loadPluginConfig, OFFICIAL_CONFIG, pluginConfigPath, readManifest, readOfficialList, readPluginConfig } from "../src/host.js";

function writePackage(dir, manifest, files = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

const writeConfig = (root, plugins, name = "yolo.config.json") => {
  writeFileSync(join(root, name), typeof plugins === "string" ? plugins : JSON.stringify({ plugins }));
  return join(root, name);
};

test("the config is YOLO_CONFIG, else yolo.config.json, else the official list; entries resolve in order and fail one by one", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yolo-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(pluginConfigPath({ root, env: {} }), { path: join(root, OFFICIAL_CONFIG), explicit: false });
  assert.deepEqual(pluginConfigPath({ root, env: { YOLO_CONFIG: "other.json" } }), { path: join(root, "other.json"), explicit: true });

  writePackage(join(root, "local"), { name: "local-plugin", version: "1.0.0", yolo: { node: "./node.js", control: "./control.js" } }, { "node.js": "", "control.js": "" });
  writePackage(join(root, "node_modules", "@acme", "remote"), { name: "@acme/remote", yolo: { node: "./main.js" } }, { "main.js": "" });
  writePackage(join(root, "plain"), { name: "plain" });
  writePackage(join(root, "missing-entry"), { name: "missing-entry", yolo: { node: "./nope.js" } });
  writeConfig(root, [{ source: "@acme/remote", options: { a: 1 } }, "./local", { source: "./x", enabled: false }, "./plain", "./missing-entry", "not-installed", "./local"]);
  const config = loadPluginConfig({ root, env: {} });
  assert.equal(config.explicit, true);
  const [remote, local, disabled, ...broken] = config.plugins;
  assert.deepEqual([remote.name, remote.node, remote.control, remote.options, remote.error], ["@acme/remote", join(root, "node_modules/@acme/remote/main.js"), null, { a: 1 }, null]);
  assert.deepEqual([local.version, local.node, local.control], ["1.0.0", join(root, "local/node.js"), join(root, "local/control.js")]);
  assert.deepEqual([disabled.enabled, disabled.node, disabled.error], [false, null, null]);
  const patterns = [/no "yolo" field/, /nope\.js does not exist/, /not-installed is not installed/, /listed twice/];
  broken.forEach((plugin, index) => assert.match(plugin.error, patterns[index]));

  assert.throws(() => readPluginConfig(writeConfig(root, "{ nope", "bad.json")), /Cannot read the plugin config/);
  assert.throws(() => readPluginConfig(writeConfig(root, [{ source: "./x", options: [] }], "c.json")), /options must be an object/);
  assert.throws(() => readPluginConfig(writeConfig(root, [{ enabled: true }], "d.json")), /source must be/);
});

test("a manifest reads its screen fields without importing code, dropping what is malformed", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yolo-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writePackage(join(root, "p"), {
    name: "@acme/source-thing",
    version: "1.2.0",
    description: "Things",
    yolo: {
      node: "./node.js",
      title: { en: "Thing", zh: "东西", "bad tag": "x" },
      kinds: ["source", "nope"],
      place: { id: "thing", group: "files", languages: ["zh", "?"] },
      connect: "fields",
      options: [{ key: "token", type: "string", secret: true, env: "THING_TOKEN" }, { key: "bad key", type: "string" }, { key: "x", type: "nope" }],
      reload: "restart",
    },
  });
  const manifest = readManifest(join(root, "p"));
  assert.deepEqual(manifest.title, { en: "Thing", zh: "东西" });
  assert.deepEqual(manifest.summary, { en: "Things" });
  assert.deepEqual(manifest.kinds, ["source"]);
  assert.deepEqual(manifest.place, { id: "thing", icon: "thing", group: "files", languages: ["zh"] });
  assert.deepEqual(manifest.options, [{ key: "token", type: "string", title: { en: "token" }, secret: true, env: "THING_TOKEN" }]);
  assert.equal(manifest.reload, "restart");
  assert.equal(readManifest(join(root, "missing")), null);
  // A plugin turned off is still named, for screens to list.
  writeConfig(root, [{ source: "./p", enabled: false }]);
  assert.equal(loadPluginConfig({ root, env: {} }).plugins[0].name, "@acme/source-thing");
});

test("the official list loads built-in link playback, and its catalog and places name installed plugins", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const official = readOfficialList({ root });
  assert.deepEqual(official.plugins.map((entry) => entry.builtIn), [true], "link playback alone, built in");
  for (const dir of [...official.catalog, ...Object.values(official.with).flat()]) {
    const manifest = readManifest(dir);
    assert.ok(manifest?.title?.en && manifest.summary?.en && manifest.privacy?.en, `${dir} describes itself for screens`);
    assert.ok(manifest.title.zh, `${dir} has a Chinese title`);
  }
});

test("a change writes the owner's config: one entry, others as they were, a new one before the first built-in source", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yolo-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plugins"));
  for (const name of ["links", "library", "agent"]) writePackage(join(root, "plugins", name), { name, yolo: { node: "./node.js" } }, { "node.js": "" });
  writeFileSync(join(root, OFFICIAL_CONFIG), JSON.stringify({ plugins: [{ source: "./links", builtIn: true }], catalog: ["./library", "./agent"] }));

  // On the defaults, the first change makes yolo.config.json from the official list.
  const first = changePluginConfig({ root, env: {}, dir: join(root, "plugins", "library"), change: { enabled: true } });
  assert.equal(first.path, join(root, "yolo.config.json"));
  assert.deepEqual(JSON.parse(readFileSync(first.path, "utf8")).plugins, [{ source: "./plugins/library" }, { source: "./plugins/links", builtIn: true }]);

  // An owner's file keeps its other fields, its string entries, and its order.
  writeFileSync(first.path, JSON.stringify({ plugins: ["./plugins/library", { source: "./plugins/links", builtIn: true }], egress: { rules: [{ hosts: ["a.test"], proxy: "p" }] } }));
  const { digest } = changePluginConfig({ root, env: {}, dir: join(root, "plugins", "agent"), change: { enabled: true, options: { model: "m" } } });
  changePluginConfig({ root, env: {}, dir: join(root, "plugins", "library"), change: { enabled: false }, expected: digest });
  const written = JSON.parse(readFileSync(first.path, "utf8"));
  assert.deepEqual(written.plugins, [{ source: "./plugins/library", enabled: false }, { source: "./plugins/agent", options: { model: "m" } }, { source: "./plugins/links", builtIn: true }]);
  assert.deepEqual(written.egress, { rules: [{ hosts: ["a.test"], proxy: "p" }] });

  // A new entry goes by the catalog's order among the entries before link playback.
  const order = ["library", "agent", "names"].map((name) => join(root, "plugins", name));
  mkdirSync(join(root, "plugins", "names"));
  writeFileSync(join(root, "plugins", "names", "package.json"), JSON.stringify({ name: "names", yolo: { node: "./node.js" } }));
  writeFileSync(first.path, JSON.stringify({ plugins: [{ source: "./plugins/agent" }, { source: "./plugins/links", builtIn: true }] }));
  changePluginConfig({ root, env: {}, dir: join(root, "plugins", "library"), change: { enabled: true }, order });
  changePluginConfig({ root, env: {}, dir: join(root, "plugins", "names"), change: { enabled: true }, order });
  assert.deepEqual(JSON.parse(readFileSync(first.path, "utf8")).plugins.map((entry) => entry.source), ["./plugins/library", "./plugins/agent", "./plugins/names", "./plugins/links"]);

  // An edit by hand since the writer read the file is never overwritten.
  assert.throws(() => changePluginConfig({ root, env: {}, dir: join(root, "plugins", "library"), change: { enabled: true }, expected: digest }), (error) => error.code === "conflict");
});
