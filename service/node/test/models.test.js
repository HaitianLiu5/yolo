import assert from "node:assert/strict";
import { test } from "node:test";
import { signNodeRequest } from "@useyolo/core";
import { createNodeApp } from "../src/app.js";
import { schemaError } from "../src/models.js";
import { loadPlugins } from "../src/plugins.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const IDENTITY = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "season"],
  properties: { kind: { enum: ["episode", "movie", "other"] }, season: { type: ["integer", "null"], minimum: 0 } },
};

// A provider and a plugin that calls it, loaded in that order.
async function host({ complete, status, env = {}, logger = quiet } = {}) {
  let models;
  const plugins = await loadPlugins([
    { name: "provider", enabled: true, options: {}, factory: (yolo) => yolo.registerModelProvider("subs", { complete, ...(status ? { status } : {}) }) },
    { name: "caller", enabled: true, options: {}, factory: (yolo) => { models = yolo.models; } },
  ], { env, logger });
  await plugins.start();
  return { plugins, models };
}

const ask = (models, extra = {}) => models.complete({ purpose: "identify", messages: [{ role: "user", content: "Nathan For You S01E08" }], ...extra });

test("a plugin's request reaches the provider and comes back parsed against its schema", async () => {
  const seen = [];
  const logged = [];
  const { models, plugins } = await host({
    complete: async (request) => {
      seen.push(request);
      return { text: "```json\n{\"kind\":\"episode\",\"season\":1}\n```", model: "small", source: "borrowed", usage: { input: 133, output: 41 } };
    },
    logger: { ...quiet, info: (line) => logged.push(line) },
  });

  const answer = await ask(models, { system: "Identify it.", schema: IDENTITY, maxTokens: 400 });
  assert.deepEqual(answer.json, { kind: "episode", season: 1 });
  assert.deepEqual([answer.model, answer.source, answer.usage], ["small", "borrowed", { input: 133, output: 41 }]);
  assert.equal(seen[0].purpose, "identify");
  assert.equal(seen[0].system, "Identify it.");
  assert.equal(seen[0].maxTokens, 400);
  assert.ok(seen[0].signal instanceof AbortSignal);
  // The log says who asked what for, never what was asked.
  assert.equal(logged.length, 1);
  assert.match(logged[0], /caller identify: subs\/borrowed small, 133\+41 tokens/);
  assert.doesNotMatch(logged[0], /Nathan/);
  assert.equal(await models.available(), true);
  assert.deepEqual(plugins.status().find((entry) => entry.name === "provider").modelProviders, ["subs"]);
});

test("an answer that does not fit the schema, or is not JSON, fails as resolve_failed", async () => {
  const replies = ["{\"kind\":\"trailer\",\"season\":1}", "not json"];
  const { models } = await host({ complete: async () => ({ text: replies.shift() }) });
  await assert.rejects(ask(models, { schema: IDENTITY }), (error) => error.code === "resolve_failed" && /not one of/.test(error.message));
  await assert.rejects(ask(models, { schema: IDENTITY }), (error) => error.code === "resolve_failed" && /not JSON/.test(error.message));
});

test("without an available provider, a plugin learns so before it calls", async () => {
  const { models } = await host({ complete: async () => ({ text: "x" }), status: () => ({ available: false, reason: "The borrowed sign-in has expired" }) });
  assert.equal(await models.available(), false);
  await assert.rejects(ask(models), (error) => error.code === "not_found");

  const bare = await loadPlugins([{ name: "caller", enabled: true, options: {}, factory: () => {} }], { logger: quiet });
  assert.deepEqual(await bare.models.status(), { provider: null, providers: [], callsPerDay: 500, calls: {} });
});

test("a plugin over its daily calls gets rate_limited", async () => {
  const { models, plugins } = await host({ complete: async () => ({ text: "ok" }), env: { MODEL_CALLS_PER_DAY: "2" } });
  await ask(models);
  await ask(models);
  await assert.rejects(ask(models), (error) => error.code === "rate_limited");
  assert.equal(await models.available(), false);
  assert.deepEqual((await plugins.models.status()).calls, { caller: 2 });
});

test("at most two requests run at once", async () => {
  let running = 0;
  let most = 0;
  const { models } = await host({
    complete: async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return { text: "ok" };
    },
  });
  await Promise.all(Array.from({ length: 5 }, () => ask(models)));
  assert.equal(most, 2);
});

test("a malformed request is refused before it reaches the provider", async () => {
  const { models } = await host({ complete: async () => assert.fail("reached the provider") });
  await assert.rejects(models.complete({ purpose: "Identify!", messages: [{ role: "user", content: "x" }] }), (error) => error.code === "invalid_request");
  await assert.rejects(models.complete({ purpose: "identify", messages: [] }), (error) => error.code === "invalid_request");
  await assert.rejects(models.complete({ purpose: "identify", messages: [{ role: "assistant", content: "x" }] }), (error) => error.code === "invalid_request");
});

test("the node's health lists the model providers and today's calls", async () => {
  const { plugins, models } = await host({ complete: async () => ({ text: "ok" }), status: () => ({ available: true, sources: [{ id: "borrowed", available: true }] }) });
  await ask(models);
  const secret = "node-test-secret";
  const app = createNodeApp({ secret, plugins });
  const headers = await signNodeRequest(secret, { method: "GET", path: "/internal/v1/health", body: "" });
  const health = await (await app.request("/internal/v1/health", { headers })).json();
  assert.deepEqual(health.models, {
    provider: "subs",
    providers: [{ id: "subs", plugin: "provider", available: true, sources: [{ id: "borrowed", available: true }] }],
    callsPerDay: 500,
    calls: { caller: 1 },
  });
});

test("schemaError covers the schema plugins give models", () => {
  assert.equal(schemaError({ kind: "movie", season: null }, IDENTITY), null);
  assert.match(schemaError({ kind: "movie" }, IDENTITY), /has no season/);
  assert.match(schemaError({ kind: "movie", season: -1 }, IDENTITY), /below 0/);
  assert.match(schemaError({ kind: "movie", season: 1, extra: true }, IDENTITY), /unexpected extra/);
  assert.match(schemaError([1, "two"], { type: "array", items: { type: "integer" } }), /answer\[1\] is string/);
  assert.equal(schemaError(2, { anyOf: [{ type: "string" }, { type: "number" }] }), null);
});
