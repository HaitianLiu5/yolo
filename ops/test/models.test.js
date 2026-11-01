import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { run } from "../commands/models.js";
import { ROOT, paths } from "../lib/paths.js";

// `models status` and `logout` (Agent Note 2026-10-25-models-for-plugins):
// the model provider plugin is found through the plugin config, and its
// sources are read the way the node reads them. Nothing reaches a model.

const root = mkdtempSync(join(tmpdir(), "yolo-models-ops-"));
after(() => rmSync(root, { recursive: true, force: true }));
const plugin = join(ROOT, "plugins/model-subscriptions");

function instance(name, entry) {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "yolo.config.json"), JSON.stringify({ plugins: [entry] }));
  writeFileSync(join(dir, ".env"), "");
  return paths({ root: dir, env: {} });
}

test("with every source off, status says plugins go without a model and how to give them one", async () => {
  const result = await run({ positionals: ["status"], p: instance("off", { source: plugin, options: { sources: [] } }) });
  assert.equal(result.status, "ok");
  assert.match(result.summary, /No model/);
  assert.match(result.next[0], /models login/);
});

test("a custom server counts as a source that answers", async () => {
  const result = await run({ positionals: ["status"], p: instance("custom", { source: plugin, options: { sources: ["custom"], custom: { url: "http://127.0.0.1:1/v1", model: "small" } } }) });
  assert.match(result.summary, /have a model through @useyolo\/model-subscriptions/);
  assert.deepEqual(result.steps.map(({ id, status }) => [id, status]), [["source.custom", "ok"]]);
});

test("without a model provider plugin in the config, the commands say how to add one", async () => {
  const p = instance("none", { source: join(ROOT, "plugins/source-example") });
  for (const action of ["status", "logout"]) {
    const result = await run({ positionals: [action, "openai"], p });
    assert.equal(result.status, "failed");
    assert.match(result.summary, /model-subscriptions/);
  }
});
