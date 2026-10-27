import assert from "node:assert/strict";
import { test } from "node:test";
import { YoloError } from "@useyolo/core";
import { createV1App } from "../../src/api/v1.js";
import { upsertDevice } from "../../src/store/devices.js";
import { recordPlay, recordProgress } from "../../src/store/history.js";
import { createTestControlPlane, onlineScreen, USER } from "../helpers/fakes.js";

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
  const choices = [{ id: "helper", title: "Helper", available: true }, { id: "other", title: "Other", available: false, reason: "Not connected" }];
  plane.node.routes["GET /internal/v1/agent"] = () => ({ available: true, id: "helper", title: "Helper", agents: choices });
  const app = createV1App({
    getContext: () => ({ services: plane.services, scopes: ["read", "control"], userId: USER, deviceId: car.id }),
    issueRealtimeTicket: async () => ({}),
  });
  const ask = (body) => app.request("/v1/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // The agent a screen that chooses none asks, and every one it may choose.
  assert.deepEqual(await (await app.request("/v1/agent")).json(), { available: true, id: "helper", title: "Helper", agents: choices });
  const response = await ask({ text: " play friends ", language: "zh-CN" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /x-ndjson/);
  assert.equal(await response.text(), stream);
  const call = plane.node.calls.find(({ method, path }) => method === "POST" && path === "/internal/v1/agent");
  assert.deepEqual(call.body, { text: "play friends", device: { id: car.id, name: "Model Y" }, playing: null, language: "zh-CN" });
  // The screen's choice goes with the words; a name no plugin could have does not.
  await ask({ text: "play news", agent: "other" });
  await ask({ text: "play news", agent: "Not An Id" });
  assert.deepEqual(plane.node.calls.filter(({ method, path }) => method === "POST" && path === "/internal/v1/agent").slice(1).map(({ body }) => body.agent), ["other", undefined]);

  // What plays now goes with the words, read from the Hub, not the screen,
  // so "this" needs no explanation, even when it plays on another screen.
  const tv = await upsertDevice(plane.db, USER, { name: "Living room", kind: "tv", capabilities: {} });
  await plane.hub.setState({
    status: "paused", deviceId: tv.id, item: { source: { plugin: "library", id: "42" }, title: "Friends", duration: 1320 },
    position: 754.04, positionAt: 0, tracks: { subtitles: [], audio: null }, sessionId: "s-1",
  });
  await ask({ text: "who is this" });
  assert.deepEqual(plane.node.calls.at(-1).body.playing, {
    itemId: "library:42", title: "Friends", position: 754, duration: 1320, status: "paused", device: { id: tv.id, name: "Living room" },
  });

  assert.equal((await ask({ text: "" })).status, 400);

  // A node from before agents is told to upgrade.
  plane.node.routes["GET /internal/v1/agent"] = () => {
    throw new YoloError("not_found", "No such endpoint");
  };
  assert.deepEqual(await (await app.request("/v1/agent")).json(), { available: false, reason: "Upgrade the media node to use an agent from a screen" });
});

