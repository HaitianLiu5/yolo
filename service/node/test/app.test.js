import assert from "node:assert/strict";
import { test } from "node:test";
import { NODE_PROTOCOL, PROTOCOL_HEADER, signNodeRequest } from "@useyolo/core";
import { createNodeApp, NODE_VERSION } from "../src/app.js";
import { loadPlugins } from "../src/plugins.js";

const secret = "node-test-secret";

// /internal/v1 (Agent Note 2026-10-08-workers-vpc-node-access): only signed
// requests, from a control plane of this protocol or the one before.
test("the internal API takes only signed requests of a protocol it speaks", async () => {
  const plugins = await loadPlugins([{ name: "fixture", enabled: true, options: {}, factory: (yolo) => yolo.registerSource("web", { claim: (url) => ({ id: url }) }) }]);
  await plugins.start();
  const app = createNodeApp({ secret, plugins });
  const path = "/internal/v1/health";
  const request = async ({ key = secret, protocol = NODE_PROTOCOL } = {}) => {
    const headers = await signNodeRequest(key, { method: "GET", path });
    if (protocol !== undefined) headers[PROTOCOL_HEADER] = String(protocol);
    const response = await app.request(path, { headers });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await app.request(path)).status, 401);
  assert.equal((await request({ key: "wrong" })).status, 401);
  const health = await request();
  assert.equal(health.status, 200);
  assert.deepEqual([health.body.version, health.body.protocol], [NODE_VERSION, NODE_PROTOCOL]);
  assert.deepEqual(health.body.sources, [{ id: "web", plugin: "fixture" }]);
  assert.equal((await request({ protocol: NODE_PROTOCOL - 1 })).status, 200);
  const ahead = await request({ protocol: NODE_PROTOCOL + 1 });
  assert.deepEqual([ahead.status, ahead.body.error.code, ahead.body.error.retryable], [503, "node_offline", false]);
  assert.match(ahead.body.error.message, /Upgrade the media node/);
  if (NODE_PROTOCOL >= 2) assert.match((await request({ protocol: NODE_PROTOCOL - 2 })).body.error.message, /Deploy the control plane/);
});
