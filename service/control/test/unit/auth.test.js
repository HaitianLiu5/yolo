import assert from "node:assert/strict";
import { test } from "node:test";
import { YoloError } from "@useyolo/core";
import { createAuthApp } from "../../src/auth/app.js";
import { CHALLENGE_COOKIE } from "../../src/auth/passkeys.js";
import { createSession, destroySession, getSession, SESSION_COOKIE } from "../../src/auth/session.js";
import { handleRealtime, issueRealtimeTicket } from "../../src/realtime.js";
import { HubCore } from "../../src/hub/hub-core.js";
import { addPasskey, ensureOwner, listPasskeys } from "../../src/store/users.js";
import { consentPage, loginPage, messagePage } from "../../src/auth/pages.js";
import { createTestD1 } from "../helpers/d1.js";
import { createFakeNode, createFakeTransport, createMemoryStorage } from "../helpers/fakes.js";
import { createMemoryKv } from "../helpers/kv.js";
import { createCredential } from "../helpers/webauthn.js";

const ORIGIN = "https://yolo.example.com";
const env = { PUBLIC_ORIGIN: ORIGIN };

// A node holding one pairing code, with the verify / consume semantics of
// service/node/src/owner-code.js (issuing is not reachable from here).
function pairingNode(code = "123456") {
  const node = createFakeNode();
  node.code = code;
  const check = ({ code: given }) => {
    if (!node.code) throw new YoloError("forbidden", "No pairing code is active");
    if (given !== node.code) throw new YoloError("forbidden", "Wrong pairing code; 4 tries left");
  };
  node.routes["POST /internal/v1/owner-code/verify"] = (body) => {
    check(body);
    return { ok: true };
  };
  node.routes["POST /internal/v1/owner-code/consume"] = (body) => {
    check(body);
    node.code = null;
    return { ok: true };
  };
  return node;
}

// The auth app over a fake node, plus a cookie jar for one browser.
function signInHarness(node = pairingNode()) {
  const db = createTestD1();
  const kv = createMemoryKv();
  const app = createAuthApp({ nodeClient: () => node });
  const bindings = { ...env, DB: db, OAUTH_KV: kv };
  const cookies = new Map();
  async function post(path, body) {
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }, bindings);
    const set = response.headers.get("set-cookie");
    if (set) {
      const [name, ...value] = set.split(";")[0].split("=");
      cookies.set(name, value.join("="));
    }
    return { status: response.status, body: await response.json() };
  }
  // Options, a software passkey, then verify; returns both responses.
  async function register({ code, verifyCode = code } = {}) {
    const options = await post("/auth/passkey/register/options", { code });
    if (options.status !== 200) return { options };
    const credential = createCredential(options.body, ORIGIN);
    const verify = await post("/auth/passkey/register/verify", { code: verifyCode, response: credential });
    return { options, verify, credential };
  }
  return { app, db, kv, node, bindings, cookies, post, register };
}

const sessionKeys = (kv) => [...kv.map.keys()].filter((key) => key.startsWith("yolo:session:"));

test("the setup page asks for a 6-digit code from npm run owner-code", () => {
  for (const hasPasskey of [false, true]) {
    const html = loginPage({ hasPasskey });
    assert.match(html, /inputmode="numeric"/);
    assert.match(html, /autocomplete="one-time-code"/);
    assert.match(html, /pattern="\[0-9\]\{6\}" maxlength="6"/);
    assert.match(html, /npm run owner-code/);
  }
});

test("first setup: the node verifies the code, then consumes it once the passkey checks out", async () => {
  const h = signInHarness();
  const { options, verify, credential } = await h.register({ code: " 123 456 " });
  assert.equal(options.status, 200);
  assert.equal(options.body.rp.id, "yolo.example.com");
  assert.equal(options.body.authenticatorSelection.userVerification, "required");
  assert.equal(verify.status, 200);
  assert.deepEqual(h.node.calls.map(({ path, body }) => [path, body.code]), [
    ["/internal/v1/owner-code/verify", "123456"],
    ["/internal/v1/owner-code/consume", "123456"],
  ]);
  const owner = await ensureOwner(h.db);
  assert.deepEqual((await listPasskeys(h.db, owner.id)).map((passkey) => passkey.id), [credential.id]);
  const signedIn = new Request(ORIGIN, { headers: { cookie: `${SESSION_COOKIE}=${h.cookies.get(SESSION_COOKIE)}` } });
  assert.equal((await getSession(h.kv, signedIn)).userId, owner.id);
  // The code is used up.
  assert.equal((await h.register({ code: "123456" })).options.status, 403);
});

