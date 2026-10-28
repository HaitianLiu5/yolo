import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { YoloError } from "@useyolo/plugin-api";
import proxyTransocksPlugin, { accountFrom, createTransocksProvider, LINE_TTL_MS, PROVIDER_ID, probeEndpoint } from "../src/node.js";

// The Transocks proxy provider (Agent Note 2026-10-28-transocks-proxy-provider):
// from the account alone it picks the fastest China line that tunnels,
// renews it, and moves on when it fails.

const ENV = { TRANSOCKS_ACCOUNT: "owner@example.com", TRANSOCKS_PASSWORD: "hunter2" };

const LINES = [
  { id: 1, name: "Guangzhou 1", location: "广州 GuangZhou", host: "10.0.0.1", detectPort: 8005, relay: false },
  { id: 2, name: "Shanghai 2", location: "上海 ShangHai", host: "10.0.0.2", detectPort: 8005, relay: false },
  { id: 3, name: "Relay US", location: "美国 United States", host: "10.0.0.3", detectPort: 8005, relay: true },
  { id: 4, name: "Quanzhou 4", location: "泉州 QuanZhou", host: "10.0.0.4", detectPort: 8005, relay: false },
];

// A provider over a fake account: `latency` by host (Infinity is down),
// `tunnels` the set of line ids whose proxy tunnels.
function providerWith({ latency = { "10.0.0.1": 40, "10.0.0.2": 20, "10.0.0.3": 5, "10.0.0.4": 60 }, tunnels = new Set([1, 2, 4]), env = ENV } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const lines = [];
  let sessions = 0;
  let gone = false;
  const api = {
    async login() {
      calls.push("login");
      sessions += 1;
      gone = false;
      return { token: { token_type: "Bearer", access_token: `tok-${sessions}` }, expiresAt: clock + 24 * 3600_000 };
    },
    async lines() {
      calls.push("lines");
      return LINES;
    },
    async connect(token, id) {
      if (gone) throw Object.assign(new YoloError("resolve_failed", "Transocks: the session has ended"), { apiCode: 20001 });
      calls.push(`connect ${id}`);
      return { url: `http://10.0.${id}.9:43211`, username: `user-${id}`, password: `pass-${id}-${token.access_token}`, name: `line ${id}` };
    },
    async disconnect(token, id) {
      calls.push(`disconnect ${id}`);
    },
  };
  const logs = [];
  const log = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (fields, message) => logs.push(`${level} ${typeof fields === "string" ? fields : `${message} ${JSON.stringify(fields)}`}`)]));
  const provider = createTransocksProvider({
    env,
    log,
    now: () => clock,
    ping: async (host) => latency[host] ?? Infinity,
    probe: async (endpoint) => tunnels.has(Number(/10\.0\.(\d+)\./.exec(endpoint.url)[1])),
    createApi: () => api,
  });
  return { provider, calls, logs, tunnels, latency, advance: (ms) => { clock += ms; }, endSession: () => { gone = true; }, now: () => clock };
}

const lineOf = (endpoint) => Number(/10\.0\.(\d+)\./.exec(endpoint.url)[1]);

test("the provider signs in, skips relays, and hands out the fastest China line's proxy until it is due for renewal", async () => {
  const { provider, calls, now } = providerWith();
  const endpoint = await provider.endpoint({}, { refused: false, failed: false });
  assert.equal(lineOf(endpoint), 2, "Shanghai answers fastest; the faster relay abroad is not a China line");
  assert.deepEqual({ username: endpoint.username, expiresAt: endpoint.expiresAt }, { username: "user-2", expiresAt: now() + LINE_TTL_MS });
  assert.deepEqual(calls, ["login", "lines", "connect 2"]);
  assert.deepEqual(await provider.endpoint({}, { refused: false, failed: false }), endpoint, "a fresh line is reused without asking Transocks");
  assert.equal(calls.length, 3);
});

test("a line that does not answer or does not tunnel is passed over for the next fastest", async () => {
  const { provider, calls } = providerWith({ latency: { "10.0.0.1": 40, "10.0.0.2": Infinity, "10.0.0.4": 60 }, tunnels: new Set([4]) });
  assert.equal(lineOf(await provider.endpoint({}, {})), 4);
  assert.deepEqual(calls.filter((call) => call.startsWith("connect") || call.startsWith("disconnect")), ["connect 1", "disconnect 1", "connect 4"]);
});

