import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatePluginModule } from "../../scripts/generate-plugins.js";
import { loadControlPlugins } from "../../src/plugins.js";

// Plugins' control entries (Agent Note 2026-10-11-plugin-architecture,
// Agent Note 2026-10-14-dns-provider-plugins). The served tool is in mcp.test.js.

const QUEUE_TOOL = fileURLToPath(new URL("../fixtures/queue-tool/", import.meta.url));
const logger = { debug() {}, info() {}, warn() {}, error() {} };

// The build step's static import module for `plugins`, in a temporary repository root.
async function bundle(t, plugins) {
  const root = mkdtempSync(join(tmpdir(), "yolo-control-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "yolo.config.json"), JSON.stringify({ plugins }));
  const outFile = join(root, "plugins.generated.js");
  generatePluginModule({ root, env: {}, outFile });
  return (await import(pathToFileURL(outFile).href)).default;
}

test("the build bundles the enabled control entries with their options, and fails on a plugin it cannot find", async (t) => {
  const entries = await bundle(t, [{ source: QUEUE_TOOL, options: { greeting: "Hi" } }, { source: QUEUE_TOOL, enabled: false }]);
  assert.deepEqual(entries.map(({ name, version, options }) => ({ name, version, options })), [{ name: "@fixture/queue-tool", version: "1.0.0", options: { greeting: "Hi" } }]);
  await assert.rejects(bundle(t, ["./not-there"]), /Cannot bundle the plugins[\s\S]*not-there/);
});

test("a plugin that fails, clashes with Yolo's tools, or registers a bad tool is reported, keeps nothing it registered, and the others load", async () => {
  const tool = (yolo, fields = {}) => ({ name: "ok_tool", title: "T", description: "D", scope: "read", input: yolo.z.object({}), run: () => 1, ...fields });
  const plugin = (name, factory) => ({ name, factory });
  const { tools, plugins } = await loadControlPlugins([
    plugin("broken", (yolo) => { yolo.registerTool(tool(yolo, { name: "half_done" })); throw new Error("missing API key"); }),
    plugin("clashing", (yolo) => yolo.registerTool(tool(yolo, { name: "play" }))),
    plugin("bad-name", (yolo) => yolo.registerTool(tool(yolo, { name: "Bad-Name" }))),
    plugin("bad-scope", (yolo) => yolo.registerTool(tool(yolo, { scope: "admin" }))),
    plugin("bad-input", (yolo) => yolo.registerTool(tool(yolo, { input: { who: "string" } }))),
    plugin("good", (yolo) => yolo.registerTool(tool(yolo))),
  ], { logger });
  assert.deepEqual(tools.map((entry) => entry.name), ["ok_tool"]);
  const errors = plugins.map(({ status, error }) => `${status}: ${error ?? ""}`);
  [/failed: missing API key/, /failed: Tool play already exists/, /lower_snake_case/, /scope must be one of read, control, manage/, /input must be a schema/, /^loaded/]
    .forEach((pattern, index) => assert.match(errors[index], pattern));
});

test("a DNS provider registers with a secret of its own, never one of Yolo's or a binding, and goes with a plugin that fails", async () => {
  const create = () => ({});
  const register = async (...calls) => (await loadControlPlugins(calls.map((call, index) => ({
    name: `p${index}`, factory: (yolo) => { yolo.registerDnsProvider(...call); if (call[2]) throw new Error("missing option"); },
  })), { logger })).plugins.map((entry) => entry.error ?? null);
  const loaded = await loadControlPlugins([{ name: "@fixture/dns", factory: (yolo) => yolo.registerDnsProvider("example-dns", { title: "Example", secret: "EXAMPLE_DNS_TOKEN", create }) }], { logger });
  assert.deepEqual(loaded.dnsProviders.map(({ id, plugin, secret }) => [id, plugin, secret]), [["example-dns", "@fixture/dns", "EXAMPLE_DNS_TOKEN"]]);
  assert.deepEqual(await register(["broken-dns", { secret: "BROKEN_DNS_TOKEN", create }, "throws"]), ["missing option"]);
  const refused = [
    ["Bad DNS", "OK_DNS_TOKEN", /lowercase/], ["cloudflare", "CLOUDFLARE_TOKEN", /built in/], ["ok-dns", "OTHER_DNS_TOKEN", /must start with OK_DNS_/],
    ["ok-dns", "lower_case", /UPPER_SNAKE_CASE/], ["node", "NODE_SECRET", /Yolo's own/], ["media", "MEDIA_DNS_TOKEN", /Yolo's own/],
    ["lan", "LAN_DNS_TOKEN", /Yolo's own/], ["oauth", "OAUTH_KV", /binding|Yolo's own/], ["db", "DB", /binding|Yolo's own/],
  ];
  for (const [id, secret, pattern] of refused) assert.match((await register([id, { secret, create }]))[0] ?? "", pattern, `${id} ${secret}`);
  assert.match((await register(["ok-dns", { secret: "OK_DNS_TOKEN" }]))[0], /create/);
  assert.deepEqual((await register(["a", { secret: "A_B_TOKEN", create }], ["a-b", { secret: "A_B_TOKEN", create }]))[1],
    "DNS provider a-b: A_B_TOKEN is already the secret of the DNS provider a");
});
