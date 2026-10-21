import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { sealImageLink, verifyMediaToken, YoloError } from "@useyolo/core";
import { createOwnerApp } from "../../src/api/owner.js";
import { createAuthApp } from "../../src/auth/app.js";
import { consentPage, DARK_TOKENS, messagePage, safeNextPath } from "../../src/auth/pages.js";
import { createSession, getSession, SESSION_COOKIE } from "../../src/auth/session.js";
import { HubCore } from "../../src/hub/hub-core.js";
import { createImageLinks, serveImageLink } from "../../src/image-links.js";
import { handleRealtime, issueRealtimeTicket } from "../../src/realtime.js";
import { serveShareLink } from "../../src/share-links.js";
import { listHistory } from "../../src/store/history.js";
import { writeMediaSettings } from "../../src/store/media-settings.js";
import { imageLinkVersion } from "../../src/store/image-links.js";
import { addPasskey, ensureOwner, listPasskeys } from "../../src/store/users.js";
import { createTestD1 } from "../helpers/d1.js";
import { createFakeNode, createFakeTransport, createMemoryKv, createMemoryStorage, createTestControlPlane, USER } from "../helpers/fakes.js";

const ORIGIN = "https://yolo.example.com";

// A software authenticator: a fresh P-256 passkey with a "none" attestation.
function createCredential(options) {
  const { x, y } = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  const coseKey = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, isoBase64URL.toBuffer(x)], [-3, isoBase64URL.toBuffer(y)]]));
  const credentialId = randomBytes(16);
  const authData = Buffer.concat([createHash("sha256").update(options.rp.id).digest(), Buffer.from([0x45]), Buffer.alloc(20), Buffer.from([0, 16]), credentialId, coseKey]);
  const attestationObject = isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)]]));
  const clientDataJSON = isoBase64URL.fromUTF8String(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
  const id = isoBase64URL.fromBuffer(credentialId);
  return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON, attestationObject: isoBase64URL.fromBuffer(attestationObject) } };
}

// The auth app over a node holding one owner code (service/node/src/owner-code.js), and one browser's cookies.
function signInHarness() {
  const node = createFakeNode();
  node.code = "123456";
  for (const step of ["verify", "consume"]) {
    node.routes[`POST /internal/v1/owner-code/${step}`] = ({ code }) => {
      if (!node.code || code !== node.code) throw new YoloError("forbidden", "Wrong pairing code");
      if (step === "consume") node.code = null;
      return { ok: true };
    };
  }
  const db = createTestD1();
  const kv = createMemoryKv();
  const app = createAuthApp({ nodeClient: () => node });
  const cookies = new Map();
  async function post(path, body) {
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }, { PUBLIC_ORIGIN: ORIGIN, DB: db, OAUTH_KV: kv });
    const [name, ...value] = (response.headers.get("set-cookie") ?? "").split(";")[0].split("=");
    if (name) cookies.set(name, value.join("="));
    return { status: response.status, body: await response.json() };
  }
  async function register(code) {
    const options = await post("/auth/passkey/register/options", { code });
    const credential = options.status === 200 && createCredential(options.body);
    return { options, credential, verify: credential && await post("/auth/passkey/register/verify", { code, response: credential }) };
  }
  const session = () => getSession(kv, new Request(ORIGIN, { headers: { cookie: `${SESSION_COOKIE}=${cookies.get(SESSION_COOKIE)}` } }));
  const sessions = () => [...kv.map.keys()].filter((key) => key.startsWith("yolo:session:")).length;
  return { db, kv, node, cookies, post, register, session, sessions };
}

test("the node's 6-digit code registers the first passkey once, and neither the code nor the cookie is stored in Cloudflare", async () => {
  const h = signInHarness();
  for (const code of [undefined, "12345", "abcdef"]) assert.equal((await h.post("/auth/passkey/register/options", { code })).status, 400);
  assert.equal((await h.post("/auth/passkey/register/options", { code: "654321" })).status, 403);
  const { options, verify, credential } = await h.register(" 123 456 ");
  assert.equal(options.body.authenticatorSelection.userVerification, "required");
  assert.equal(verify.status, 200);
  assert.deepEqual(h.node.calls.map(({ path }) => path.split("/").at(-1)), ["verify", "verify", "consume"], "malformed codes never reach the node");
  const owner = await ensureOwner(h.db);
  assert.deepEqual((await listPasskeys(h.db, owner.id)).map((passkey) => passkey.id), [credential.id]);
  assert.equal((await h.session()).userId, owner.id);
  const stored = JSON.stringify([...h.kv.map]);
  assert.ok(!stored.includes("123456") && !stored.includes(h.cookies.get(SESSION_COOKIE)), "the challenge holds no code; sessions are keyed by a hash");
  assert.equal((await h.register("123456")).options.status, 403, "the code is used up");
});

