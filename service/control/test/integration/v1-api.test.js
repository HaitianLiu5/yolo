import assert from "node:assert/strict";
import { test } from "node:test";
import { YoloError } from "@useyolo/core";
import { createV1App } from "../../src/api/v1.js";
import { upsertDevice } from "../../src/store/devices.js";
import { createTestControlPlane, USER } from "../helpers/fakes.js";

// The queue and playlist routes the player's home screen calls, over the
// real service layer and D1 schema, with a fake node.
test("queue and playlist endpoints round-trip", async () => {
  const plane = createTestControlPlane();
  const app = createV1App({ getContext: () => ({ services: plane.services, scopes: ["read", "control", "manage"], userId: USER }) });
  const request = async (method, path, body) => {
    const response = await app.request(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };

  const added = await request("POST", "/v1/queue", { itemId: "library:1" });
  assert.deepEqual([added.status, added.body.item.title], [201, "Movie 1"]);
  await request("POST", "/v1/queue", { itemId: "library:2", position: "next" });
  const queue = await request("GET", "/v1/queue");
  assert.deepEqual(queue.body.map((item) => item.title), ["Movie 2", "Movie 1"]);
  const reordered = await request("POST", "/v1/queue/reorder", { ids: [queue.body[1].id] });
  assert.equal(reordered.body[0].title, "Movie 1");
  assert.equal((await request("DELETE", `/v1/queue/${queue.body[0].id}`)).status, 200);

  const playlist = await request("POST", "/v1/playlists", { name: "Trip" });
  assert.equal(playlist.status, 201);
  await request("POST", `/v1/playlists/${playlist.body.id}/items`, { itemId: "library:2" });
  assert.equal((await request("PATCH", `/v1/playlists/${playlist.body.id}`, { name: "Road trip" })).body.name, "Road trip");
  assert.equal((await request("POST", `/v1/playlists/${playlist.body.id}/enqueue`, { position: "end" })).body.added, 1);
  assert.equal((await request("DELETE", `/v1/playlists/${playlist.body.id}`)).status, 200);
  assert.equal((await request("GET", `/v1/playlists/${playlist.body.id}`)).status, 404);
  assert.equal((await request("DELETE", "/v1/queue")).status, 200);
});

test("a screen's words go to the node's agent with that screen, and its stream comes back", async () => {
  const plane = createTestControlPlane();
  const car = await upsertDevice(plane.db, USER, { name: "Model Y", kind: "car", capabilities: {} });
  const stream = `${JSON.stringify({ type: "tool", name: "search" })}\n${JSON.stringify({ type: "done", text: "Playing Friends." })}\n`;
  plane.node.routes["POST /internal/v1/agent"] = () => ({ body: stream });
  plane.node.routes["GET /internal/v1/agent"] = () => ({ available: true, id: "helper", title: "Helper" });
  const app = createV1App({
    getContext: () => ({ services: plane.services, scopes: ["read", "control"], userId: USER, deviceId: car.id }),
    issueRealtimeTicket: async () => ({}),
  });
  const ask = (body) => app.request("/v1/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  assert.deepEqual(await (await app.request("/v1/agent")).json(), { available: true, title: "Helper" });
  const response = await ask({ text: " play friends ", language: "zh-CN" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /x-ndjson/);
  assert.equal(await response.text(), stream);
  const call = plane.node.calls.find(({ method, path }) => method === "POST" && path === "/internal/v1/agent");
  assert.deepEqual(call.body, { text: "play friends", device: { id: car.id, name: "Model Y" }, language: "zh-CN" });

  assert.equal((await ask({ text: "" })).status, 400);

  // A node from before agents is told to upgrade.
  plane.node.routes["GET /internal/v1/agent"] = () => {
    throw new YoloError("not_found", "No such endpoint");
  };
  assert.deepEqual(await (await app.request("/v1/agent")).json(), { available: false, reason: "Upgrade the media node to use an agent from a screen" });
});

test("a conversation keeps each question and answer, and continues the agent's session", async () => {
  const plane = createTestControlPlane();
  const car = await upsertDevice(plane.db, USER, { name: "Model Y", kind: "car", capabilities: {} });
  const line = (event) => `${JSON.stringify(event)}\n`;
  let answer = (body) => line({ type: "tool", name: "search" }) + line({ type: "done", text: `Playing ${body.text}.`, agent: "helper", session: "s-1" });
  plane.node.routes["POST /internal/v1/agent"] = (body) => ({ body: answer(body) });
  const app = createV1App({
    getContext: () => ({ services: plane.services, scopes: ["read", "control"], userId: USER, deviceId: car.id }),
    issueRealtimeTicket: async () => ({}),
  });
  const ask = async (id, text) => {
    const response = await app.request(`/v1/agent/conversations/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    assert.match(response.headers.get("content-type"), /x-ndjson/);
    return (await response.text()).trim().split("\n").map((text) => JSON.parse(text));
  };
  const asked = () => plane.node.calls.filter(({ path }) => path === "/internal/v1/agent").map(({ body }) => body.session);

  const [started, ...rest] = await ask("new", "play friends");
  assert.equal(started.type, "conversation");
  assert.equal(started.title, "play friends");
  assert.deepEqual(rest.map(({ type }) => type), ["tool", "done"]);
  await ask(started.id, "the next one");
  // A new conversation starts a new session; a follow-up continues its own.
  assert.deepEqual(asked(), [null, "s-1"]);

  const shown = await (await app.request(`/v1/agent/conversations/${started.id}`)).json();
  assert.equal(shown.agentId, "helper");
  assert.equal(shown.agentSession, undefined);
  assert.deepEqual(shown.messages.map(({ role, text, steps, status }) => ({ role, text, steps, status })), [
    { role: "user", text: "play friends", steps: undefined, status: undefined },
    { role: "agent", text: "Playing play friends.", steps: ["search"], status: "done" },
    { role: "user", text: "the next one", steps: undefined, status: undefined },
    { role: "agent", text: "Playing the next one.", steps: ["search"], status: "done" },
  ]);

  // An answer that fails, or a node that is off, is kept as an error.
  answer = () => line({ type: "error", error: { code: "internal", message: "Overloaded" } });
  await ask(started.id, "again");
  plane.node.offline = true;
  const offline = await ask(started.id, "and again");
  assert.deepEqual(offline.map(({ type }) => type), ["conversation", "error"]);
  const messages = (await (await app.request(`/v1/agent/conversations/${started.id}`)).json()).messages;
  assert.deepEqual(messages.slice(-3).map(({ text, status }) => [text, status]), [["Overloaded", "error"], ["and again", undefined], [offline[1].error.message, "error"]]);

  const { conversations } = await (await app.request("/v1/agent/conversations")).json();
  assert.deepEqual(conversations.map(({ id }) => id), [started.id]);
  assert.equal((await app.request(`/v1/agent/conversations/${started.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await app.request(`/v1/agent/conversations/${started.id}`)).status, 404);
  assert.equal(plane.db.raw.prepare("SELECT COUNT(*) AS n FROM agent_messages").get().n, 0);
  assert.equal((await app.request("/v1/agent/conversations/nope/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) })).status, 404);
});
