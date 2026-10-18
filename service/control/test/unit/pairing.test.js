import assert from "node:assert/strict";
import { test } from "node:test";
import { createV1App } from "../../src/api/v1.js";
import { createAuthApp } from "../../src/auth/app.js";
import { DEVICE_GRANT_TYPE, deviceTokenRequest } from "../../src/auth/device.js";
import { createSession } from "../../src/auth/session.js";
import { deleteDevice, getDevice, upsertDevice } from "../../src/store/devices.js";
import { decideDeviceCode, normalizeUserCode, pollDeviceCode, resolveDeviceToken } from "../../src/store/pairing.js";
import { ensureOwner } from "../../src/store/users.js";
import { createTestD1 } from "../helpers/d1.js";
import { createFakeNode, createMemoryKv, createTestControlPlane, USER } from "../helpers/fakes.js";

const ORIGIN = "https://yolo.example.com";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

test("device code pairing (RFC 8628): a screen pairs once with a code the signed-in owner allows from Yolo's own page within 10 minutes, and removing it revokes the credential", async () => {
  const db = createTestD1();
  const kv = createMemoryKv();
  const owner = await ensureOwner(db);
  const env = { PUBLIC_ORIGIN: ORIGIN, DB: db, OAUTH_KV: kv };
  const app = createAuthApp({ nodeClient: () => createFakeNode() });
  const cookie = (await createSession(kv, owner.id)).split(";")[0];
  const request = (path, init = {}) => app.request(path, init, env);
  const decide = (fields, headers = {}) => request("/device", { method: "POST", headers: { ...FORM, origin: ORIGIN, cookie, ...headers }, body: new URLSearchParams(fields).toString() });
  const authorize = async (fields) => (await request("/oauth/device_authorization", { method: "POST", headers: FORM, body: new URLSearchParams(fields).toString() })).json();
  const poll = async (deviceCode) => (await deviceTokenRequest(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST", headers: FORM, body: new URLSearchParams({ grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode, client_id: "yolo-player" }).toString(),
  }), env)).json();
  const started = await authorize({ device_name: 'Browser "2"', device_kind: "browser" });
  assert.match(started.user_code, /^[B-Z]{4}-[B-Z]{4}$/);
  assert.equal((await poll(started.device_code)).error, "authorization_pending");
  assert.equal((await poll(started.device_code)).error, "slow_down");
  // The device's own guess at its name is unsigned: escaped in the form.
  const page = await (await request(`/device?code=${started.user_code}`, { headers: { cookie } })).text();
  assert.match(page, /value="Browser &#34;2&#34;"/);

  assert.equal((await request(`/device?code=${started.user_code}`)).status, 302, "signed out: to the sign-in page");
  const approve = { code: started.user_code.toLowerCase(), decision: "approve", name: " Model Y ", kind: "car" };
  assert.equal((await decide(approve, { origin: "https://evil.test" })).status, 403);
  assert.equal((await decide(approve, { cookie: "" })).status, 401);
  assert.equal((await decide({ ...approve, kind: "toaster" })).status, 400);
  assert.equal((await decide(approve)).status, 200);

  const granted = await poll(started.device_code);
  assert.match(granted.access_token, /^ydt_/);
  const device = await getDevice(db, owner.id, granted.device_id);
  assert.deepEqual([device.name, device.kind], ["Model Y", "car"]);
  assert.deepEqual(await resolveDeviceToken(db, granted.access_token), { userId: owner.id, deviceId: device.id });
  assert.equal((await poll(started.device_code)).error, "invalid_grant", "single use");
  assert.equal((await decide(approve)).status, 400);
  await deleteDevice(db, owner.id, device.id);
  assert.equal(await resolveDeviceToken(db, granted.access_token), null);

  const denied = await authorize({ device_name: "Model Y", device_kind: "car" });
  await decide({ code: denied.user_code, decision: "deny" });
  assert.equal((await poll(denied.device_code)).error, "access_denied");
  const { user_code: userCode, device_code: deviceCode } = await authorize({ device_name: "Model Y", device_kind: "car" });
  const later = Date.now() + 10 * 60_000 + 1;
  await assert.rejects(decideDeviceCode(db, owner.id, normalizeUserCode(userCode), { approve: true }, later), /expired/);
  await assert.rejects(pollDeviceCode(db, deviceCode, later), (error) => error.oauth === "expired_token");
});

test("a paired screen's credential is not the owner: it removes only itself, renames nobody, and its stale rebuild is superseded; each route enforces its scope", async () => {
  const plane = createTestControlPlane();
  const self = await upsertDevice(plane.db, USER, { name: "Desk", kind: "browser", capabilities: {} });
  const other = await upsertDevice(plane.db, USER, { name: "Model Y", kind: "car", capabilities: {} });
  plane.transport.online.add(self.id);
  const v1 = (scopes, deviceId) => createV1App({ getContext: () => ({ services: plane.services, scopes, userId: USER, deviceId }), issueRealtimeTicket: async () => ({}) });
  const app = v1(["read", "control", "manage"], self.id);
  const request = async (method, path, body) => {
    const response = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request("DELETE", `/v1/devices/${other.id}`)).status, 403);
  assert.equal((await request("PATCH", `/v1/devices/${self.id}`, { name: "x" })).status, 403);
  await request("POST", "/v1/playback/play", { itemId: "library:5" });
  const stale = await request("POST", "/v1/playback/play", { itemId: "library:5", startTime: 1, reason: "recovery", sessionId: "ses_old" });
  assert.deepEqual([stale.status, stale.body.error.code], [409, "superseded"]);
  assert.deepEqual((await request("DELETE", "/v1/devices/self")).body, { deleted: self.id, revoked: true });
  assert.deepEqual((await plane.services.devices()).devices.map((device) => device.id), [other.id]);
  const reader = v1(["read"]);
  assert.equal((await reader.request("/v1/queue")).status, 200);
  for (const [method, path] of [["DELETE", "/v1/queue"], ["POST", "/v1/playback/pause"]]) assert.equal((await reader.request(path, { method })).status, 403, path);
});