test("the code is never stored in Cloudflare", async () => {
  const h = signInHarness();
  await h.post("/auth/passkey/register/options", { code: "123456" });
  const challenges = [...h.kv.map].filter(([key]) => key.startsWith("yolo:webauthn:"));
  assert.equal(challenges.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(challenges[0][1])).sort(), ["challenge", "exp", "kind", "userId", "viaCode"]);
  const table = h.db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'init_codes_used'").get();
  assert.equal(table, undefined, "migration 0002 drops the old init code table");
});

test("a wrong or malformed code gets no challenge", async () => {
  const h = signInHarness();
  const wrong = await h.post("/auth/passkey/register/options", { code: "654321" });
  assert.equal(wrong.status, 403);
  assert.match(wrong.body.error.message, /Wrong pairing code; 4 tries left/);
  for (const code of [undefined, "", "12345", "1234567", "abcdef"]) {
    const response = await h.post("/auth/passkey/register/options", { code });
    assert.equal(response.status, 400, String(code));
    assert.match(response.body.error.message, /6-digit code/);
  }
  assert.equal(h.node.calls.length, 1, "malformed codes never reach the node");
  assert.equal(h.cookies.has(CHALLENGE_COOKIE), false);
});

test("setup says clearly when the home node is offline or too old", async () => {
  const h = signInHarness();
  h.node.offline = true;
  const offline = await h.post("/auth/passkey/register/options", { code: "123456" });
  assert.equal(offline.status, 503);
  assert.match(offline.body.error.message, /needs the home media node online/);

  const old = signInHarness(createFakeNode());
  const outdated = await old.post("/auth/passkey/register/options", { code: "123456" });
  assert.equal(outdated.status, 503);
  assert.match(outdated.body.error.message, /Update and restart it/);
});

test("a code that dies before verify saves no passkey", async () => {
  const h = signInHarness();
  const options = await h.post("/auth/passkey/register/options", { code: "123456" });
  h.node.code = "999999"; // Reissued on the home machine meanwhile.
  const verify = await h.post("/auth/passkey/register/verify", { code: "123456", response: createCredential(options.body, ORIGIN) });
  assert.equal(verify.status, 403);
  assert.equal((await listPasskeys(h.db, (await ensureOwner(h.db)).id)).length, 0);
  assert.equal(h.cookies.has(SESSION_COOKIE), false);
});

test("a code registration with passkeys present is a reset: other passkeys and sessions go", async () => {
  const h = signInHarness();
  const owner = await ensureOwner(h.db);
  await addPasskey(h.db, owner.id, { id: "old-phone", publicKey: "x", counter: 0, transports: ["internal"] });
  await addPasskey(h.db, owner.id, { id: "old-laptop", publicKey: "x", counter: 0, transports: ["hybrid"] });
  for (let i = 0; i < 3; i += 1) await createSession(h.kv, owner.id);
  await h.kv.put("token:unrelated", "kept");

  const { options, verify, credential } = await h.register({ code: "123456" });
  assert.deepEqual(options.body.excludeCredentials, [], "the authenticator may overwrite an old passkey");
  assert.equal(verify.status, 200);
  assert.deepEqual((await listPasskeys(h.db, owner.id)).map((passkey) => passkey.id), [credential.id]);
  assert.equal(sessionKeys(h.kv).length, 1, "only the session just created survives");
  const signedIn = new Request(ORIGIN, { headers: { cookie: `${SESSION_COOKIE}=${h.cookies.get(SESSION_COOKIE)}` } });
  assert.equal((await getSession(h.kv, signedIn)).userId, owner.id);
  assert.equal(await h.kv.get("token:unrelated"), "kept");
});

test("a signed-in owner adds a passkey without a code and keeps the others", async () => {
  const h = signInHarness();
  const owner = await ensureOwner(h.db);
  await addPasskey(h.db, owner.id, { id: "phone", publicKey: "x", counter: 0, transports: ["internal"] });
  await createSession(h.kv, owner.id); // Another device.
  const cookie = (await createSession(h.kv, owner.id)).split(";")[0].split("=");
  h.cookies.set(cookie[0], cookie.slice(1).join("="));

  const { options, verify, credential } = await h.register({});
  assert.equal(verify.status, 200);
  assert.deepEqual(options.body.excludeCredentials.map((item) => item.id), ["phone"]);
  assert.equal(h.node.calls.length, 0);
  assert.deepEqual((await listPasskeys(h.db, owner.id)).map((passkey) => passkey.id).sort(), [credential.id, "phone"].sort());
  assert.equal(sessionKeys(h.kv).length, 3);
});

