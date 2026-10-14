import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { YoloError } from "@useyolo/core";
import { handleMcpRequest } from "../../src/mcp/handler.js";
import { createTestControlPlane, onlineScreen, USER } from "../helpers/setup.js";

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
  list_tracks: "readOnly", set_tracks: "write", get_comments: "readOnly", set_danmaku: "write",
  queue_list: "readOnly", queue_add: "write", queue_remove: "destructive", queue_clear: "destructive",
  playlist_list: "readOnly", playlist_get: "readOnly",
  playlist_create: "write", playlist_add: "write", playlist_import: "write", playlist_enqueue: "write",
  playlist_delete: "destructive", history: "readOnly",
  get_item: "readOnly", get_transcript: "readOnly", search_transcript: "readOnly", get_chapters: "readOnly", skip: "write",
  get_playback_health: "readOnly", get_frame: "readOnly", get_storyboard: "readOnly",
};

test("tool list and annotations match the v1 protocol", async () => {
  const client = await connect(createTestControlPlane().services);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(EXPECTED).sort());
  for (const tool of tools) {
    // A write tool says explicitly that it is not destructive: MCP clients
    // treat a missing destructiveHint as destructive.
    const { readOnlyHint, destructiveHint } = tool.annotations;
    const kind = readOnlyHint ? "readOnly" : destructiveHint === true ? "destructive" : destructiveHint === false ? "write" : "unannotated";
    assert.equal(kind, EXPECTED[tool.name], tool.name);
  }
  await client.close();
});

test("server description explains Yolo, search-first, and the default device", async () => {
  const client = await connect(createTestControlPlane().services);
  const instructions = client.getInstructions();
  assert.match(instructions, /media service/);
  assert.match(instructions, /YOLO mode/);
  assert.match(instructions, /Search before you play/);
  assert.match(instructions, /active device by default/);
  assert.equal(client.getServerVersion().name, "yolo");
  await client.close();
});

