import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { handleMcpRequest } from "../../src/mcp/handler.js";
import { TOOLS } from "../../src/mcp/tools.js";
import { INSTRUCTIONS } from "../../src/mcp/server.js";
import { createTestControlPlane, USER } from "../helpers/setup.js";

const ALL_SCOPES = ["read", "control", "manage"];

async function connect(services, scopes = ALL_SCOPES) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    // Workers always set Host; Node's fetch Request does not, so add it.
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", "localhost");
      return handleMcpRequest(new Request(url, { ...init, headers }), { services, scopes });
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

// The tool table from Agent Note 2026-10-07-remote-mcp-server.
const EXPECTED = {
  get_status: "readOnly", list_devices: "readOnly", rename_device: "write", remove_device: "destructive", search: "readOnly", browse: "readOnly",
  play: "write", control: "write", seek: "write", transfer: "write",
  list_tracks: "readOnly", set_tracks: "write",
  queue_list: "readOnly", queue_add: "write", queue_remove: "destructive", queue_clear: "destructive",
  playlist_list: "readOnly", playlist_get: "readOnly",
  playlist_create: "write", playlist_add: "write", playlist_import: "write", playlist_enqueue: "write",
  playlist_delete: "destructive", history: "readOnly",
};

test("tool list and annotations match the v1 protocol", async () => {
  const client = await connect(createTestControlPlane().services);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(EXPECTED).sort());
  for (const tool of tools) {
    const kind = tool.annotations.readOnlyHint ? "readOnly" : tool.annotations.destructiveHint ? "destructive" : "write";
    assert.equal(kind, EXPECTED[tool.name], tool.name);
  }
  assert.equal(TOOLS.length, Object.keys(EXPECTED).length);
  await client.close();
});

test("server description explains Yolo, search-first, and the default device", async () => {
  const client = await connect(createTestControlPlane().services);
  const instructions = client.getInstructions();
  assert.equal(instructions, INSTRUCTIONS);
  assert.match(instructions, /media service/);
  assert.match(instructions, /YOLO mode/);
  assert.match(instructions, /Search before you play/);
  assert.match(instructions, /active device by default/);
  assert.equal(client.getServerVersion().name, "yolo");
  await client.close();
});

test("tools call through to the services", async () => {
  const plane = createTestControlPlane();
  const client = await connect(plane.services);
  const search = parse(await client.callTool({ name: "search", arguments: { query: "Alien" } }));
  assert.equal(search.results[0].id, "library:42");
  const played = parse(await client.callTool({ name: "play", arguments: { item_id: "library:42" } }));
  assert.equal(played.device.name, "Drive-In");
  const status = parse(await client.callTool({ name: "get_status", arguments: {} }));
  assert.equal(status.playback.item.title, "Movie 42");
  assert.equal(status.node.online, true);
  await client.callTool({ name: "queue_add", arguments: { url: "https://example.com/v" } });
  assert.equal(parse(await client.callTool({ name: "queue_list", arguments: {} })).length, 1);
  assert.equal(parse(await client.callTool({ name: "queue_clear", arguments: {} })).cleared, 1);
  const history = parse(await client.callTool({ name: "history", arguments: { limit: 5 } }));
  assert.equal(history[0].sourceKey, "library:42");
  await client.close();
});

test("node_offline is reported as a tool error, and queue tools still work", async () => {
  const plane = createTestControlPlane();
  plane.node.offline = true;
  const client = await connect(plane.services);
  const played = await client.callTool({ name: "play", arguments: { url: "https://example.com/v" } });
  assert.equal(played.isError, true);
  assert.equal(parse(played).error.code, "node_offline");
  const browse = await client.callTool({ name: "browse", arguments: {} });
  assert.equal(browse.isError, true);
  assert.equal(parse(browse).error.code, "node_offline");
  const added = await client.callTool({ name: "queue_add", arguments: { url: "https://example.com/v" } });
  assert.equal(added.isError, undefined);
  await client.close();
});

test("tools refuse calls the token's scopes do not allow", async () => {
  const client = await connect(createTestControlPlane().services, ["read"]);
  const denied = await client.callTool({ name: "queue_clear", arguments: {} });
  assert.equal(denied.isError, true);
  assert.equal(parse(denied).error.code, "forbidden");
  const allowed = await client.callTool({ name: "queue_list", arguments: {} });
  assert.equal(allowed.isError, undefined);
  await client.close();
});

test("invalid arguments are rejected by the input schema", async () => {
  const client = await connect(createTestControlPlane().services);
  const result = await client.callTool({ name: "control", arguments: { action: "rewind" } });
  assert.equal(result.isError, true);
  await client.close();
});

test("rename_device sets the owner's name and type for a device", async () => {
  const plane = createTestControlPlane();
  plane.db.raw.prepare("INSERT INTO devices (id, user_id, name, kind, capabilities, created_at) VALUES ('dev_car', ?, 'Browser', 'browser', '{}', 0)").run(USER);
  const client = await connect(plane.services);
  const renamed = parse(await client.callTool({ name: "rename_device", arguments: { device: "browser", name: "Model Y", kind: "car" } }));
  assert.deepEqual([renamed.id, renamed.name, renamed.kind], ["dev_car", "Model Y", "car"]);
  const typed = parse(await client.callTool({ name: "rename_device", arguments: { device: "dev_car", kind: "other" } }));
  assert.deepEqual([typed.name, typed.kind], ["Model Y", "other"]);
  const bad = await client.callTool({ name: "rename_device", arguments: { device: "dev_car", kind: "toaster" } });
  assert.equal(bad.isError, true);
  const missing = await client.callTool({ name: "rename_device", arguments: { device: "nope", name: "x" } });
  assert.equal(JSON.parse(missing.content[0].text).error.code, "not_found");
  await client.close();
});
