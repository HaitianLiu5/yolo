import assert from "node:assert/strict";
import test from "node:test";
import { createStreamRequester, StreamRequestError } from "../../src/stream-requests.js";

// The car wakes up (production, 2026-10-12): the next segment is 410
// SESSION_EXPIRED and the player wants a fresh stream at once, while the
// realtime socket is still reconnecting.

const apiError = (code, status, message = code) => Object.assign(new Error(message), { name: "ApiError", code, status });

function harness({ ready = Promise.resolve() } = {}) {
  let clock = 0;
  const sleeps = [];
  const replaced = [];
  const events = [];
  let waitForReady = () => ready;
  const requester = createStreamRequester({
    whenReady: (options) => waitForReady(options),
    replaceChannel: (reason) => replaced.push(reason),
    onEvent: (type, fields) => events.push({ type, ...fields }),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { requester, sleeps, replaced, events, setReady: (fn) => { waitForReady = fn; } };
}

test("the request waits until the realtime channel is welcomed", async () => {
  let welcome;
  const { requester } = harness({ ready: new Promise((resolve) => { welcome = resolve; }) });
  const sent = [];
  const pending = requester.request(async () => {
    sent.push("play");
    return { ok: true };
  }, { reason: "recovery" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent, [], "nothing goes before the welcome");
  welcome();
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(sent, ["play"]);
});

test("a wake makes one recovery request: the welcome's resume joins the player's recovery", async () => {
  let welcome;
  const { requester, events } = harness({ ready: new Promise((resolve) => { welcome = resolve; }) });
  let calls = 0;
  const attempt = async () => {
    calls += 1;
    return { state: { sessionId: "ses_new" } };
  };
  const fromPlayer = requester.request(attempt, { reason: "recovery" });
  const fromWelcome = requester.request(attempt, { reason: "recovery" });
  assert.equal(requester.recoveryPending, true);
  welcome();
  assert.deepEqual(await Promise.all([fromPlayer, fromWelcome]), [{ state: { sessionId: "ses_new" } }, { state: { sessionId: "ses_new" } }]);
  assert.equal(calls, 1);
  assert.equal(requester.recoveryPending, false);
  assert.ok(events.some((event) => event.type === "stream_request_joined"));
  // Seeks are not joined: the latest target wins at the Hub.
  await Promise.all([requester.request(attempt, { reason: "seek" }), requester.request(attempt, { reason: "seek" })]);
  assert.equal(calls, 3);
});

test("device_offline replaces the channel and retries with backoff", async () => {
  const { requester, sleeps, replaced } = harness();
  let calls = 0;
  const result = await requester.request(async () => {
    calls += 1;
    if (calls < 3) throw apiError("device_offline", 409, "Browser is offline");
    return "ok";
  }, { reason: "recovery" });
  assert.equal(result, "ok");
  assert.deepEqual(sleeps, [1_000, 2_000]);
  assert.deepEqual(replaced, ["device_offline", "device_offline"]);
});

test("after the bound it gives up with a clear message and the code", async () => {
  const { requester, sleeps } = harness();
  let calls = 0;
  const failure = await requester.request(async () => {
    calls += 1;
    throw apiError("node_offline", 503, "The home media node is offline");
  }, { reason: "recovery" }).catch((error) => error);
  assert.ok(failure instanceof StreamRequestError);
  assert.equal(failure.code, "node_offline");
  assert.equal(calls, 5);
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000, 8_000]);
  assert.match(failure.message, /^The home media node is offline \(gave up after 5 tries in 15 s\)$/);
});

test("refusals that cannot heal are not retried", async () => {
  const { requester, sleeps } = harness();
  for (const error of [apiError("superseded", 409), apiError("invalid_request", 400), apiError("unauthorized", 401)]) {
    let calls = 0;
    const failure = await requester.request(async () => {
      calls += 1;
      throw error;
    }, { reason: "recovery" }).catch((caught) => caught);
    assert.equal(failure, error);
    assert.equal(calls, 1);
  }
  assert.deepEqual(sleeps, []);
});

test("a lost network is retried, and flagged when it does not come back", async () => {
  const { requester } = harness();
  const failure = await requester.request(async () => {
    throw new TypeError("Failed to fetch");
  }, { reason: "recovery" }).catch((error) => error);
  assert.equal(failure.network, true);
  assert.equal(failure.attempts, 5);
});

test("a realtime channel that does not come back counts as a retryable try within the budget", async () => {
  const { requester, setReady } = harness();
  const timeouts = [];
  setReady(async ({ timeoutMs }) => {
    timeouts.push(timeoutMs);
    throw Object.assign(new Error("Yolo's realtime connection did not come back within 20 s"), { code: "realtime_unavailable" });
  });
  const failure = await requester.request(async () => "never", { reason: "recovery" }).catch((error) => error);
  assert.ok(failure instanceof StreamRequestError);
  assert.deepEqual([failure.code, failure.attempts, timeouts.length], ["realtime_unavailable", 5, 5]);
  assert.ok(timeouts.every((ms) => ms > 0 && ms <= 20_000));
});
