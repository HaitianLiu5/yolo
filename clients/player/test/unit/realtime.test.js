import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_PING } from "@useyolo/core";

// The device side of the realtime channel (Agent Note 2026-10-07-hub-and-realtime-channel):
// the heartbeat is exactly HEARTBEAT_PING, broadcasts are never answered,
// commands with an id are acknowledged, a rate-limited close waits 30 s, an
// upgrade welcome a minute (Agent Note 2026-10-19-client-protocol), and the
// player's requests wait for the welcome (Agent Note 2026-10-11-wake-request-ordering).

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = String(url);
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close(code = 1000, reason = "") {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }
  accept() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  receive(message) { this.onmessage?.({ data: JSON.stringify({ v: 1, ...message }) }); }
}

globalThis.WebSocket = FakeSocket;
globalThis.location = new URL("https://yolo.test/play");
let tickets = 0;
globalThis.fetch = async () => {
  tickets += 1;
  return Response.json({ ticket: "t", expiresAt: Date.now() + 30_000 });
};
const { createRealtime } = await import("../../src/realtime.js");
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("heartbeat, broadcasts, acks, the welcome gate, and the rate-limit and upgrade backoffs", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  t.after(() => mock.timers.reset());
  const realtime = createRealtime({ onMessage: () => {} });
  t.after(() => realtime.stop());
  realtime.start();
  await flush();
  const socket = FakeSocket.instances.at(-1);
  let ready = false;
  void realtime.whenReady({ timeoutMs: 60_000 }).then(() => { ready = true; });
  socket.accept();
  assert.match(socket.sent[0], /"type":"hello"/);
  await flush();
  assert.equal(ready, false, "open is not enough: the Hub has not seen the hello yet");
  socket.receive({ type: "welcome", deviceId: "dev_car", state: {}, queue: [], playlists: [] });
  await flush();
  assert.equal(ready, true);

  socket.sent.length = 0;
  socket.receive({ type: "state", state: { status: "playing" } });
  socket.receive({ type: "pause", id: "cmd_1" });
  assert.deepEqual(socket.sent, ['{"v":1,"type":"ack","id":"cmd_1"}'], "a broadcast is never answered");
  mock.timers.tick(HEARTBEAT_INTERVAL_MS);
  assert.equal(socket.sent.at(-1), HEARTBEAT_PING);

  const opened = FakeSocket.instances.length;
  socket.onclose({ code: 1008, reason: "rate_limited", wasClean: true });
  mock.timers.tick(29_999);
  await flush();
  assert.equal(FakeSocket.instances.length, opened, "no reconnect within 30 s of a rate limit");
  mock.timers.tick(1);
  await flush();
  assert.equal(FakeSocket.instances.length, opened + 1);

  const upgraded = FakeSocket.instances.at(-1);
  upgraded.accept();
  upgraded.receive({ type: "welcome", upgrade: true, clientProtocols: [9] });
  upgraded.close(1000, "upgrade");
  mock.timers.tick(59_999);
  await flush();
  assert.equal(FakeSocket.instances.length, opened + 1, "no reconnect within a minute of an upgrade welcome");
  mock.timers.tick(1);
  await flush();
  assert.equal(FakeSocket.instances.length, opened + 2);
});

test("the second socket in a row to close before it opened waits as after a rate limit", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  t.after(() => mock.timers.reset());
  const realtime = createRealtime({ onMessage: () => {} });
  t.after(() => realtime.stop());
  realtime.start();
  await flush();
  const opened = FakeSocket.instances.length;
  FakeSocket.instances.at(-1).onclose({ code: 1006, reason: "", wasClean: false });
  mock.timers.tick(1000);
  await flush();
  assert.equal(FakeSocket.instances.length, opened + 1, "one failure may be the network: the ordinary backoff");
  FakeSocket.instances.at(-1).onclose({ code: 1006, reason: "", wasClean: false });
  mock.timers.tick(29_999);
  await flush();
  assert.equal(FakeSocket.instances.length, opened + 1, "a second refused upgrade waits 30 s");
  mock.timers.tick(1);
  await flush();
  assert.equal(FakeSocket.instances.length, opened + 2);

  // A socket that opens ends the run.
  const socket = FakeSocket.instances.at(-1);
  socket.accept();
  socket.receive({ type: "welcome", deviceId: "dev_car", state: {}, queue: [], playlists: [] });
  socket.onclose({ code: 1006, reason: "", wasClean: false });
  mock.timers.tick(1000);
  await flush();
  FakeSocket.instances.at(-1).onclose({ code: 1006, reason: "", wasClean: false });
  mock.timers.tick(2000);
  await flush();
  assert.equal(FakeSocket.instances.length, opened + 4, "the first unopened socket after one that opened is not a rate limit");

  // The page's own reconnect ends the run too.
  realtime.reconnect();
  mock.timers.tick(1);
  await flush();
  assert.equal(FakeSocket.instances.length, opened + 5);
  FakeSocket.instances.at(-1).onclose({ code: 1006, reason: "", wasClean: false });
  mock.timers.tick(4000);
  await flush();
  assert.equal(FakeSocket.instances.length, opened + 6, "the first unopened socket after a reconnect is not a rate limit");
});

test("a ticket request that fails ends the run of unopened sockets", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  t.after(() => mock.timers.reset());
  const issue = globalThis.fetch;
  t.after(() => { globalThis.fetch = issue; });
  const realtime = createRealtime({ onMessage: () => {} });
  t.after(() => realtime.stop());
  realtime.start();
  await flush();
  const opened = FakeSocket.instances.length;
  globalThis.fetch = async () => Response.json({ error: { code: "node_offline", message: "x" } }, { status: 503 });
  FakeSocket.instances.at(-1).onclose({ code: 1006, reason: "", wasClean: false });
  mock.timers.tick(1000);
  await flush();
  assert.equal(FakeSocket.instances.length, opened, "no ticket, no socket");
  globalThis.fetch = issue;
  mock.timers.tick(2000);
  await flush();
  assert.equal(FakeSocket.instances.length, opened + 1);
  FakeSocket.instances.at(-1).onclose({ code: 1006, reason: "", wasClean: false });
  mock.timers.tick(4000);
  await flush();
  assert.equal(FakeSocket.instances.length, opened + 2, "the first unopened socket after a failed ticket is not a rate limit");
});

test("one ticket request at a time, however many callers ask for the connection", async (t) => {
  const realtime = createRealtime({ onMessage: () => {} });
  t.after(() => realtime.stop());
  const before = tickets;
  const sockets = FakeSocket.instances.length;
  realtime.start();
  for (let i = 0; i < 3; i += 1) {
    realtime.whenReady({ timeoutMs: 1000 }).catch(() => {});
    realtime.probe();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await flush();
  assert.equal(tickets - before, 1);
  assert.equal(FakeSocket.instances.length, sockets + 1);
});
