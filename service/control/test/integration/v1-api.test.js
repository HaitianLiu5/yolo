import assert from "node:assert/strict";
import { test } from "node:test";
import { createV1App } from "../../src/api/v1.js";
import { upsertDevice } from "../../src/store/devices.js";
import { createTestControlPlane, USER } from "../helpers/setup.js";

// The /v1 HTTP API over the real service layer, D1 schema, and HubCore, with
// a fake node. OAuthProvider is not in the loop; scopes are injected.
function createApi({ scopes = ["read", "control", "manage"], plane = createTestControlPlane() } = {}) {
  const app = createV1App({
    getContext: () => ({ services: plane.services, scopes, userId: USER }),
    issueRealtimeTicket: async (_env, userId) => ({ ticket: `t-${userId}`, expiresAt: 0 }),
  });
  const request = async (method, path, body) => {
    const response = await app.request(path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  return { plane, request };
}

test("queue and playlist endpoints round-trip", async () => {
  const { request } = createApi();
  const added = await request("POST", "/v1/queue", { itemId: "library:1" });
  assert.equal(added.status, 201);
  assert.equal(added.body.item.title, "Movie 1");
  await request("POST", "/v1/queue", { source: { url: "https://example.com/a" }, position: "next" });
  const queue = await request("GET", "/v1/queue");
  assert.deepEqual(queue.body.map((item) => item.title), ["A video", "Movie 1"]);
  const reordered = await request("POST", "/v1/queue/reorder", { ids: [queue.body[1].id] });
  assert.equal(reordered.body[0].title, "Movie 1");
  assert.equal((await request("DELETE", `/v1/queue/${queue.body[0].id}`)).status, 200);

  const playlist = await request("POST", "/v1/playlists", { name: "Trip" });
  assert.equal(playlist.status, 201);
  await request("POST", `/v1/playlists/${playlist.body.id}/items`, { itemId: "library:2" });
  const renamed = await request("PATCH", `/v1/playlists/${playlist.body.id}`, { name: "Road trip" });
  assert.equal(renamed.body.name, "Road trip");
  const enqueued = await request("POST", `/v1/playlists/${playlist.body.id}/enqueue`, { position: "end" });
  assert.equal(enqueued.body.added, 1);
  assert.equal((await request("DELETE", `/v1/playlists/${playlist.body.id}`)).status, 200);
  assert.equal((await request("GET", `/v1/playlists/${playlist.body.id}`)).status, 404);
});

test("playback endpoints drive the hub", async () => {
  const { request } = createApi();
  const played = await request("POST", "/v1/playback/play", { itemId: "library:5", startTime: 12 });
  assert.equal(played.status, 200);
  assert.equal(played.body.state.position, 12);
  assert.equal((await request("POST", "/v1/playback/pause")).body.state.status, "paused");
  assert.equal((await request("POST", "/v1/playback/seek", { position: 30 })).body.state.position, 30);
  const playback = await request("GET", "/v1/playback");
  assert.equal(playback.body.item.title, "Movie 5");
  assert.equal((await request("POST", "/v1/playback/stop")).body.state.status, "idle");
  const history = await request("GET", "/v1/history?limit=5");
  assert.equal(history.body[0].sourceKey, "library:5");
  assert.equal((await request("DELETE", "/v1/history", { sourceKey: "nine" })).status, 400);
  assert.equal((await request("DELETE", "/v1/history", { sourceKey: "library:5" })).body.deleted, 1);
});

test("errors use the shared error body and status codes", async () => {
  const { request, plane } = createApi();
  const bad = await request("POST", "/v1/playback/seek", { position: -1 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_request");
  plane.node.offline = true;
  const offline = await request("GET", "/v1/library");
  assert.equal(offline.status, 503);
  assert.deepEqual(offline.body.error, { code: "node_offline", message: "Media node is offline", retryable: true });
  assert.equal((await request("GET", "/v1/nope")).body.error.code, "not_found");
});

test("the owner renames a device and sets its type", async () => {
  const { request, plane } = createApi();
  plane.db.raw.prepare("INSERT INTO devices (id, user_id, name, kind, capabilities, created_at) VALUES ('dev_car', ?, 'Browser', 'browser', '{}', 0)").run(USER);
  const renamed = await request("PATCH", "/v1/devices/dev_car", { name: "Model Y", kind: "car" });
  assert.equal(renamed.status, 200);
  assert.deepEqual([renamed.body.name, renamed.body.kind], ["Model Y", "car"]);
  assert.equal((await request("PATCH", "/v1/devices/dev_car", { kind: "toaster" })).status, 400);
  assert.equal((await request("PATCH", "/v1/devices/dev_car", {})).status, 400);
  assert.equal((await request("PATCH", "/v1/devices/dev_nope", { name: "x" })).status, 404);
  assert.equal((await request("DELETE", "/v1/devices/self")).status, 403, "an agent is not a device");
  const { devices } = (await request("GET", "/v1/devices")).body;
  assert.deepEqual(devices.filter((device) => device.id === "dev_car").map((device) => [device.name, device.kind]), [["Model Y", "car"]]);
});

test("each route enforces its scope", async () => {
  const { request } = createApi({ scopes: ["read"] });
  assert.equal((await request("GET", "/v1/queue")).status, 200);
  const denied = await request("DELETE", "/v1/queue");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "forbidden");
  assert.equal((await request("POST", "/v1/playback/pause")).status, 403);
  assert.equal((await request("POST", "/v1/realtime/ticket")).body.ticket, `t-${USER}`);
});

test("a paired device's credential plays and rebuilds streams, and forgets only itself", async () => {
  const plane = createTestControlPlane();
  const self = await upsertDevice(plane.db, USER, { name: "Desk", kind: "browser", capabilities: {} });
  const other = await upsertDevice(plane.db, USER, { name: "Model Y", kind: "car", capabilities: {} });
  const app = createV1App({
    getContext: () => ({ services: plane.services, scopes: ["read", "control", "manage"], userId: USER, deviceId: self.id }),
    issueRealtimeTicket: async (_env, userId, { deviceId }) => ({ ticket: `t-${userId}-${deviceId}`, expiresAt: 0 }),
  });
  const request = async (method, path, body) => {
    const response = await app.request(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request("POST", "/v1/realtime/ticket")).body.ticket, `t-${USER}-${self.id}`);
  assert.equal((await request("DELETE", `/v1/devices/${other.id}`)).status, 403, "another device needs the owner");
  assert.equal((await request("PATCH", `/v1/devices/${self.id}`, { name: "x" })).status, 403);
  const played = await request("POST", "/v1/playback/play", { itemId: "library:5" });
  const rebuilt = await request("POST", "/v1/playback/play", {
    itemId: "library:5", startTime: 40, reason: "seek", sessionId: played.body.state.sessionId, autoplay: false,
  });
  assert.equal(rebuilt.status, 200);
  assert.equal(rebuilt.body.state.position, 40);
  const stale = await request("POST", "/v1/playback/play", { itemId: "library:5", startTime: 1, reason: "recovery", sessionId: "ses_old" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "superseded");

  assert.deepEqual((await request("DELETE", "/v1/devices/self")).body, { deleted: self.id, revoked: true });
  assert.deepEqual((await plane.services.devices()).devices.filter((device) => device.via === "realtime").map((device) => device.id), [other.id]);
});

// Regression (production, 2026-10-12): the car slept 52 minutes while
// playing. On waking, its next segment got 410 SESSION_EXPIRED and the player
// asked for a fresh stream at once, while its realtime socket reconnected.
// The request reached the Hub before the new socket's hello, so the Hub
// answered 409 device_offline ("Browser is offline") although the socket
// said hello a second later.
test("a car that wakes asks for a fresh stream before its new socket said hello, and gets one", async () => {
  const plane = createTestControlPlane();
  plane.node.routes["GET /internal/v1/renderers"] = () => ({ renderers: [] });
  const car = await upsertDevice(plane.db, USER, {
    name: "Browser", kind: "browser", capabilities: { renderer: "canvas-webcodecs", delivery: ["hls", "mp4"], maxHeight: 720 },
  });
  plane.transport.hello(car.id);
  const app = createV1App({
    getContext: () => ({ services: plane.services, scopes: ["read", "control", "manage"], userId: USER, deviceId: car.id }),
    issueRealtimeTicket: async () => ({ ticket: "t", expiresAt: 0 }),
  });
  const request = async (method, path, body) => {
    const response = await app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  const played = await request("POST", "/v1/playback/play", { itemId: "library:5", startTime: 0, deviceId: car.id });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  const { sessionId, item } = played.body.state;
  await plane.hub.deviceMessage(car.id, { type: "report", sessionId, status: "playing", position: 120, duration: 600 });

  // The car sleeps: the Hub loses the socket and keeps the place, paused.
  plane.transport.online.delete(car.id);
  await plane.hub.deviceDisconnected(car.id);
  assert.equal((await plane.hub.state()).status, "paused");

  // It wakes: the recovery request first, the new socket's hello 50 ms later.
  const recovery = request("POST", "/v1/playback/play", {
    source: item.source, startTime: 120, reason: "recovery", sessionId, autoplay: true, deviceId: car.id,
  });
  setTimeout(() => plane.transport.hello(car.id), 50);
  const recovered = await recovery;
  assert.equal(recovered.status, 200, `the wake race failed: ${JSON.stringify(recovered.body)}`);
  assert.equal(recovered.body.state.position, 120, "at the position where the car fell asleep");
  const load = plane.transport.sent.at(-1);
  assert.deepEqual([load.deviceId, load.message.type, load.message.reason, load.message.startTime], [car.id, "load", "recovery", 120]);
  assert.ok(plane.logs.some((record) => record.event === "hello_wait" && record.outcome === "hello" && record.deviceId === car.id));
});

test("a paired device's events become one structured log line each, without secrets", async () => {
  const plane = createTestControlPlane();
  const logged = [];
  const appFor = (deviceId) => createV1App({
    getContext: () => ({ services: plane.services, scopes: ["read", "control", "manage"], userId: USER, deviceId }),
    issueRealtimeTicket: async () => ({ ticket: "t", expiresAt: 0 }),
    log: (record) => logged.push(record),
  });
  const post = async (app, body) => {
    const response = await app.request("/v1/devices/self/events", {
      method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const car = appFor("dev_events_car");

  const sent = await post(car, {
    pageId: "p1",
    dropped: 2,
    events: [
      { type: "session_expired", at: 1_760_000_000_000, seq: 7, sessionId: "ses_a", fields: { code: "SESSION_EXPIRED", url: "/m/tok/f/76.m4s", token: "ydt_x" } },
      { type: "realtime_close", at: 1_760_000_000_500, seq: 8, sessionId: null, fields: { code: 1006, wasClean: false, deviceId: "dev_spoofed", kind: "spoofed" } },
      { type: "not a type!" },
    ],
  });
  assert.equal(sent.status, 202);
  assert.deepEqual(sent.body, { accepted: 2, rejected: 1 });
  const [expired, closed, dropped] = logged;
  assert.deepEqual(
    { kind: expired.kind, userId: expired.userId, deviceId: expired.deviceId, sessionId: expired.sessionId, type: expired.type, at: expired.at, code: expired.code, url: expired.url },
    { kind: "device_event", userId: USER, deviceId: "dev_events_car", sessionId: "ses_a", type: "session_expired", at: 1_760_000_000_000, code: "SESSION_EXPIRED", url: "/m/<redacted>/f/76.m4s" },
  );
  assert.equal(expired.token, undefined);
  assert.deepEqual([closed.kind, closed.deviceId, closed.code, closed.wasClean], ["device_event", "dev_events_car", 1006, false], "the credential names the device");
  assert.deepEqual([dropped.type, dropped.count], ["events_dropped", 2]);

  // Only a paired device's credential; bounded batches; a rate limit per device.
  assert.equal((await post(appFor(null), { events: [] })).status, 403);
  assert.equal((await post(car, { events: Array.from({ length: 51 }, () => ({ type: "x" })) })).status, 400);
  assert.equal((await post(car, "{not json")).status, 400);
  const busy = appFor("dev_events_busy");
  const statuses = [];
  for (let i = 0; i < 13; i += 1) statuses.push((await post(busy, { events: [{ type: "tick" }] })).status);
  assert.deepEqual([statuses.slice(0, 12).every((status) => status === 202), statuses[12]], [true, 429]);
});