test("a code that dies before verify saves nothing; a code with passkeys present is a reset; a signed-in owner adds one without a code", async () => {
  const h = signInHarness();
  const owner = await ensureOwner(h.db);
  const options = await h.post("/auth/passkey/register/options", { code: "123456" });
  h.node.code = "999999";
  assert.equal((await h.post("/auth/passkey/register/verify", { code: "123456", response: createCredential(options.body) })).status, 403);
  assert.deepEqual([(await listPasskeys(h.db, owner.id)).length, h.cookies.has(SESSION_COOKIE)], [0, false]);

  await addPasskey(h.db, owner.id, { id: "old-phone", publicKey: "x", counter: 0, transports: ["internal"] });
  for (let i = 0; i < 3; i += 1) await createSession(h.kv, owner.id);
  const reset = await h.register("999999");
  assert.deepEqual((await listPasskeys(h.db, owner.id)).map((passkey) => passkey.id), [reset.credential.id]);
  assert.equal(h.sessions(), 1, "only the session just created survives");

  const added = await h.register();
  assert.equal(added.verify.status, 200);
  assert.equal((await listPasskeys(h.db, owner.id)).length, 2);
  assert.equal(h.sessions(), 2);
});

test("a realtime ticket names its Hub, works once, and a client's own identity headers never pass", async () => {
  const core = new HubCore({ userId: "usr_1", storage: createMemoryStorage(), db: null, node: null, transport: createFakeTransport() });
  const forwarded = [];
  const hex = Buffer.from("usr_1").toString("hex").padEnd(64, "0");
  const stub = {
    call: async (_userId, method, args) => ({ ok: true, value: await core[method](...args) }),
    fetch: async (request) => {
      forwarded.push(request.headers);
      const redeemed = await core.redeemTicket(request.headers.get("x-yolo-ticket"));
      return Response.json(redeemed, { status: redeemed ? 200 : 401 });
    },
  };
  const HUB = { idFromName: () => ({ toString: () => hex }), idFromString: (id) => { if (id !== hex) throw new TypeError("Invalid Durable Object ID"); return {}; }, get: () => stub };
  const env = { HUB, OAUTH_KV: { ...createMemoryKv(), put: () => assert.fail("a realtime ticket wrote KV") } };
  const upgrade = (ticket, headers = {}) => handleRealtime(new Request(`${ORIGIN}/v1/realtime?ticket=${encodeURIComponent(ticket)}`, { headers: { upgrade: "websocket", ...headers } }), env);
  const { ticket } = await issueRealtimeTicket(env, "usr_1", { deviceId: "dev_car" });
  assert.deepEqual(await (await upgrade(ticket, { "x-yolo-device": "dev_other", "x-yolo-user": "usr_2" })).json(), { deviceId: "dev_car" });
  assert.deepEqual([forwarded[0].get("x-yolo-device"), forwarded[0].get("x-yolo-user")], [null, null]);
  for (const bad of [ticket, "", ticket.split(".")[1], `${"ab".repeat(32)}.${ticket.split(".")[1]}`]) assert.equal((await upgrade(bad)).status, 401, bad);
  assert.equal(forwarded.length, 2, "a ticket naming no Hub of this Worker reaches none");
});

test("after sign-in a page goes only to a path on its own origin, and pages escape what they show", async () => {
  const nextOf = (raw) => safeNextPath(new URLSearchParams(`next=${raw}`).get("next"), ORIGIN);
  for (const raw of ["/%5Cevil.example", "/%09/evil.example", "%2F%2Fevil.example", "/..//evil.example", "https://evil.example/", "javascript:alert(1)"]) {
    assert.equal(nextOf(raw), null, raw);
  }
  assert.equal(nextOf("%2Fdevice%3Fcode%3DABCD-EFGH"), "/device?code=ABCD-EFGH");
  const consent = consentPage({ clientName: "<script>alert(1)</script>", redirectHost: "127.0.0.1", redirectIsLoopback: true, scope: ["read"] }, "h1");
  assert.doesNotMatch(consent, /<script>alert/);
  assert.doesNotMatch(await messagePage("Cannot <pair>", "Code <b>x</b>", 400).text(), /<b>|<pair>/);
});

