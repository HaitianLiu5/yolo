import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { handleMcpRequest } from "../../src/mcp/handler.js";
import { loadControlPlugins } from "../../src/plugins.js";
import queueTool from "../fixtures/queue-tool/control.js";
import { createTestControlPlane } from "../helpers/fakes.js";

// The MCP server's contract with agents (Agent Note 2026-10-07-remote-mcp-server); what tools do is proven in test/e2e.

async function connect(services, { scopes = ["read", "control", "manage"], tools } = {}) {
  // Workers always set Host; Node's fetch does not.
  const fetch = (url, init) => handleMcpRequest(new Request(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), host: "localhost" } }), { services, scopes, tools });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), { fetch }));
  return client;
}

const error = (result) => (result.isError ? JSON.parse(result.content[0].text).error.code : null);

test("every tool says whether it is read-only or destructive, a plugin's tool is served beside Yolo's, the token's scopes bound every call, and a node that is down is an error the agent reads", async () => {
  const { tools } = await loadControlPlugins([{ name: "@fixture/queue-tool", version: "1.0.0", options: { greeting: "Hi" }, factory: queueTool }]);
  const plane = createTestControlPlane();
  await plane.services.addToQueue({ itemId: "library:1" });
  const client = await connect(plane.services, { tools });
  const listed = (await client.listTools()).tools;
  assert.ok(listed.length > 30 && listed.some((tool) => tool.name === "queue_greeting"));
  for (const { name, annotations } of listed) {
    // MCP clients treat a missing destructiveHint as destructive.
    const kind = annotations.readOnlyHint ? "read" : annotations.destructiveHint === true ? "destructive" : annotations.destructiveHint === false ? "write" : "unannotated";
    assert.equal(kind === "destructive", /remove|clear|delete/.test(name), name);
    assert.notEqual(kind, "unannotated", name);
  }
  const greeting = await client.callTool({ name: "queue_greeting", arguments: { who: "Claude" } });
  assert.deepEqual(JSON.parse(greeting.content[0].text), { greeting: "Hi, Claude", queued: 1 });
  plane.node.offline = true;
  assert.equal(error(await client.callTool({ name: "play", arguments: { url: "https://example.com/v" } })), "node_offline");
  assert.equal(error(await client.callTool({ name: "queue_add", arguments: { url: "https://example.com/v" } })), null, "the queue works with the node down");
  await client.close();

  const reader = await connect(plane.services, { scopes: ["read"], tools });
  assert.equal(error(await reader.callTool({ name: "queue_clear", arguments: {} })), "forbidden");
  assert.equal(error(await reader.callTool({ name: "queue_list", arguments: {} })), null);
  await reader.close();
  const manager = await connect(plane.services, { scopes: ["manage"], tools });
  assert.equal(error(await manager.callTool({ name: "queue_greeting", arguments: {} })), "forbidden", "a plugin's tool keeps its scope");
  await manager.close();
});