test("options.locations limits the lines to those places", async () => {
  const { provider } = providerWith();
  assert.equal(lineOf(await provider.endpoint({ locations: ["GuangZhou"] }, {})), 1);
});

test("when the node says the proxy failed, a line that still tunnels stays and one that does not is replaced", async () => {
  const { provider, tunnels, calls } = providerWith();
  const first = await provider.endpoint({}, {});
  assert.deepEqual(await provider.endpoint({}, { failed: true }), first, "the line tunnels, so the site was the problem");
  tunnels.delete(2);
  const next = await provider.endpoint({}, { failed: true });
  assert.equal(lineOf(next), 1);
  assert.ok(calls.includes("disconnect 2"));
});

test("a refused or expired line gets a new session on the same line, and an ended session signs in again", async () => {
  const { provider, calls, advance, endSession } = providerWith();
  await provider.endpoint({}, {});
  const refused = await provider.endpoint({}, { refused: true });
  assert.equal(lineOf(refused), 2);
  assert.deepEqual(calls.slice(3), ["connect 2"]);
  advance(LINE_TTL_MS);
  endSession();
  const renewed = await provider.endpoint({}, {});
  assert.equal(lineOf(renewed), 2);
  assert.match(renewed.password, /tok-2$/, "the line was opened again under the new session");
  assert.deepEqual(calls.slice(4), ["login", "connect 2"]);
});

test("with no line working the provider fails, and its errors and logs never carry the password or a line's credentials", async () => {
  const { provider, logs } = providerWith({ tunnels: new Set() });
  await assert.rejects(provider.endpoint({}, {}), (error) => error instanceof YoloError && /None of the 3 fastest Transocks lines works/.test(error.message));
  await provider.endpoint({}, {}).catch(() => {});
  for (const line of logs) assert.ok(!/hunter2|pass-|tok-|10\.0\./.test(line), line);
  assert.ok(logs.some((line) => line.includes("does not tunnel")));
});

test("the account comes from the environment, and a phone number needs its calling code", () => {
  assert.throws(() => accountFrom({}), /TRANSOCKS_ACCOUNT and TRANSOCKS_PASSWORD are not set/);
  assert.throws(() => accountFrom({ TRANSOCKS_ACCOUNT: "5550100000", TRANSOCKS_PASSWORD: "x" }), /TRANSOCKS_COUNTRY_CODE/);
  const phone = accountFrom({ TRANSOCKS_ACCOUNT: "5550100000", TRANSOCKS_PASSWORD: "x", TRANSOCKS_COUNTRY_CODE: "+1" });
  assert.equal(phone.countryCode, "1");
  assert.match(phone.deviceId, /^[0-9a-f]{64}$/);
  assert.equal(accountFrom({ ...ENV }).deviceId, accountFrom({ ...ENV }).deviceId, "the node is the same device to Transocks on every start");
});

test("the probe passes a proxy that opens a tunnel and fails one that refuses or is not there", async () => {
  const server = createServer();
  server.on("connect", (request, socket) => socket.end(request.headers["proxy-authorization"] === `Basic ${Buffer.from("u:p").toString("base64")}` ? "HTTP/1.1 200 OK\r\n\r\n" : "HTTP/1.1 407 No\r\n\r\n"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await probeEndpoint({ url, username: "u", password: "p" }), true);
  assert.equal(await probeEndpoint({ url, username: "u", password: "wrong" }), false);
  server.close();
  await once(server, "close");
  assert.equal(await probeEndpoint({ url, username: "u", password: "p" }), false);
});

test("the plugin registers the transocks provider and a shutdown handler", () => {
  const registered = new Map();
  const handlers = [];
  proxyTransocksPlugin({ env: ENV, log: console, registerProxyProvider: (id, impl) => registered.set(id, impl), on: (event) => handlers.push(event) });
  assert.deepEqual([...registered.keys()], [PROVIDER_ID]);
  assert.deepEqual(handlers, ["shutdown"]);
});
