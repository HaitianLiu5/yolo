import assert from "node:assert/strict";
import { test } from "node:test";
import { createOwnerApp } from "../../src/api/owner.js";
import { createSession, SESSION_COOKIE } from "../../src/auth/session.js";
import { createDeviceCode, formatUserCode, pollDeviceCode, resolveDeviceToken } from "../../src/store/pairing.js";
import { addPasskey, listPasskeys } from "../../src/store/users.js";
import { createMemoryKv } from "../helpers/kv.js";
import { createTestControlPlane, USER } from "../helpers/setup.js";

// The owner's settings API (/v1/owner): only the passkey session reaches it,
// never a bearer token or a device credential, and only from Yolo's own
// pages.

const ORIGIN = "https://yolo.example.com";

// workers-oauth-provider's helpers, as much as the settings use.
function fakeOAuth() {
  const grants = new Map();
  const clients = new Map();
  return {
    grants,
    clients,
    async listUserGrants(userId, { limit = 100, cursor } = {}) {
      const mine = [...grants.values()].filter((grant) => grant.userId === userId);
      const start = cursor ? Number(cursor) : 0;
      const items = mine.slice(start, start + Math.min(limit, 2));
      return { items, ...(start + items.length < mine.length ? { cursor: String(start + items.length) } : {}) };
    },
    async revokeGrant(grantId, userId) {
      if (grants.get(grantId)?.userId === userId) grants.delete(grantId);
    },
    async lookupClient(clientId) {
      if (clientId.startsWith("https://broken.")) throw new Error("metadata document unavailable");
      return clients.get(clientId) ?? null;
    },
  };
}

async function harness() {
  const plane = createTestControlPlane();
  const kv = createMemoryKv();
  const oauth = fakeOAuth();
  const app = createOwnerApp({ servicesFor: () => plane.services, oauthFor: () => oauth });
  const env = { PUBLIC_ORIGIN: ORIGIN, DB: plane.db, OAUTH_KV: kv };
  const signedIn = (await createSession(kv, USER)).split(";")[0];
  // A request as Yolo's own page sends it, unless a test overrides a header.
  async function request(method, path, { body, cookie = signedIn, headers = {} } = {}) {
    const base = {
      "x-yolo-owner": "1",
      "sec-fetch-site": "same-origin",
      ...(method === "GET" ? {} : { origin: ORIGIN }),
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    };
    const merged = Object.fromEntries(Object.entries({ ...base, ...headers }).filter(([, value]) => value != null));
    const response = await app.request(`${ORIGIN}${path}`, { method, headers: merged, body: body ? JSON.stringify(body) : undefined }, env);
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { plane, kv, oauth, env, signedIn, request };
}

test("only the owner's passkey session reaches owner settings, never a device credential", async () => {
  const h = await harness();
  const signedOut = await h.request("GET", "/v1/owner/devices", { cookie: null });
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.body.error.code, "unauthorized");
  // A paired device's credential is a bearer token: not an owner session.
  const device = await h.request("GET", "/v1/owner/devices", { cookie: null, headers: { authorization: "Bearer ydt_device" } });
  assert.equal(device.status, 401);
  const stale = await h.request("GET", "/v1/owner/devices", { cookie: `${SESSION_COOKIE}=not-a-session` });
  assert.equal(stale.status, 401);
  // The session probe answers either way.
  assert.deepEqual((await h.request("GET", "/v1/owner/session", { cookie: null })).body, { signedIn: false });
  const probe = await h.request("GET", "/v1/owner/session");
  assert.deepEqual(probe.body, { signedIn: true });
  assert.equal(probe.headers.get("cache-control"), "no-store");
  assert.equal((await h.request("GET", "/v1/owner/devices")).status, 200);
});