test("tools call through to the services", async () => {
  const plane = createTestControlPlane();
  await onlineScreen(plane);
  const client = await connect(plane.services);
  const search = parse(await client.callTool({ name: "search", arguments: { query: "Alien" } }));
  assert.equal(search.results[0].id, "library:42");
  const played = parse(await client.callTool({ name: "play", arguments: { item_id: "library:42" } }));
  assert.equal(played.device.name, "Car");
  const status = parse(await client.callTool({ name: "get_status", arguments: {} }));
  assert.equal(status.playback.item.title, "Movie 42");
  assert.equal(status.node.online, true);
  await client.callTool({ name: "queue_add", arguments: { url: "https://example.com/v" } });
  assert.equal(parse(await client.callTool({ name: "queue_list", arguments: {} })).length, 1);
  assert.equal(parse(await client.callTool({ name: "queue_clear", arguments: {} })).cleared, 1);
  const history = parse(await client.callTool({ name: "history", arguments: { limit: 5 } }));
  assert.equal(history[0].sourceKey, "library:42");
  // A frame is an image content block and a line of facts.
  plane.node.routes["POST /internal/v1/frame"] = (body) => ({
    image: "/9j/", mimeType: "image/jpeg", width: 1280, height: 720, time: body.time, title: "Movie 42", duration: 600, input: "file", plugin: "library",
  });
  const frame = await client.callTool({ name: "get_frame", arguments: { time: "1:00" } });
  assert.deepEqual(frame.content[0], { type: "image", data: "/9j/", mimeType: "image/jpeg" });
  assert.match(frame.content[1].text, /"Movie 42" at 1:00\.000 \(60 s of 10:00\)/);
  plane.node.routes["POST /internal/v1/storyboard"] = (body) => ({
    image: "/9j/", mimeType: "image/jpeg", width: 1290, height: 548, title: "Movie 42", duration: 600, from: 0, to: 600, step: 300, count: 2,
    columns: 2, rows: 1, tileWidth: 320, tileHeight: 180, times: [150, 450], missing: [450], origin: "frames", input: "file", plugin: "library", asked: body,
  });
  const board = await client.callTool({ name: "get_storyboard", arguments: { count: 2 } });
  assert.equal(board.content[0].type, "image");
  assert.match(board.content[1].text, /Times, left to right and top to bottom: 2:30, 7:30 \(no picture\)\./);
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
  assert.equal(parse(await client.callTool({ name: "get_status", arguments: {} })).node.online, false);
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

test("rename_device sets the owner's name and type for a device", async () => {
  const plane = createTestControlPlane();
  plane.db.raw.prepare("INSERT INTO devices (id, user_id, name, kind, capabilities, created_at) VALUES ('dev_car', ?, 'Browser', 'browser', '{}', 0)").run(USER);
  const client = await connect(plane.services);
  const renamed = parse(await client.callTool({ name: "rename_device", arguments: { device: "browser", name: "Model Y", kind: "car" } }));
  assert.deepEqual([renamed.id, renamed.name, renamed.kind], ["dev_car", "Model Y", "car"]);
  const typed = parse(await client.callTool({ name: "rename_device", arguments: { device: "dev_car", kind: "other" } }));
  assert.deepEqual([typed.name, typed.kind], ["Model Y", "other"]);
  const missing = await client.callTool({ name: "rename_device", arguments: { device: "nope", name: "x" } });
  assert.equal(JSON.parse(missing.content[0].text).error.code, "not_found");
  await client.close();
});

test("set_danmaku passes a screen's settings on, and get_comments summarizes the comments around the position", async () => {
  const plane = createTestControlPlane();
  const car = await onlineScreen(plane);
  const client = await connect(plane.services);
  const set = parse(await client.callTool({ name: "set_danmaku", arguments: { enabled: false, opacity: 0.33, area: "half", font_size: "large" } }));
  assert.deepEqual(set, { device: { id: car.id, name: "Car" }, settings: { enabled: false, area: "half", fontSize: "large", opacity: 0.35 } });
  assert.deepEqual(plane.transport.sent.at(-1).message.settings, set.settings);
  assert.equal(plane.transport.sent.at(-1).message.type, "danmaku");
  const empty = await client.callTool({ name: "set_danmaku", arguments: {} });
  assert.equal(parse(empty).error.code, "invalid_request");

  // Nothing plays: an item is needed.
  assert.equal(parse(await client.callTool({ name: "get_comments", arguments: {} })).error.code, "invalid_request");
  await client.callTool({ name: "play", arguments: { item_id: "library:42", start_at: 100 } });
  plane.node.routes["GET /internal/v1/comments"] = (query) => ({
    available: true,
    complete: true,
    start: Number(query.start),
    end: Number(query.end),
    comments: [
      { t: 86, text: "early", mode: "scroll", color: "#ffffff", size: 1 },
      { t: 99, text: "Ha", mode: "scroll", color: "#ffffff", size: 1 },
      { t: 101, text: "ha", mode: "top", color: "#ff0000", size: 1 },
      { t: 104, text: "nice shot", mode: "scroll", color: "#ffffff", size: 1 },
    ],
  });
  const said = parse(await client.callTool({ name: "get_comments", arguments: { limit: 2 } }));
  assert.equal(JSON.parse(plane.node.calls.at(-1).query.source).id, "42");
  assert.deepEqual([plane.node.calls.at(-1).query.start, plane.node.calls.at(-1).query.end], [85, 115]);
  assert.deepEqual(said, {
    item: { id: "library:42", title: "Movie 42" }, at: 100, from: 85, to: 115, available: true,
    total: 4, distinct: 3, comments: [{ t: 99, text: "Ha", n: 2 }, { t: 104, text: "nice shot" }],
  });
  plane.node.routes["GET /internal/v1/comments"] = () => ({ available: false, supported: false, start: 0, end: 30, complete: true, comments: [] });
  const none = parse(await client.callTool({ name: "get_comments", arguments: { at: 5 } }));
  assert.deepEqual([none.available, none.note], [false, "This item's source offers no timed comments"]);
  // A node from before comments says so, as for frames and storyboards.
  plane.node.routes["GET /internal/v1/comments"] = () => {
    throw new YoloError("not_found", "No such endpoint");
  };
  await assert.rejects(plane.services.comments({ at: 5 }), { code: "not_found", message: /without timed comments; upgrade it/ });
  await client.close();
});
