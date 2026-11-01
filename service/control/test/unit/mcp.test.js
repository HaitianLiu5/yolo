import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { handleMcpRequest } from "../../src/mcp/handler.js";
import { loadControlPlugins } from "../../src/plugins.js";
import queueTool from "../fixtures/queue-tool/control.js";
import { createTestControlPlane, onlineScreen } from "../helpers/fakes.js";

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
  await onlineScreen(plane);
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

test("queue_add with count queues the item and the ones after it in its run, naming parts the listing leaves unnamed", async () => {
  const plane = createTestControlPlane();
  const part = (id, title) => ({ source: { plugin: "library", id }, title, thumbnail: null, duration: 1200 });
  plane.node.routes["GET /internal/v1/sequence"] = () => ({ sequence: { title: "Parts", items: [part("1", "Part 1"), part("2", null), part("3", "Part 3"), part("4", "Part 4")] } });
  await onlineScreen(plane);
  const client = await connect(plane.services);
  const result = JSON.parse((await client.callTool({ name: "queue_add", arguments: { item_id: "library:1", count: 3 } })).content[0].text);
  assert.deepEqual(result.items.map((item) => item.title), ["Movie 1", "Movie 2", "Part 3"]);
  assert.equal(result.queue.length, 3);

  // A source without runs queues the one item, and says so.
  delete plane.node.routes["GET /internal/v1/sequence"];
  const lone = JSON.parse((await client.callTool({ name: "queue_add", arguments: { item_id: "library:7", count: 5 } })).content[0].text);
  assert.equal(lone.items.length, 1);
  await client.close();
});