test("sessions live in KV under a hash of the cookie", async () => {
  const kv = createMemoryKv();
  const setCookie = await createSession(kv, "usr_1");
  const value = setCookie.split(";")[0].slice(SESSION_COOKIE.length + 1);
  assert.equal([...kv.map.keys()].some((key) => key.includes(value)), false);
  const withCookie = new Request("https://x.test", { headers: { cookie: `${SESSION_COOKIE}=${value}` } });
  assert.equal((await getSession(kv, withCookie)).userId, "usr_1");
  await destroySession(kv, withCookie);
  assert.equal(await getSession(kv, withCookie), null);
});

// The HUB namespace with one HubCore per name: ids from idFromName are
// 64 hex characters, and idFromString accepts only those, as the runtime does.
function hubNamespace() {
  const cores = new Map();
  const forwarded = [];
  const idFor = (name) => ({ name, toString: () => Buffer.from(name).toString("hex").padEnd(64, "0") });
  const ids = new Map();
  const namespace = {
    forwarded,
    idFromName(name) {
      const id = idFor(name);
      ids.set(id.toString(), id);
      return id;
    },
    idFromString(hex) {
      if (!ids.has(hex)) throw new TypeError("Invalid Durable Object ID");
      return ids.get(hex);
    },
    get(id) {
      if (!cores.has(id.name)) cores.set(id.name, new HubCore({ userId: id.name, storage: createMemoryStorage(), db: null, node: null, transport: createFakeTransport() }));
      const core = cores.get(id.name);
      return {
        call: async (_userId, method, args) => ({ ok: true, value: await core[method](...args) }),
        fetch: async (request) => {
          forwarded.push({ hub: id.name, request });
          const redeemed = await core.redeemTicket(request.headers.get("x-yolo-ticket"));
          return Response.json(redeemed, { status: redeemed ? 200 : 401 });
        },
      };
    },
  };
  return namespace;
}

test("a realtime ticket lives in its Hub, which the ticket names, and never in KV", async () => {
  const noWrites = { ...createMemoryKv(), put: async () => assert.fail("a realtime ticket wrote KV") };
  const hubs = hubNamespace();
  const realtimeEnv = { HUB: hubs, OAUTH_KV: noWrites };
  const upgrade = (ticket, headers = {}) => new Request(`https://x.test/v1/realtime?ticket=${encodeURIComponent(ticket)}`, { headers: { upgrade: "websocket", ...headers } });

  const { ticket, expiresAt } = await issueRealtimeTicket(realtimeEnv, "usr_1", { deviceId: "dev_car" });
  assert.ok(expiresAt > Date.now());
  const [hubId, secret] = ticket.split(".");
  assert.equal(hubId, hubs.idFromName("usr_1").toString());
  // The Hub redeems it once; a client's own device header never passes.
  const first = await handleRealtime(upgrade(ticket, { "x-yolo-device": "dev_other", "x-yolo-user": "usr_2" }), realtimeEnv);
  assert.deepEqual(await first.json(), { deviceId: "dev_car" });
  const sent = hubs.forwarded.at(-1);
  assert.deepEqual([sent.hub, sent.request.headers.get("x-yolo-ticket"), sent.request.headers.get("x-yolo-device"), sent.request.headers.get("x-yolo-user")], ["usr_1", secret, null, null]);
  assert.equal((await handleRealtime(upgrade(ticket), realtimeEnv)).status, 401);

  // A ticket that names no Hub of this Worker never reaches one.
  const reached = hubs.forwarded.length;
  for (const bad of ["", secret, `${"ab".repeat(32)}.${secret}`, `.${secret}`]) {
    assert.equal((await handleRealtime(upgrade(bad), realtimeEnv)).status, 401, bad);
  }
  assert.equal(hubs.forwarded.length, reached);
  assert.equal((await handleRealtime(new Request("https://x.test/v1/realtime"), realtimeEnv)).status, 426);
});

test("signing in keeps what is being approved in view", async () => {
  const h = signInHarness();
  const owner = await ensureOwner(h.db);
  await addPasskey(h.db, owner.id, { id: "phone", publicKey: "x", counter: 0, transports: ["internal"] });
  const { createDeviceCode, formatUserCode } = await import("../../src/store/pairing.js");
  const { userCode } = await createDeviceCode(h.db, owner.id, { name: "Tesla", kind: "car" });
  const login = async (next) => (await h.app.request(`/login?next=${encodeURIComponent(next)}`, {}, h.bindings)).text();

  const pairing = await login(`/device?code=${formatUserCode(userCode)}`);
  assert.match(pairing, /Sign in to pair a screen/);
  assert.match(pairing, /Tesla/);
  assert.match(pairing, new RegExp(formatUserCode(userCode)));
  // An unknown code says what the sign-in is for, without inventing a screen.
  const unknown = await login("/device?code=ZZZZ-ZZZZ");
  assert.match(unknown, /Sign in to pair a screen/);
  assert.doesNotMatch(unknown, /class="object"/);
  assert.match(await login("/oauth/authorize?client_id=x"), /Sign in to connect an app/);
  assert.match(await login("https://evil.test/device?code=x"), /Sign in to Yolo/);
  assert.match(await login("/account"), /Sign in to Yolo/);
});

