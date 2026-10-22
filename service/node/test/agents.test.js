import assert from "node:assert/strict";
import { test } from "node:test";
import { signNodeRequest, YoloError } from "@useyolo/core";
import { createNodeApp } from "../src/app.js";
import { loadPlugins } from "../src/plugins.js";

const secret = "node-test-secret";

async function nodeWith(factories) {
  const plugins = await loadPlugins(factories.map((factory, index) => ({ name: `agent-${index}`, enabled: true, options: {}, factory })));
  await plugins.start();
  return { plugins, app: createNodeApp({ secret, plugins }) };
}

async function call(app, method, path, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = await signNodeRequest(secret, { method, path, body: payload });
  return app.request(path, { method, headers: { ...headers, "content-type": "application/json" }, body: payload || undefined });
}

const lines = async (response) => (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

test("a screen's request streams the agent's steps and its answer", async () => {
  const asked = [];
  const { app } = await nodeWith([(yolo) => yolo.registerAgent("helper", {
    title: "Helper",
    async ask(request, { emit }) {
      asked.push(request);
      emit({ type: "tool", name: "search" });
      emit({ type: "text", text: "Found it." });
      return { text: "Playing Friends." };
    },
  })]);

  assert.deepEqual(await (await call(app, "GET", "/internal/v1/agent")).json(), { available: true, id: "helper", title: "Helper" });
  const response = await call(app, "POST", "/internal/v1/agent", { text: " play friends ", device: { id: "d1", name: "Car" }, language: "en" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
  assert.deepEqual(await lines(response), [
    { type: "tool", name: "search" },
    { type: "text", text: "Found it." },
    { type: "done", text: "Playing Friends.", agent: "helper" },
  ]);
  assert.deepEqual(asked, [{ text: "play friends", device: { id: "d1", name: "Car" }, playing: null, language: "en" }]);

  // What plays now reaches the agent; a live stream has no duration, and
  // whatever is not what plays is dropped.
  const playing = { itemId: "library:42", title: "Friends", position: 754, duration: null, status: "playing", device: { id: "d2", name: "TV" } };
  await (await call(app, "POST", "/internal/v1/agent", { text: "who is this", device: { id: "d1", name: "Car" }, playing: { ...playing, extra: "x" } })).text();
  assert.deepEqual(asked[1].playing, playing);
  await (await call(app, "POST", "/internal/v1/agent", { text: "who is this", playing: { title: "no item" } })).text();
  assert.equal(asked[2].playing, null);
});

test("a request in a conversation passes its session and gets the agent's back", async () => {
  const asked = [];
  const { app } = await nodeWith([(yolo) => yolo.registerAgent("helper", {
    async ask(request) {
      asked.push(request.session);
      return { text: "Playing it.", session: request.session ?? "s-new" };
    },
  })]);
  const done = async (body) => (await lines(await call(app, "POST", "/internal/v1/agent", body))).at(-1);
  assert.deepEqual(await done({ text: "play", session: null }), { type: "done", text: "Playing it.", agent: "helper", session: "s-new" });
  assert.deepEqual(await done({ text: "next", session: "s-new" }), { type: "done", text: "Playing it.", agent: "helper", session: "s-new" });
  // Without the key, from an older control plane, the plugin keeps its own.
  await done({ text: "next" });
  assert.deepEqual(asked, [null, "s-new", undefined]);
});

test("an agent's failure ends the stream with its error", async () => {
  const { app } = await nodeWith([(yolo) => yolo.registerAgent("helper", {
    async ask() {
      throw new YoloError("resolve_failed", "Not connected");
    },
  })]);
  const events = await lines(await call(app, "POST", "/internal/v1/agent", { text: "play" }));
  assert.deepEqual(events, [{ type: "error", error: { code: "resolve_failed", message: "Not connected", retryable: true } }]);
});

test("without an agent, or without words, a request is refused before it streams", async () => {
  const { app } = await nodeWith([]);
  assert.deepEqual(await (await call(app, "GET", "/internal/v1/agent")).json(), { available: false, reason: "No agent plugin is loaded on this media node" });
  assert.equal((await call(app, "POST", "/internal/v1/agent", { text: "play" })).status, 404);
  const { app: withAgent } = await nodeWith([(yolo) => yolo.registerAgent("helper", { ask: async () => ({ text: "" }) })]);
  assert.equal((await call(withAgent, "POST", "/internal/v1/agent", { text: "  " })).status, 400);
  assert.equal((await call(withAgent, "POST", "/internal/v1/agent", { text: "x".repeat(1001) })).status, 400);
});

test("a new request stops the one still running, and starts once it has stopped", async () => {
  const order = [];
  const { plugins } = await nodeWith([(yolo) => yolo.registerAgent("helper", {
    ask: (request, { signal }) => new Promise((resolve, reject) => {
      order.push(`start ${request.text}`);
      if (request.text !== "first") return resolve({ text: `${request.text} done` });
      // An agent that takes a while to stop, as a CLI does.
      signal.addEventListener("abort", () => setTimeout(() => {
        order.push("first stopped");
        reject(signal.reason);
      }, 20));
    }),
  })]);
  const first = plugins.agents.ask({ text: "first" });
  const second = plugins.agents.ask({ text: "second" });
  const third = plugins.agents.ask({ text: "third" });
  await assert.rejects(first, { code: "superseded" });
  await assert.rejects(second, { code: "superseded" });
  assert.deepEqual(await third, { text: "third done", agent: "helper", session: null });
  assert.deepEqual(order, ["start first", "first stopped", "start third"]);
});

test("a plugin whose start fails takes its agent with it", async () => {
  const { plugins } = await nodeWith([(yolo) => {
    yolo.registerAgent("helper", { ask: async () => ({ text: "" }) });
    yolo.on("start", () => {
      throw new Error("no CLI");
    });
  }]);
  assert.deepEqual(plugins.agents.ids(), []);
  assert.equal((await plugins.agents.status()).available, false);
});

test("agents are checked when they register", async () => {
  const { plugins } = await nodeWith([(yolo) => yolo.registerAgent("Bad Id", { ask: async () => ({}) })]);
  assert.match(plugins.status()[0].error, /lowercase letters/);
});