test("owner requests from another site are refused, even with the session cookie", async () => {
  const h = await harness();
  // No X-Yolo-Owner: a form post or an <img> from another site.
  assert.equal((await h.request("GET", "/v1/owner/devices", { headers: { "x-yolo-owner": null } })).status, 403);
  assert.equal((await h.request("DELETE", "/v1/owner/devices/dev_x", { headers: { "x-yolo-owner": null } })).status, 403);
  // The browser says the request came from elsewhere.
  assert.equal((await h.request("GET", "/v1/owner/agents", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  // A change must name Yolo's own origin.
  const foreign = await h.request("PATCH", "/v1/owner/devices/dev_x", { body: { name: "Hacked" }, headers: { origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error.code, "forbidden");
  assert.equal((await h.request("POST", "/v1/owner/session/sign-out", { headers: { origin: null } })).status, 403);
});

test("the owner renames and removes devices; removing revokes the device's credential", async () => {
  const h = await harness();
  const { deviceCode, userCode } = await createDeviceCode(h.plane.db, USER, { name: "Browser", kind: "browser" });
  // This browser approves its own code: the owner is signed in on it.
  const approved = await h.request("POST", "/v1/owner/pairing/approve", { body: { userCode: formatUserCode(userCode), name: "Desk", kind: "browser" } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual([approved.body.name, approved.body.kind], ["Desk", "browser"]);
  const { token, deviceId } = await pollDeviceCode(h.plane.db, deviceCode);
  assert.equal(deviceId, approved.body.deviceId);
  // A code works once.
  assert.equal((await h.request("POST", "/v1/owner/pairing/approve", { body: { userCode } })).status, 400);
  assert.equal((await h.request("POST", "/v1/owner/pairing/approve", { body: { userCode: "nope" } })).status, 400);

  const listed = await h.request("GET", "/v1/owner/devices");
  assert.deepEqual(listed.body.devices.filter((device) => device.via === "realtime").map((device) => device.name), ["Desk"]);
  const renamed = await h.request("PATCH", `/v1/owner/devices/${deviceId}`, { body: { name: "Study Mac", kind: "browser" } });
  assert.equal(renamed.body.name, "Study Mac");
  assert.equal((await h.request("PATCH", `/v1/owner/devices/${deviceId}`, { body: { kind: "spaceship" } })).status, 400);

  assert.ok(await resolveDeviceToken(h.plane.db, token));
  const removed = await h.request("DELETE", `/v1/owner/devices/${deviceId}`);
  assert.deepEqual(removed.body, { deleted: deviceId, revoked: true });
  assert.equal(await resolveDeviceToken(h.plane.db, token), null);
  assert.deepEqual(h.plane.transport.closed.map((entry) => [entry.deviceId, entry.code]), [[deviceId, 4003]]);
});

test("connected agents are listed one per app and revoked with every grant they hold", async () => {
  const h = await harness();
  const grant = (id, clientId, fields = {}) => h.oauth.grants.set(id, {
    id, clientId, userId: USER, scope: ["read", "control"], createdAt: 1_760_000_000, redirectUri: "https://claude.ai/api/mcp/auth_callback", ...fields,
  });
  h.oauth.clients.set("client_claude", { clientId: "client_claude", clientName: "Claude" });
  grant("g1", "client_claude");
  grant("g2", "client_claude", { scope: ["manage"], createdAt: 1_760_100_000 });
  grant("g3", "https://chatgpt.example/oauth/client.json", { redirectUri: "https://chatgpt.example/cb" });
  grant("g4", "https://broken.example/client.json");
  grant("g5", "client_other", { userId: "usr_someone_else" });

  const { body } = await h.request("GET", "/v1/owner/agents");
  const claude = body.agents.find((agent) => agent.id === "client_claude");
  assert.deepEqual(
    { name: claude.name, scope: claude.scope, connections: claude.connections, redirectHosts: claude.redirectHosts, createdAt: claude.createdAt },
    { name: "Claude", scope: ["read", "control", "manage"], connections: 2, redirectHosts: ["claude.ai"], createdAt: 1_760_000_000_000 },
  );
  // A metadata-document client is known by its site; one whose document
  // cannot be fetched still lists.
  assert.equal(body.agents.find((agent) => agent.id.startsWith("https://chatgpt")).site, "chatgpt.example");
  assert.equal(body.agents.find((agent) => agent.id.startsWith("https://broken")).name, "broken.example");
  assert.equal(body.agents.length, 3, "another user's grants are not listed");

  const revoked = await h.request("DELETE", "/v1/owner/agents/client_claude");
  assert.deepEqual(revoked.body, { revoked: "client_claude", grants: 2 });
  assert.deepEqual([...h.oauth.grants.keys()].sort(), ["g3", "g4", "g5"]);
  const encoded = await h.request("DELETE", `/v1/owner/agents/${encodeURIComponent("https://chatgpt.example/oauth/client.json")}`);
  assert.equal(encoded.status, 200);
  assert.equal((await h.request("DELETE", "/v1/owner/agents/client_other")).status, 404);
});

test("passkeys are listed without their keys; the last one cannot be removed, and removing one signs out other sessions", async () => {
  const h = await harness();
  const key = { publicKey: "pk", counter: 0, transports: ["internal"], deviceType: "multiDevice" };
  await addPasskey(h.plane.db, USER, { id: "cred-phone", ...key, backedUp: true, name: "iPhone" });
  const listed = await h.request("GET", "/v1/owner/passkeys");
  assert.equal(listed.body.passkeys.length, 1);
  assert.deepEqual(Object.keys(listed.body.passkeys[0]).sort(), ["createdAt", "id", "lastUsedAt", "name", "synced"]);
  assert.equal(listed.body.passkeys[0].synced, true);
  const only = await h.request("DELETE", "/v1/owner/passkeys/cred-phone");
  assert.equal(only.status, 400);
  assert.match(only.body.error.message, /only passkey/);

  await addPasskey(h.plane.db, USER, { id: "cred-key", ...key, backedUp: false, name: "Security key" });
  const otherBrowser = (await createSession(h.kv, USER)).split(";")[0];
  const removed = await h.request("DELETE", "/v1/owner/passkeys/cred-key");
  assert.deepEqual(removed.body, { deleted: "cred-key" });
  assert.deepEqual((await listPasskeys(h.plane.db, USER)).map((passkey) => passkey.id), ["cred-phone"]);
  // This browser gets a new session; every other one is signed out.
  const fresh = removed.headers.get("set-cookie").split(";")[0];
  assert.equal((await h.request("GET", "/v1/owner/devices", { cookie: otherBrowser })).status, 401);
  assert.equal((await h.request("GET", "/v1/owner/devices", { cookie: fresh })).status, 200);
  assert.equal((await h.request("DELETE", "/v1/owner/passkeys/cred-missing", { cookie: fresh })).status, 404);
});

test("signing out ends the owner session", async () => {
  const h = await harness();
  const out = await h.request("POST", "/v1/owner/session/sign-out");
  assert.deepEqual(out.body, { signedIn: false });
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await h.request("GET", "/v1/owner/devices")).status, 401);
});