test("a screen's recording goes to the node's transcriber as base64 and its words come back", async () => {
  const plane = createTestControlPlane();
  const car = await upsertDevice(plane.db, USER, { name: "Model Y", kind: "car", capabilities: {} });
  plane.node.routes["GET /internal/v1/agent"] = () => ({ available: true, id: "helper", title: "Helper", speech: true });
  plane.node.routes["POST /internal/v1/speech/transcribe"] = () => ({ text: "播放老友记", language: "zh" });
  const app = createV1App({
    getContext: () => ({ services: plane.services, scopes: ["read", "control"], userId: USER, deviceId: car.id }),
    issueRealtimeTicket: async () => ({}),
  });
  const send = (body, type = "audio/wav", query = "?language=zh-CN") => app.request(`/v1/agent/transcriptions${query}`, { method: "POST", headers: { "content-type": type }, body });

  assert.deepEqual(await (await app.request("/v1/agent")).json(), { available: true, id: "helper", title: "Helper", speech: true });
  const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
  const response = await send(audio);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "播放老友记", language: "zh" });
  const call = plane.node.calls.find(({ path }) => path === "/internal/v1/speech/transcribe");
  assert.deepEqual(call.body, { audio: Buffer.from(audio).toString("base64"), language: "zh-CN", device: car.id });

  assert.equal((await send(audio, "application/json")).status, 400);
  assert.equal((await send(new Uint8Array(1_000_001))).status, 400);
  assert.equal((await send(new Uint8Array(0))).status, 400);

  // A node from before voice input is told to upgrade.
  plane.node.routes["POST /internal/v1/speech/transcribe"] = () => {
    throw new YoloError("not_found", "No such endpoint");
  };
  const old = await send(audio);
  assert.equal(old.status, 404);
  assert.equal((await old.json()).error.message, "Upgrade the media node to ask by voice");
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
  const ask = async (id, text, agent) => {
    const response = await app.request(`/v1/agent/conversations/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, agent }) });
    assert.match(response.headers.get("content-type"), /x-ndjson/);
    return (await response.text()).trim().split("\n").map((text) => JSON.parse(text));
  };
  const asked = () => plane.node.calls.filter(({ path }) => path === "/internal/v1/agent").map(({ body }) => body.session);

  const [started, ...rest] = await ask("new", "play friends");
  assert.equal(started.type, "conversation");
  assert.equal(started.title, "play friends");
  assert.deepEqual(rest.map(({ type }) => type), ["tool", "done"]);
  await ask(started.id, "the next one");
  // A new conversation starts a new session; a follow-up continues its own,
  // with the agent that answered it.
  assert.deepEqual(asked(), [null, "s-1"]);
  assert.equal(plane.node.calls.at(-1).body.agent, "helper");

  const shown = await (await app.request(`/v1/agent/conversations/${started.id}`)).json();
  assert.equal(shown.agentId, "helper");
  assert.equal(shown.agentSession, undefined);
  assert.deepEqual(shown.messages.map(({ role, text, steps, status }) => ({ role, text, steps, status })), [
    { role: "user", text: "play friends", steps: undefined, status: undefined },
    { role: "agent", text: "Playing play friends.", steps: ["search"], status: "done" },
    { role: "user", text: "the next one", steps: undefined, status: undefined },
    { role: "agent", text: "Playing the next one.", steps: ["search"], status: "done" },
  ]);

  // Choosing another agent starts its own session in the same conversation,
  // which then goes on with it.
  answer = (body) => line({ type: "done", text: "Done.", agent: body.agent, session: `${body.agent}-1` });
  await ask(started.id, "use the other", "other");
  await ask(started.id, "and the next");
  const agentCalls = () => plane.node.calls.filter(({ path }) => path === "/internal/v1/agent").slice(-2).map(({ body }) => [body.agent, body.session]);
  assert.deepEqual(agentCalls(), [["other", null], ["other", "other-1"]]);

  // An answer that fails, or a node that is off, is kept as an error.
  answer = () => line({ type: "error", error: { code: "internal", message: "Overloaded" } });
  await ask(started.id, "again");
  plane.node.offline = true;
  const offline = await ask(started.id, "and again");
  assert.deepEqual(offline.map(({ type }) => type), ["conversation", "error"]);
  const messages = (await (await app.request(`/v1/agent/conversations/${started.id}`)).json()).messages;
  assert.deepEqual(messages.slice(-3).map(({ text, status }) => [text, status]), [["Overloaded", "error"], ["and again", undefined], [offline[1].error.message, "error"]]);

  // A node that goes away mid-answer is kept as an error too.
  plane.node.offline = false;
  answer = () => {
    let pulls = 0;
    return new ReadableStream({
      pull(controller) {
        // A whole line, then half of one.
        if ((pulls += 1) === 1) controller.enqueue(new TextEncoder().encode(`${line({ type: "tool", name: "search" })}{"type":"te`));
        else controller.error(new Error("tunnel closed"));
      },
    });
  };
  const cut = await app.request(`/v1/agent/conversations/${started.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "once more" }) });
  // The half line stays a line of its own, and the error follows it whole.
  assert.equal(JSON.parse((await cut.text()).trim().split("\n").at(-1)).error.code, "node_offline");
  const last = (await (await app.request(`/v1/agent/conversations/${started.id}`)).json()).messages.at(-1);
  assert.deepEqual([last.status, last.steps], ["error", ["search"]]);
  // So does one cut inside a character, which leaves no text pending.
  answer = () => {
    let pulls = 0;
    return new ReadableStream({
      pull(controller) {
        if ((pulls += 1) === 1) controller.enqueue(new Uint8Array([...new TextEncoder().encode(line({ type: "tool", name: "search" })), 0xc3]));
        else controller.error(new Error("tunnel closed"));
      },
    });
  };
  const split = await app.request(`/v1/agent/conversations/${started.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "and once more" }) });
  assert.equal(JSON.parse((await split.text()).trim().split("\n").at(-1)).error.code, "node_offline");

  const { conversations } = await (await app.request("/v1/agent/conversations")).json();
  assert.deepEqual(conversations.map(({ id }) => id), [started.id]);
  assert.equal((await app.request(`/v1/agent/conversations/${started.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await app.request(`/v1/agent/conversations/${started.id}`)).status, 404);
  assert.equal(plane.db.raw.prepare("SELECT COUNT(*) AS n FROM agent_messages").get().n, 0);
  assert.equal((await app.request("/v1/agent/conversations/nope/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) })).status, 404);
});

// Library listings carry what the owner played in Yolo (Agent Note
// 2026-10-11-yolo-owns-progress-and-resume), which the source does not know:
// a position, a watched mark, and a show's count of watched episodes.
test("library listings carry Yolo's progress and its count of a show's watched episodes", async () => {
  const plane = createTestControlPlane();
  const car = await onlineScreen(plane);
  const app = createV1App({ getContext: () => ({ services: plane.services, scopes: ["read", "control"], userId: USER }) });
  const get = async (path) => (await app.request(path)).json();
  const loads = [];
  const send = plane.transport.send;
  plane.transport.send = (deviceId, message) => (message.type === "load" && loads.push(message), send(deviceId, message));
  // The source knows nothing was watched; its episodes name their show and season.
  const parents = ["library:show", "library:s1"];
  const show = { id: "library:show", kind: "show", title: "Show", episodes: 3, watchedEpisodes: 0, watched: false };
  const episode = (id, fields = {}) => ({ id: `library:${id}`, kind: "episode", title: id, duration: 600, resumeAt: null, watched: false, parents, ...fields });
  plane.node.routes["GET /internal/v1/library/*/items"] = () => ({
    total: 2, offset: 0, items: [show, { id: "library:film", kind: "movie", title: "Film", duration: 600, resumeAt: 100, watched: false }],
  });
  plane.node.routes["GET /internal/v1/library/items/*/children"] = () => ({ parent: show, items: [episode("e1"), episode("e2"), episode("e3", { resumeAt: 50 })] });
  const prepare = plane.node.routes["POST /internal/v1/prepare"];
  plane.node.routes["POST /internal/v1/prepare"] = (body) => ({ ...prepare(body), parents });
  const watch = async (id, position) => {
    await plane.hub.play({ source: { plugin: "library", id } });
    await plane.hub.deviceMessage(car.id, { type: "report", sessionId: (await plane.hub.state()).sessionId, status: "paused", position });
  };

  await watch("e1", 590);
  await watch("e2", 200);
  assert.ok(loads.length === 2 && loads.every((load) => !("parents" in load.stream)), "the show and season stay inside Yolo");
  // The previous release recorded e3 without its show.
  await recordPlay(plane.db, USER, { source: { plugin: "library", id: "e3" }, title: "e3", duration: 600 });
  await recordProgress(plane.db, USER, "library:e3", { position: 600, duration: 600 });

  let page = await get("/v1/library/library:tv/items");
  assert.deepEqual(page.items.map(({ id, watchedEpisodes, resumeAt, watched }) => [id, watchedEpisodes ?? resumeAt, watched]), [
    ["library:show", 1, false],
    ["library:film", 100, false],
  ]);
  const children = await get("/v1/library/items/library:show/children");
  assert.deepEqual(children.items.map(({ id, resumeAt, watched, parents: named }) => [id, resumeAt, watched, named]), [
    ["library:e1", null, true, undefined],
    ["library:e2", 200, false, undefined],
    ["library:e3", null, true, undefined],
  ]);
  // Listing e3 named its show and season, so they count it now.
  page = await get("/v1/library/library:tv/items");
  assert.equal(page.items[0].watchedEpisodes, 2);
  await watch("e2", 600);
  assert.deepEqual((await get("/v1/library/items/library:show/children")).parent, { ...show, watchedEpisodes: 3, watched: true });
});
