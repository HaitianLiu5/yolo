import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthApp } from "../../src/auth/app.js";
import { DEVICE_GRANT_TYPE, deviceTokenRequest, withDeviceMetadata } from "../../src/auth/device.js";
import { createSession } from "../../src/auth/session.js";
import { getDevice, listDevices } from "../../src/store/devices.js";
import { deleteDevice } from "../../src/store/devices.js";
import { decideDeviceCode, normalizeUserCode, pollDeviceCode, resolveDeviceToken } from "../../src/store/pairing.js";
import { ensureOwner } from "../../src/store/users.js";
import { createTestD1 } from "../helpers/d1.js";
import { createFakeNode } from "../helpers/fakes.js";
import { createMemoryKv } from "../helpers/kv.js";

const ORIGIN = "https://yolo.example.com";

async function harness() {
  const db = createTestD1();
  const kv = createMemoryKv();
  const owner = await ensureOwner(db);
  const env = { PUBLIC_ORIGIN: ORIGIN, DB: db, OAUTH_KV: kv };
  const app = createAuthApp({ nodeClient: () => createFakeNode() });
  const cookie = (await createSession(kv, owner.id)).split(";")[0];
  const request = (path, init = {}) => app.request(path, init, env);
  const form = (fields) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields).toString(),
  });
  async function authorize(fields = { device_name: "Model Y", device_kind: "car" }) {
    const response = await request("/oauth/device_authorization", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
    });
    return { status: response.status, body: await response.json() };
  }
  async function poll(deviceCode) {
    const response = await deviceTokenRequest(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode, client_id: "yolo-tesla" }).toString(),
    }), env);
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
  }
  return { db, kv, env, owner, cookie, request, form, authorize, poll };
}

test("a device pairs with a QR code the signed-in owner approves (RFC 8628)", async () => {
  const h = await harness();
  const started = await h.authorize();
  assert.equal(started.status, 200);
  assert.match(started.body.user_code, /^[B-Z]{4}-[B-Z]{4}$/);
  assert.equal(started.body.verification_uri, `${ORIGIN}/device`);
  assert.equal(started.body.verification_uri_complete, `${ORIGIN}/device?code=${started.body.user_code}`);
  assert.equal(started.body.expires_in, 600);
  assert.equal(started.body.interval, 5);

  assert.equal((await h.poll(started.body.device_code)).body.error, "authorization_pending");
  assert.equal((await h.poll(started.body.device_code)).body.error, "slow_down", "polling faster than the interval");

  // The confirmation page shows the code to match against the screen, names
  // the device and its type, says when it asked, and needs Allow.
  const page = await h.request(`/device?code=${started.body.user_code}`, { headers: { cookie: h.cookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, new RegExp(`<span class="usercode">${started.body.user_code}</span>`));
  assert.match(html, /name="name" value="Model Y"/);
  assert.match(html, /<input type="radio" name="kind" value="car" checked>/);
  assert.match(html, /<time datetime=/);
  assert.match(html, /value="approve">Allow/);

  // Allowed: what happens next, on the screen that was paired.
  const allowed = await h.request("/device", h.form({ code: started.body.user_code.toLowerCase(), decision: "approve" }));
  assert.equal(allowed.status, 200);
  const done = await allowed.text();
  assert.match(done, /Model Y is paired/);
  assert.match(done, /Go back to the car\. It continues by itself\./);

  const granted = await h.poll(started.body.device_code);
  assert.equal(granted.status, 200);
  assert.equal(granted.cacheControl, "no-store");
  assert.match(granted.body.access_token, /^ydt_/);
  assert.equal(granted.body.token_type, "Bearer");
  const device = await getDevice(h.db, h.owner.id, granted.body.device_id);
  assert.deepEqual([device.name, device.kind], ["Model Y", "car"]);
  assert.deepEqual(await resolveDeviceToken(h.db, granted.body.access_token), { userId: h.owner.id, deviceId: device.id });

  // Single use: neither the device code nor the user code works again.
  assert.equal((await h.poll(started.body.device_code)).body.error, "invalid_grant");
  const again = await h.request("/device", h.form({ code: started.body.user_code, decision: "approve" }));
  assert.equal(again.status, 400);
  assert.equal((await listDevices(h.db, h.owner.id)).length, 1);

  // Removing the device revokes the credential at once.
  await deleteDevice(h.db, h.owner.id, device.id);
  assert.equal(await resolveDeviceToken(h.db, granted.body.access_token), null);
});

test("approval needs the owner's session, the Allow button and a same-origin post", async () => {
  const h = await harness();
  const { body } = await h.authorize();
  const signedOut = await h.request(`/device?code=${body.user_code}`);
  assert.equal(signedOut.status, 302);
  assert.equal(signedOut.headers.get("location"), `/login?next=${encodeURIComponent(`/device?code=${body.user_code}`)}`);
  const crossSite = await h.request("/device", { ...h.form({ code: body.user_code, decision: "approve" }), headers: { ...h.form({}).headers, origin: "https://evil.test" } });
  assert.equal(crossSite.status, 403);
  const noCookie = await h.request("/device", { ...h.form({ code: body.user_code, decision: "approve" }), headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN } });
  assert.equal(noCookie.status, 401);

  const denied = await h.request("/device", h.form({ code: body.user_code, decision: "deny" }));
  assert.match(await denied.text(), /Model Y was not paired/);
  assert.equal((await h.poll(body.device_code)).body.error, "access_denied");
  assert.equal((await listDevices(h.db, h.owner.id)).length, 0);
});

test("codes expire after 10 minutes", async () => {
  const h = await harness();
  const { body } = await h.authorize();
  const later = Date.now() + 10 * 60 * 1000 + 1;
  await assert.rejects(decideDeviceCode(h.db, h.owner.id, normalizeUserCode(body.user_code), { approve: true }, later), /expired/);
  await assert.rejects(pollDeviceCode(h.db, body.device_code, later), (error) => error.oauth === "expired_token");
  const page = await h.request("/device?code=ZZZZ-ZZZZ", { headers: { cookie: h.cookie } });
  assert.equal(page.status, 404);
});

test("pairing needs an owner, and metadata advertises the device grant", async () => {
  const db = createTestD1();
  const app = createAuthApp({ nodeClient: () => createFakeNode() });
  const response = await app.request("/oauth/device_authorization", { method: "POST" }, { PUBLIC_ORIGIN: ORIGIN, DB: db, OAUTH_KV: createMemoryKv() });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error_description, /not set up/);

  const metadata = await withDeviceMetadata(Response.json({ issuer: ORIGIN, grant_types_supported: ["authorization_code"] }), { PUBLIC_ORIGIN: ORIGIN }, new Request(ORIGIN));
  const body = await metadata.json();
  assert.equal(body.device_authorization_endpoint, `${ORIGIN}/oauth/device_authorization`);
  assert.deepEqual(body.grant_types_supported, ["authorization_code", DEVICE_GRANT_TYPE]);
  // Other grants are left to the OAuth provider.
  assert.equal(await deviceTokenRequest(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&code=x",
  }), {}), null);
});

