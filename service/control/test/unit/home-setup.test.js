import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createAuthApp } from "../../src/auth/app.js";
import { handleMcpRequest } from "../../src/mcp/handler.js";
import { createFakeNode, createMemoryKv, createTestControlPlane } from "../helpers/fakes.js";

// The home's cold start and agents' plugin requests
// (Agent Note 2026-10-31-home-cold-start): what screens read, what an agent
// may change at once, and what waits for the owner's passkey.

const ORIGIN = "https://yolo.example";

// A node's catalog: a place with a plugin it brings along, and what changed.
function pluginNode() {
  const changes = [];
  const plugin = (name, enabled = false) => ({ name, title: { en: name }, summary: { en: `${name} adds` }, privacy: { en: `${name} sends` }, enabled, state: enabled ? "on" : "off", options: [], hosts: [] });
  const node = createFakeNode({
    "GET /internal/v1/plugins": () => ({
      config: { path: "/x/yolo.config.json", writable: true },
      plugins: [plugin("links", true), plugin("library"), plugin("names")],
      places: [{ id: "library", title: { en: "Library" }, group: "files", plugins: ["library"], with: ["names"], state: "off" }],
      restart: null,
    }),
    "PATCH /internal/v1/plugins/*": (body) => {
      changes.push(["plugin", body]);
      return { plugin: {}, restart: null };
    },
    "PUT /internal/v1/plugins/places/*": (body) => {
      changes.push(["place", body]);
      return { place: { id: "library", state: body.enabled ? "on" : "off" }, plugins: [], restart: null };
    },
  });
  return { node, changes };
}

test("a new home asks once per owner: any screen skips it or shows it again, and an offline node says so", async () => {
  const { node } = pluginNode();
  const plane = createTestControlPlane({ node });
  const first = await plane.services.setup();
  assert.equal(first.state, "new");
  assert.deepEqual(first.places.map(({ id, plugins, with: along }) => [id, plugins.map((p) => p.name), along.map((p) => [p.name, p.privacy.en])]), [["library", ["library"], [["names", "names sends"]]]]);
  await plane.services.setSetup("skipped");
  assert.equal((await plane.services.setup()).state, "skipped");
  await assert.rejects(plane.services.setSetup("maybe"), /new, done, or skipped/);
  node.offline = true;
  assert.deepEqual(await plane.services.setup().then(({ state, available, places }) => ({ state, available, places })), { state: "skipped", available: false, places: [] });
  await plane.services.setSetup("new");
  assert.equal((await plane.services.setup()).state, "new");
});

test("an agent turns a plugin off at once, but turning one on waits for the owner's passkey, once", async () => {
  const { node, changes } = pluginNode();
  const plane = createTestControlPlane({ node });

  const off = await plane.services.requestPluginChange({ plugin: "names", enabled: false });
  assert.equal(off.applied, true);
  assert.deepEqual(changes, [["plugin", { enabled: false }]]);
  assert.ok(plane.logs.some((record) => record.kind === "security" && record.event === "plugin_off"));

  const on = await plane.services.requestPluginChange({ place: "library", enabled: true });
  assert.equal(on.applied, false);
  assert.match(on.request.code, /^[B-Z]{6}$/);
  assert.equal(changes.length, 1, "nothing applied before the owner allows it");
  assert.deepEqual((await plane.services.pluginRequests()).requests.map(({ id, place, status }) => [id, place, status]), [[on.request.id, "library", "pending"]]);
  await assert.rejects(plane.services.requestPluginChange({ plugin: "nope", enabled: true }), /No plugin named nope/);

  await plane.services.decidePluginRequest(on.request.id, { allow: true });
  assert.deepEqual(changes.at(-1), ["place", { enabled: true, without: [] }]);
  await assert.rejects(plane.services.decidePluginRequest(on.request.id, { allow: true }), /allowed/);
  assert.deepEqual((await plane.services.pluginRequests()).requests, []);
});

test("change_plugin over MCP answers with the link and code, and list_plugins shows the request waiting", async () => {
  const { node } = pluginNode();
  const plane = createTestControlPlane({ node });
  const fetch = (url, init) => handleMcpRequest(new Request(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), host: "localhost" } }), { services: plane.services, scopes: ["read", "manage"] });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), { fetch }));
  const asked = JSON.parse((await client.callTool({ name: "change_plugin", arguments: { plugin: "library", enabled: true } })).content[0].text);
  assert.equal(asked.applied, false);
  assert.match(asked.instructions, new RegExp(asked.request.code));
  const listed = JSON.parse((await client.callTool({ name: "list_plugins", arguments: {} })).content[0].text);
  assert.deepEqual(listed.requests.map(({ plugin }) => plugin), ["library"]);
  await client.close();
});

test("the approval page says what would run and who asked; Allow needs a passkey, Deny only the link", async () => {
  const { node, changes } = pluginNode();
  const plane = createTestControlPlane({ node });
  const { request } = await plane.services.requestPluginChange({ plugin: "library", enabled: true });
  const app = createAuthApp({ servicesFor: () => plane.services });
  const env = { PUBLIC_ORIGIN: ORIGIN, DB: plane.db, OAUTH_KV: createMemoryKv() };
  const page = await (await app.request(`${ORIGIN}/approve/${request.id}`, {}, env)).text();
  assert.match(page, /asks to turn on library/);
  assert.match(page, /full access to that computer/);
  assert.match(page, /library sends/);

  const post = (body) => app.request(`${ORIGIN}/auth/approvals/${request.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
  assert.notEqual((await post({ allow: true, response: {} })).status, 200, "no assertion, no change");
  assert.equal(changes.length, 0);
  assert.equal((await post({ allow: false })).status, 200);
  assert.equal((await app.request(`${ORIGIN}/approve/${request.id}`, {}, env)).status, 410);
  assert.equal((await plane.services.pluginRequest(request.id)).status, "denied");
});
