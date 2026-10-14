import assert from "node:assert/strict";
import test from "node:test";

// The realtime channel's readiness gate (realtime.whenReady): the player's
// own requests go only once the Hub has welcomed the current socket.

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

  send(data) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: true }));
  }

  // Test controls.
  accept() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify({ v: 1, ...message }) });
  }
}

globalThis.WebSocket = FakeSocket;
globalThis.location = new URL("https://yolo.test/play");
let tickets = 0;
globalThis.fetch = async () => {
  tickets += 1;
  return Response.json({ ticket: `t${tickets}`, expiresAt: Date.now() + 30_000 });
};

const { createRealtime } = await import("../../src/realtime.js");

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function nextSocket(count) {
  for (let i = 0; i < 100 && FakeSocket.instances.length < count; i += 1) await tick();
  assert.equal(FakeSocket.instances.length, count, "a socket was opened");
  return FakeSocket.instances[count - 1];
}

function settled(promise) {
  const result = { done: false, error: null };
  promise.then(() => { result.done = true; }, (error) => { result.error = error; });
  return result;
}

test("requests wait for the welcome; after a sleep, for the welcome of a new socket", async (t) => {
  FakeSocket.instances.length = 0;
  const events = [];
  const realtime = createRealtime({ onMessage: () => {}, onEvent: (type, fields) => events.push({ type, ...fields }) });
  t.after(() => realtime.stop());
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });

  realtime.start();
  const first = await nextSocket(1);
  const early = settled(realtime.whenReady({ timeoutMs: 5_000 }));
  first.accept();
  assert.match(first.sent[0], /"type":"hello"/);
  await tick();
  assert.equal(early.done, false, "open is not enough: the Hub has not seen the hello yet");
  first.receive({ type: "welcome", deviceId: "dev_car", state: { status: "playing" }, queue: [], playlists: [] });
  await tick();
  assert.equal(early.done, true);
  assert.equal(realtime.ready, true);

  // The car sleeps 52 minutes. The socket looks open, but nothing has come
  // through it since: a request now must wait for a new socket's welcome.
  const sleptFor = 52 * 60_000;
  Date.now = () => realNow() + sleptFor;
  assert.equal(realtime.ready, false);
  const afterWake = settled(realtime.whenReady({ timeoutMs: 5_000 }));
  const second = await nextSocket(2);
  assert.equal(first.readyState, FakeSocket.CLOSED, "the stale socket was dropped");
  second.accept();
  await tick();
  assert.equal(afterWake.done, false);
  second.receive({ type: "welcome", deviceId: "dev_car", state: { status: "paused", interruptedAt: 1 }, queue: [], playlists: [] });
  await tick();
  assert.equal(afterWake.done, true);
  assert.deepEqual(events.filter((event) => event.type.startsWith("realtime_")).map((event) => event.type), [
    "realtime_open", "realtime_welcome", "realtime_close", "realtime_open", "realtime_welcome",
  ]);
  assert.equal(events.find((event) => event.type === "realtime_close").reason, "stale");
});

test("a probe after waking holds requests until the socket answers, or replaces it", async (t) => {
  FakeSocket.instances.length = 0;
  const realtime = createRealtime({ onMessage: () => {} });
  t.after(() => realtime.stop());
  realtime.start();
  const socket = await nextSocket(1);
  socket.accept();
  socket.receive({ type: "welcome", deviceId: "dev_car", state: {}, queue: [], playlists: [] });

  realtime.probe(40);
  assert.equal(realtime.ready, false);
  assert.equal(socket.sent.at(-1), '{"v":1,"type":"ping"}');
  const waiting = settled(realtime.whenReady({ timeoutMs: 5_000 }));
  socket.receive({ type: "pong" });
  await tick();
  assert.equal(waiting.done, true, "the pong proved it alive");

  realtime.probe(40);
  await tick(80);
  assert.equal(socket.readyState, FakeSocket.CLOSED, "no answer: dropped");
  await nextSocket(2);
});

test("waiting gives up after its timeout, and at once when the channel stops", async () => {
  FakeSocket.instances.length = 0;
  const realtime = createRealtime({ onMessage: () => {} });
  realtime.start();
  await nextSocket(1);
  const timedOut = await realtime.whenReady({ timeoutMs: 20 }).catch((error) => error);
  assert.equal(timedOut.code, "realtime_unavailable");
  const stopping = realtime.whenReady({ timeoutMs: 5_000 }).catch((error) => error);
  realtime.stop();
  assert.equal((await stopping).code, "realtime_stopped");
  assert.equal((await realtime.whenReady().catch((error) => error)).code, "realtime_stopped");
});

test("a socket that never opens is replaced", async (t) => {
  FakeSocket.instances.length = 0;
  const realtime = createRealtime({ onMessage: () => {}, connectTimeoutMs: 40 });
  t.after(() => realtime.stop());
  realtime.start();
  const stuck = await nextSocket(1);
  await tick(70);
  assert.equal(stuck.readyState, FakeSocket.CLOSED);
  await nextSocket(2);
  const next = FakeSocket.instances.at(-1);
  next.accept();
  next.receive({ type: "welcome", deviceId: "dev_car", state: {}, queue: [], playlists: [] });
  await realtime.whenReady({ timeoutMs: 100 });
});

// When the page last heard Yolo over the connection before a welcome
// (missed-commands.js): anything a welcomed socket brings counts, the
// heartbeat's answer too; a new socket counts only from its welcome on.
test("heardAt is when a welcomed connection last brought anything, read in the next one's welcome", async (t) => {
  FakeSocket.instances.length = 0;
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  let clock = 1_000;
  Date.now = () => clock;
  const heardAtWelcome = [];
  const realtime = createRealtime({
    onMessage: (message) => {
      if (message.type === "welcome") heardAtWelcome.push(realtime.heardAt);
    },
  });
  t.after(() => realtime.stop());
  realtime.start();
  const first = await nextSocket(1);
  first.accept();
  first.receive({ type: "state", state: {} });
  assert.equal(realtime.heardAt, 0, "not welcomed yet");
  first.receive({ type: "welcome", deviceId: "dev_car", state: {}, queue: [], playlists: [] });
  clock = 2_000;
  first.onmessage({ data: '{"v":1,"type":"pong"}' });
  assert.equal(realtime.heardAt, 2_000);
  clock = 50_000;
  realtime.replace("dead");
  const second = await nextSocket(2);
  second.accept();
  second.receive({ type: "state", state: {} });
  second.receive({ type: "welcome", deviceId: "dev_car", state: {}, queue: [], playlists: [] });
  assert.deepEqual(heardAtWelcome, [0, 2_000]);
  clock = 51_000;
  second.receive({ type: "state", state: {} });
  assert.equal(realtime.heardAt, 51_000);
});