test("the owner names the device and picks its type before allowing it", async () => {
  const h = await harness();
  // What the car's browser guesses about itself since Tesla 2026.26.
  const { body } = await h.authorize({ device_name: "Browser", device_kind: "browser" });
  const html = await (await h.request(`/device?code=${body.user_code}`, { headers: { cookie: h.cookie } })).text();
  // The guess appears once, as the editable name and the chosen type.
  assert.match(html, /<input type="text" name="name" value="Browser"/);
  assert.match(html, /<input type="radio" name="kind" value="browser" checked>/);
  for (const kind of ["car", "phone", "tv", "other"]) assert.match(html, new RegExp(`<input type="radio" name="kind" value="${kind}">`));
  assert.equal(html.match(/Browser/g).length, 2, "the name field and the type's label");
  assert.match(html, /value="deny" formnovalidate/);

  const allowed = await h.request("/device", h.form({ code: body.user_code, decision: "approve", name: "  Model Y  ", kind: "car" }));
  const paired = await allowed.text();
  assert.match(paired, /Model Y is paired/);
  assert.match(paired, /Go back to the car/);
  const granted = await h.poll(body.device_code);
  const device = await getDevice(h.db, h.owner.id, granted.body.device_id);
  assert.deepEqual([device.name, device.kind], ["Model Y", "car"]);

  // The device's hellos keep the owner's choice.
  const { updateDevice } = await import("../../src/store/devices.js");
  await updateDevice(h.db, h.owner.id, device.id, { name: "Browser", kind: "browser", capabilities: {} });
  const after = await getDevice(h.db, h.owner.id, device.id);
  assert.deepEqual([after.name, after.kind], ["Model Y", "car"]);

  // A blank name keeps the device's guess; an unknown type is refused.
  const second = await h.authorize({ device_name: "Browser", device_kind: "browser" });
  const refused = await h.request("/device", h.form({ code: second.body.user_code, decision: "approve", name: "", kind: "toaster" }));
  assert.equal(refused.status, 400);
  await h.request("/device", h.form({ code: second.body.user_code, decision: "approve", name: " ", kind: "" }));
  const guessed = await getDevice(h.db, h.owner.id, (await h.poll(second.body.device_code)).body.device_id);
  assert.deepEqual([guessed.name, guessed.kind], ["Browser", "browser"]);
});
