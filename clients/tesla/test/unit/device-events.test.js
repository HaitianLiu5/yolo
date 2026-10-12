import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceEvents } from "../../src/telemetry/device-events.js";

function harness(options = {}) {
  let clock = 1_000_000;
  const sent = [];
  let status = 202;
  let online = true;
  const events = createDeviceEvents({
    send: async (body, { keepalive }) => {
      sent.push({ body: structuredClone(body), keepalive, at: clock });
      return { status };
    },
    now: () => clock,
    isOnline: () => online,
    getSessionId: () => "ses_1",
    pageId: "page1",
    ...options,
  });
  return {
    events,
    sent,
    advance: (ms) => { clock += ms; },
    setStatus: (value) => { status = value; },
    setOnline: (value) => { online = value; },
  };
}

test("batches hold at most 50 events and go out at most every 10 seconds", async () => {
  const { events, sent, advance } = harness();
  for (let i = 0; i < 120; i += 1) events.record("health_heartbeat", { i });
  assert.equal(await events.flush(), true);
  assert.equal(await events.flush(), false, "too soon");
  advance(9_999);
  assert.equal(await events.flush(), false);
  advance(1);
  assert.equal(await events.flush(), true);
  assert.deepEqual(sent.map((batch) => batch.body.events.length), [50, 50]);
  assert.deepEqual(sent[0].body.events[0], { type: "health_heartbeat", at: 1_000_000, seq: 1, sessionId: "ses_1", fields: { i: 0 } });
  assert.equal(sent[0].body.pageId, "page1");
  assert.equal(events.size, 20);
});

test("offline, failed and rate-limited batches stay buffered; the buffer is capped", async () => {
  const { events, sent, advance, setStatus, setOnline } = harness({ capacity: 30 });
  for (let i = 0; i < 40; i += 1) events.record("tick", { i });
  assert.equal(events.size, 30, "the oldest went");
  setOnline(false);
  assert.equal(await events.flush(), false);
  assert.equal(sent.length, 0);
  setOnline(true);
  setStatus(503);
  assert.equal(await events.flush(), false);
  assert.equal(events.size, 30, "put back");
  advance(30_000);
  setStatus(429);
  await events.flush();
  advance(30_000);
  assert.equal(await events.flush(), false, "rate limited: waits a minute");
  advance(30_000);
  setStatus(202);
  assert.equal(await events.flush(), true);
  assert.equal(sent.at(-1).body.events[0].fields.i, 10);
  assert.equal(sent.at(-1).body.dropped, 10, "the server learns how many were lost");
});

test("a page going away sends the rest with keepalive, without waiting", async () => {
  const { events, sent } = harness();
  events.record("a");
  await events.flush();
  events.record("pagehide", { persisted: false });
  assert.equal(await events.flush({ keepalive: true }), true);
  assert.deepEqual(sent.map((batch) => [batch.keepalive, batch.body.events[0].type]), [[false, "a"], [true, "pagehide"]]);
});

test("events are sanitized before they are buffered", async () => {
  const { events, sent } = harness();
  events.record("network_segment_slow", { url: "https://yolo.test/m/SECRET/f/76.m4s", token: "ydt_x", authorization: "Bearer y" });
  events.record("bad type!", {});
  await events.flush();
  assert.deepEqual(sent[0].body.events.map((event) => [event.type, event.fields]), [
    ["network_segment_slow", { url: "https://yolo.test/m/<redacted>/f/76.m4s" }],
  ]);
  assert.ok(!JSON.stringify(sent).includes("SECRET"));
});

test("a wake is timed until playback runs again", async () => {
  const { events, sent, advance } = harness();
  events.markWake("timer_gap", 3_120_000);
  assert.ok(events.wakePending);
  advance(4_200);
  events.markPlaybackRestored({ position: 1234.5 });
  assert.equal(events.wakePending, null);
  await events.flush();
  const timed = sent[0].body.events.find((event) => event.type === "wake_to_playback");
  assert.deepEqual(timed.fields, { delayMs: 4_200, wakeSource: "timer_gap", gapMs: 3_120_000, position: 1234.5 });
});