test("owner settings take only the passkey session, from Yolo's own pages", async () => {
  const plane = createTestControlPlane();
  const kv = createMemoryKv();
  const app = createOwnerApp({ servicesFor: () => plane.services, oauthFor: () => ({}), log: () => {}, checkWan: async () => null });
  const signedIn = (await createSession(kv, USER)).split(";")[0];
  const request = async (method, path, headers = {}) => {
    const base = { "x-yolo-owner": "1", "sec-fetch-site": "same-origin", origin: ORIGIN, cookie: signedIn };
    const merged = Object.fromEntries(Object.entries({ ...base, ...headers }).filter(([, value]) => value != null));
    const response = await app.request(`${ORIGIN}${path}`, { method, headers: merged }, { PUBLIC_ORIGIN: ORIGIN, DB: plane.db, OAUTH_KV: kv });
    return { status: response.status, cookie: response.headers.get("set-cookie") };
  };
  assert.equal((await request("GET", "/v1/owner/devices")).status, 200);
  for (const headers of [{ cookie: null }, { cookie: null, authorization: "Bearer ydt_device" }, { cookie: `${SESSION_COOKIE}=forged` }]) {
    assert.equal((await request("GET", "/v1/owner/devices", headers)).status, 401, JSON.stringify(headers));
  }
  for (const headers of [{ "x-yolo-owner": null }, { "sec-fetch-site": "cross-site" }, { origin: "https://evil.example" }, { origin: null }]) {
    assert.equal((await request("DELETE", "/v1/owner/devices/dev_x", headers)).status, 403, JSON.stringify(headers));
  }
  // The last passkey stays; removing another signs out every other session.
  const key = { publicKey: "pk", counter: 0, transports: ["internal"] };
  await addPasskey(plane.db, USER, { id: "phone", ...key });
  assert.equal((await request("DELETE", "/v1/owner/passkeys/phone")).status, 400);
  await addPasskey(plane.db, USER, { id: "key", ...key });
  const other = (await createSession(kv, USER)).split(";")[0];
  const removed = await request("DELETE", "/v1/owner/passkeys/key");
  assert.equal((await request("GET", "/v1/owner/devices", { cookie: other })).status, 401);
  assert.equal((await request("GET", "/v1/owner/devices", { cookie: removed.cookie.split(";")[0] })).status, 200);
});

test("an agent's image link (/i/*, no credential) is no open proxy: a forged or tampered link never reaches the node, and only a raster picture is served", async () => {
  const plane = createTestControlPlane();
  const SECRET = "test-node-secret-of-enough-length";
  const ARTWORK = "/v1/library/items/library%3A42/artwork?variant=poster";
  const calls = [];
  let type = "image/png";
  const services = { artwork: async (...args) => (calls.push(args), new Response("x", { headers: { "content-type": type } })) };
  const get = (url, init) => serveImageLink(new Request(url, init), { NODE_SECRET: SECRET, DB: plane.db, PUBLIC_ORIGIN: ORIGIN }, { servicesFor: () => services });
  const link = await createImageLinks({ secret: SECRET, origin: ORIGIN, userId: USER, version: () => imageLinkVersion(plane.db, USER, { fresh: true }) }).link(ARTWORK);
  const token = Buffer.from(link.slice(`${ORIGIN}/i/`.length), "base64url");
  const flip = (at) => `${ORIGIN}/i/${Buffer.from(token.map((byte, index) => (index === at ? byte ^ 1 : byte))).toString("base64url")}`;
  const evil = JSON.stringify([USER, "u", "https://evil.example/x.png"]);
  for (const url of [
    flip(4), flip(5), flip(token.length - 1),
    `${ORIGIN}/i/${await sealImageLink("an attacker's secret of some length", 1, evil)}`,
    `${ORIGIN}/i/${Buffer.from(evil).toString("base64url")}`,
    `${ORIGIN}/i/${await sealImageLink(SECRET, 1, JSON.stringify([USER, "u", "file:///etc/passwd"]))}`,
  ]) {
    assert.equal((await get(url)).status, 404, url);
  }
  assert.equal((await get(link, { method: "POST" })).status, 405);
  assert.deepEqual(calls, []);
  const served = await get(link);
  assert.deepEqual([served.status, served.headers.get("x-content-type-options"), calls.length], [200, "nosniff", 1]);
  type = "image/svg+xml";
  assert.equal((await get(link)).status, 502, "an SVG from Yolo's origin could run script");
});

