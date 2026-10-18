import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_PING } from "@useyolo/core";

// The device side of the realtime channel (Agent Note 2026-10-07-hub-and-realtime-channel):
// the heartbeat is exactly HEARTBEAT_PING, broadcasts are never answered,
// commands with an id are acknowledged, a rate-limited close waits 30 s, and
// the player's requests wait for the welcome (Agent Note 2026-10-11-wake-request-ordering).

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
globalThis.fetch = async () => Response.json({ ticket: "t", expiresAt: Date.now() + 30_000 });
const { createRealtime } = await import("../../src/realtime.js");
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("heartbeat, broadcasts, acks, the welcome gate, and the rate-limit backoff", async (t) => {
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
});
