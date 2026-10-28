import assert from "node:assert/strict";
import { test } from "node:test";
import { createTransocksApi, open, seal } from "../src/api.js";

// Transocks' sealed API (Agent Note 2026-10-28-transocks-proxy-provider),
// against a fake gateway that opens what it is sent and seals its answers.

test("a sealed body opens to its payload, and one whose signature does not match is refused", () => {
  const sealed = seal({ target: "lines", n: 1 }, 1_761_600_000);
  assert.deepEqual(open(sealed), { target: "lines", n: 1, t: 1_761_600_000 });
  assert.throws(() => open({ ...sealed, encrypted: seal({ other: true }, 1_761_600_000).encrypted }), /bad signature/);
  assert.deepEqual(open({ code: 0 }), { code: 0 }, "an answer that is not sealed is read as it is");
});

// A fake gateway: `answer(path, payload)` → what it answers, sealed.
function fakeGateway(answer, { down = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { origin, pathname } = new URL(url);
    if (down.includes(origin)) throw new Error("connect ECONNREFUSED");
    const body = JSON.parse(init.body);
    const payload = open(body);
    calls.push({ origin, path: pathname, headers: init.headers, body, payload });
    return new Response(JSON.stringify(seal(answer(pathname, payload), payload.t)));
  };
  return { calls, fetchImpl };
}

const LINES = [
  { id: 1, name: "Line A", location: "广州 GuangZhou", iPAddr: "203.0.113.1", detectPort: 8005, isRelay: false },
  { id: 2, name: "Relay B", location: "美国 United States", iPAddr: "203.0.113.2", detectPort: 8005, isRelay: true },
  { id: 3, name: "Broken C", location: "上海 ShangHai", iPAddr: "203.0.113.3", detectPort: 8005, isRelay: false, error: "down" },
];

function gatewayFor(overrides = {}) {
  return fakeGateway((path, payload) => {
    if (overrides[payload.target]) return overrides[payload.target](payload);
    if (payload.target === "login") return { code: 0, status: "ok", data: { token: { token_type: "Bearer", access_token: "tok-1", exp: 1_900_000_000 }, expired: false } };
    if (payload.target === "lines") return { code: 0, status: "ok", lines: LINES };
    if (payload.target === "connect") return { code: 0, status: "ok", lineName: "Line A", config: { HTTPConf: { server: "203.0.113.1", port: 43211, username: "line-user", password: "line-pass" } } };
    return { code: 0, status: "ok" };
  });
}

test("signing in by phone sends the account, kicks the oldest device, and returns the token and its expiry", async () => {
  const { calls, fetchImpl } = gatewayFor();
  const api = createTransocksApi({ account: "555 010 0000", password: "secret", countryCode: "1", deviceId: "dev", fetchImpl });
  assert.deepEqual(await api.login(), { token: { token_type: "Bearer", access_token: "tok-1" }, expiresAt: 1_900_000_000_000 });
  const { path, payload } = calls[0];
  assert.equal(path, "/ext/gateway");
  assert.deepEqual({ target: payload.target, auth: payload.auth, phone: payload.phone, cc: payload.cc, password: payload.password, autokick: payload.autokick, mac: payload.mac, org: payload.org },
    { target: "login", auth: "mobile", phone: "5550100000", cc: "1", password: "secret", autokick: 1, mac: "dev", org: "transocks_pro" });
  const byEmail = gatewayFor();
  await createTransocksApi({ account: "owner@example.com", password: "secret", deviceId: "dev", fetchImpl: byEmail.fetchImpl }).login();
  assert.equal(byEmail.calls[0].payload.auth, "email");
  assert.equal(byEmail.calls[0].payload.email, "owner@example.com");
});

test("lines leave out broken ones, and connect gives the line's HTTP proxy with the token as authorization", async () => {
  const { calls, fetchImpl } = gatewayFor();
  const api = createTransocksApi({ account: "owner@example.com", password: "secret", deviceId: "dev", fetchImpl });
  const token = { token_type: "Bearer", access_token: "tok-1" };
  assert.deepEqual((await api.lines(token)).map(({ id, relay }) => [id, relay]), [[1, false], [2, true]]);
  assert.deepEqual(await api.connect(token, 1), { url: "http://203.0.113.1:43211", username: "line-user", password: "line-pass", name: "Line A" });
  const connect = calls.at(-1);
  assert.equal(connect.path, "/ext/gateway/line");
  assert.equal(connect.headers.Authorization, "Bearer tok-1");
  assert.deepEqual({ target: connect.payload.target, lineID: connect.payload.lineID, proto: connect.payload.proto }, { target: "connect", lineID: 1, proto: "HTTP" });
  assert.equal(connect.body.mac, "chrome", "the line gateway's outer body names the device as the extension does");
});

test("the API's refusals become errors that keep its code and never the password", async () => {
  const { fetchImpl } = gatewayFor({ login: () => ({ code: 40001, status: "error", msg: "bad" }) });
  const api = createTransocksApi({ account: "owner@example.com", password: "hunter2", deviceId: "dev", fetchImpl });
  await assert.rejects(api.login(), (error) => error.code === "unauthorized" && error.apiCode === 40001 && !error.message.includes("hunter2"));
  const expired = gatewayFor({ connect: () => ({ code: 20001, msg: "token" }) });
  await assert.rejects(createTransocksApi({ account: "a@b.c", password: "x", deviceId: "d", fetchImpl: expired.fetchImpl }).connect({ token_type: "Bearer", access_token: "t" }, 1), (error) => error.apiCode === 20001);
});

test("a gateway that cannot be reached moves the client to the next origin, which it keeps", async () => {
  const { calls, fetchImpl } = fakeGateway(() => ({ code: 0, lines: [] }), { down: ["https://first.example"] });
  const api = createTransocksApi({ account: "a@b.c", password: "x", deviceId: "d", fetchImpl, origins: ["https://first.example", "https://second.example"] });
  await api.lines({ token_type: "Bearer", access_token: "t" });
  await api.lines({ token_type: "Bearer", access_token: "t" });
  assert.deepEqual(calls.map(({ origin }) => origin), ["https://second.example", "https://second.example"]);
  const none = createTransocksApi({ account: "a@b.c", password: "x", deviceId: "d", fetchImpl: async () => { throw new Error("offline"); }, origins: ["https://first.example"] });
  await assert.rejects(none.lines({ token_type: "Bearer", access_token: "t" }), /could not be reached: offline/);
});