test("after sign-in the page goes only to a path on its own origin", async () => {
  const { safeNextPath } = await import("../../src/auth/pages.js");
  const origin = "https://yolo.example";
  // Each `next` as it appears in the query string, so the encoded forms decode as a browser would.
  const nextOf = (raw) => new URLSearchParams(`next=${raw}`).get("next");
  for (const raw of ["/%5Cevil.example", "/%5C%5Cevil.example", "/%09/evil.example", "/%0A/evil.example", "%2F%2Fevil.example",
    "/%2E//evil.example", "/..//evil.example", "https://evil.example/", "javascript:alert(1)", "%20/evil.example"]) {
    assert.equal(safeNextPath(nextOf(raw), origin), null, raw);
  }
  assert.equal(safeNextPath(nextOf("%2Fdevice%3Fcode%3DABCD-EFGH"), origin), "/device?code=ABCD-EFGH");
  const authorize = "/oauth/authorize?client_id=x&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb";
  assert.equal(safeNextPath(nextOf(encodeURIComponent(authorize)), origin), authorize);
  // The page script runs this same function, and the server reads `next` through it.
  assert.ok(loginPage({ hasPasskey: true }).includes(String(safeNextPath)));
  const h = signInHarness();
  const owner = await ensureOwner(h.db);
  await addPasskey(h.db, owner.id, { id: "phone", publicKey: "x", counter: 0, transports: ["internal"] });
  const html = await (await h.app.request("/login?next=/%5Cevil.test/device", {}, h.bindings)).text();
  assert.match(html, /Sign in to Yolo/);
});

test("the owner pages share Yolo Web's dark tokens and follow the system's light or dark", async () => {
  const { readFile } = await import("node:fs/promises");
  const { DARK_TOKENS } = await import("../../src/auth/pages.js");
  const css = await readFile(new URL("../../../../clients/player/src/style.css", import.meta.url), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  const value = (name) => new RegExp(`${name}:\\s*([^;]+);`).exec(root)?.[1].trim();
  const pairs = {
    "--bg": "--surface-base", "--surface": "--surface-raised", "--tile": "--surface-tile", "--fg": "--text-primary", "--fg-2": "--text-secondary",
    "--fg-3": "--text-tertiary", "--line": "--hairline", "--danger": "--danger", "--ok": "--ok", "--press": "--press", "--hover": "--hover",
  };
  for (const [page, client] of Object.entries(pairs)) assert.equal(DARK_TOKENS[page], value(client), `${page} = Yolo Web's ${client}`);
  const html = loginPage({ hasPasskey: true });
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /<path fill="currentColor" fill-rule="evenodd"/, "the Yolo mark");
});

test("consent starts with every permission on, escapes the app's name, and warns about local apps", () => {
  const html = consentPage({ clientName: "Claude", redirectHost: "claude.ai", redirectIsLoopback: false, scope: ["read", "control", "manage"] }, "h1");
  for (const scope of ["read", "control", "manage"]) assert.match(html, new RegExp(`name="scope" value="${scope}" checked`));
  assert.match(html, /Play and control/);
  assert.match(html, /name="decision" value="approve" id="allow">Allow/);
  assert.match(html, /name="decision" value="deny">Deny/);
  assert.doesNotMatch(html, /app on your computer/);
  const local = consentPage({ clientName: "<script>alert(1)</script>", redirectHost: "127.0.0.1", redirectIsLoopback: true, scope: ["read"] }, "h1");
  assert.doesNotMatch(local, /<script>alert/);
  assert.match(local, /Allow &#60;script&#62;alert\(1\)&#60;\/script&#62; to use Yolo\?/);
  assert.match(local, /app on your computer/);
});

test("message pages escape what they show and keep their status", async () => {
  const response = messagePage("Cannot <pair>", "Code <b>x</b> expired", 400, { kind: "expired", action: { href: "/device", label: "Enter another code" } });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert.doesNotMatch(html, /<b>x<\/b>|<pair>/);
  assert.match(html, /Cannot &#60;pair&#62;/);
  assert.match(html, /Code &#60;b&#62;x&#60;\/b&#62; expired/);
  assert.match(html, /href="\/device">Enter another code/);
});