test("a share link plays its one item for a friend without a credential and leaves the owner's playback alone, until it expires or is revoked", async () => {
  const plane = createTestControlPlane();
  const SECRET = "test-node-secret-of-enough-length";
  plane.node.routes["DELETE /internal/v1/shares/*"] = () => ({ stopped: 1 });
  const env = { NODE_SECRET: SECRET, DB: plane.db, PUBLIC_ORIGIN: ORIGIN, OAUTH_KV: createMemoryKv() };
  const call = async (path, { method = "GET", body, now } = {}) => {
    const init = { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) };
    const response = await serveShareLink(new Request(`${ORIGIN}${path}`, init), env, { node: plane.node, log: () => {}, ...(now ? { now } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const prepares = () => plane.node.calls.filter(({ method, path }) => method === "POST" && path === "/internal/v1/prepare");

  const shared = await plane.services.share({ itemId: "library:7" });
  const token = shared.url.slice("/s/".length);
  assert.equal(shared.title, "Movie 7");
  const page = await call(`/v1/share/${token}`);
  assert.deepEqual([page.status, page.body.item.title, page.body.item.source.plugin, page.body.media], [200, "Movie 7", "share", { paths: [], relayMode: "auto" }]);

  // The friend's stream: prepared for this link, on the relay, with a media
  // token for the owner's media; nothing on the owner's screens or in history.
  const first = await call(`/v1/share/${token}/stream`, { method: "POST", body: { startTime: 30, capabilities: {}, network: "lan" } });
  assert.equal(first.status, 200);
  const [prepared] = prepares();
  assert.deepEqual([prepared.body.share, prepared.body.network, prepared.body.source.id, prepared.body.startTime], [shared.id, "relay", "7", 30]);
  assert.equal((await verifyMediaToken(SECRET, prepared.body.mediaToken))?.userId, USER);
  assert.equal(first.body.stream.thumbnail, null, "the node's cover is an owner route");
  assert.deepEqual([(await plane.hub.getState()).status, (await listHistory(plane.db, USER)).length], ["idle", 0]);
  const rebuilt = await call(`/v1/share/${token}/stream`, { method: "POST", body: { reason: "recovery", sessionId: first.body.stream.sessionId } });
  assert.deepEqual([rebuilt.status, prepares()[1].body.replaces], [200, first.body.stream.sessionId]);
  assert.equal((await plane.services.shareLinks()).links[0].plays, 1, "a rebuild is no new play");

  // With the relay off, a friend without remote direct play gets nothing.
  await writeMediaSettings(plane.db, USER, { relayMode: "off" });
  assert.equal((await call(`/v1/share/${token}/stream`, { method: "POST", body: {} })).status, 409);
  await writeMediaSettings(plane.db, USER, { relayMode: "auto" });

  for (const path of [`/v1/share/${"A".repeat(22)}`, "/v1/share/short", `/v1/share/${token}/other`]) assert.equal((await call(path)).status, 404, path);
  assert.equal((await call(`/v1/share/${token}/stream`)).status, 405);
  assert.equal((await call(`/v1/share/${token}`, { now: Date.now() + 8 * 24 * 60 * 60_000 })).status, 410);
  const revoked = await plane.services.revokeShareLink(shared.id);
  assert.equal(revoked.stopped, 1, "the node stops the link's streams");
  const after = await call(`/v1/share/${token}/stream`, { method: "POST", body: {} });
  assert.deepEqual([after.status, prepares().length], [410, 2]);
  assert.equal((await plane.services.shareLinks()).links[0].status, "revoked");
});

// The pages inline their CSS (Agent Note 2026-10-12-owner-web-pages), so this
// keeps their dark tokens equal to Yolo Web's.
test("the owner pages share Yolo Web's dark tokens", async () => {
  const css = await readFile(new URL("../../../../clients/player/src/style.css", import.meta.url), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  const value = (name) => new RegExp(`${name}:\\s*([^;]+);`).exec(root)?.[1].trim();
  const pairs = {
    "--bg": "--surface-base", "--surface": "--surface-raised", "--tile": "--surface-tile", "--fg": "--text-primary", "--fg-2": "--text-secondary",
    "--fg-3": "--text-tertiary", "--line": "--hairline", "--danger": "--danger", "--ok": "--ok", "--press": "--press", "--hover": "--hover",
  };
  for (const [page, client] of Object.entries(pairs)) assert.equal(DARK_TOKENS[page], value(client), `${page} = Yolo Web's ${client}`);
});
