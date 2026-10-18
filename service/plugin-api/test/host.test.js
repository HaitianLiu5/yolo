import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPluginConfig, OFFICIAL_CONFIG, pluginConfigPath, readPluginConfig } from "../src/host.js";

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
