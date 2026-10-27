import assert from "node:assert/strict";
import { test } from "node:test";
import proxyUrlPlugin, { endpointFrom, PROVIDER_ID } from "../src/node.js";

test("a proxy URL from the named variable becomes an endpoint, its credentials apart from the address", () => {
  const env = { EGRESS_PROXY_URL: "http://us%40er:p%3Ass@proxy.example:8080/ignored" };
  assert.deepEqual(endpointFrom({ env: "EGRESS_PROXY_URL" }, env), { url: "http://proxy.example:8080", username: "us@er", password: "p:ss" });
  assert.deepEqual(endpointFrom({ env: "EGRESS_PROXY_URL" }, { EGRESS_PROXY_URL: "https://proxy.example" }), { url: "https://proxy.example" });
});

test("a missing, unset, or non-http proxy variable is an error that names the variable but not its value", () => {
  assert.throws(() => endpointFrom({}, {}), /needs options\.env/);
  assert.throws(() => endpointFrom({ env: "EGRESS_PROXY_URL" }, {}), /EGRESS_PROXY_URL is not set/);
  assert.throws(() => endpointFrom({ env: "EGRESS_PROXY_URL" }, { EGRESS_PROXY_URL: "socks5://u:secret@proxy.example:1080" }), (error) => /must be an http/.test(error.message) && !error.message.includes("secret"));
});

test("the plugin registers the url provider, which reads the node's environment", async () => {
  const registered = new Map();
  proxyUrlPlugin({ env: { HOME_PROXY: "http://proxy.example:3128" }, registerProxyProvider: (id, impl) => registered.set(id, impl) });
  assert.deepEqual([...registered.keys()], [PROVIDER_ID]);
  assert.deepEqual(await registered.get(PROVIDER_ID).endpoint({ env: "HOME_PROXY" }, { refused: false }), { url: "http://proxy.example:3128" });
});
