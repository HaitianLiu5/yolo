import assert from "node:assert/strict";
import { test } from "node:test";
import { base64url, dnsChallengeValue, LETS_ENCRYPT_STAGING_DIRECTORY } from "@useyolo/core";
import { CLOUDFLARE_API } from "../../src/edge/cloudflare-dns.js";
import { LAN_STATE_KEY, lanWelcome, maintainLan, saveState } from "../../src/edge/lan.js";
import * as lease from "../../src/edge/lease.js";
import { maintainMediaNames } from "../../src/edge/maintain.js";
import { mediaWelcome } from "../../src/edge/paths.js";
import { maintainWan, WAN_STATE_KEY, wanWelcome } from "../../src/edge/wan.js";
import { writeMediaSettings } from "../../src/store/media-settings.js";
import { createTestD1 } from "../helpers/d1.js";
import { createMemoryKv } from "../helpers/kv.js";

// The node's media names on the control plane's side
// (Agent Note 2026-10-12-lan-direct-play,
// Agent Note 2026-10-13-media-off-the-worker) against stand-ins: an ACME
// server answering at Let's Encrypt's staging directory that checks JWS
// signatures and the DNS-01 record, the Cloudflare DNS API, and the node
// behind nodeFetch().

const TOKEN = "cf-dns-token";
const DAY = 24 * 60 * 60_000;
const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

function cloudflare() {
  const records = new Map();
  let next = 1;
  const writes = [];
  const reply = (result) => Response.json({ success: true, errors: [], result });
  return {
    records,
    writes,
    async handle(url, init) {
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${TOKEN}`);
      const method = init.method || "GET";
      if (url.pathname === "/client/v4/zones") return reply(url.searchParams.get("name") === "example.com" ? [{ id: "zone1", name: "example.com" }] : []);
      const path = /^\/client\/v4\/zones\/zone1\/dns_records(?:\/(.+))?$/.exec(url.pathname);
      assert.ok(path, `unexpected Cloudflare call ${url.pathname}`);
      if (method === "GET") return reply([...records.values()].filter((record) => record.type === url.searchParams.get("type") && record.name === url.searchParams.get("name")));
      writes.push(method);
      if (method === "POST") {
        const record = { id: `rec${next++}`, ...JSON.parse(init.body) };
        records.set(record.id, record);
        return reply(record);
      }
      if (method === "PATCH") {
        records.set(path[1], { ...records.get(path[1]), ...JSON.parse(init.body) });
        return reply(records.get(path[1]));
      }
      records.delete(path[1]);
      return reply({ id: path[1] });
    },
  };
}

// RFC 8555, as far as one order needs: every POST is a JWS checked against
// the account key, nonces are single-use, and the challenge is valid only
// when the zone holds the right TXT record.
function acmeServer(dns) {
  const base = new URL(LETS_ENCRYPT_STAGING_DIRECTORY).origin;
  const nonces = new Set();
  const accounts = new Map();
  const orders = [];
  const nonce = () => {
    const value = base64url(crypto.getRandomValues(new Uint8Array(12)));
    nonces.add(value);
    return value;
  };
  const answer = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "replay-nonce": nonce(), ...headers } });
  return {
    orders,
    async handle(url, init) {
      if (url.href === LETS_ENCRYPT_STAGING_DIRECTORY) return Response.json({ newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order` });
      if (url.pathname === "/nonce") return answer(200, "");
      const jws = JSON.parse(init.body);
      const header = decode(jws.protected);
      assert.equal(header.url, url.href);
      assert.ok(nonces.delete(header.nonce), "a fresh nonce");
      const jwk = header.jwk ?? accounts.get(header.kid);
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const signed = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(jws.signature, "base64url"), new TextEncoder().encode(`${jws.protected}.${jws.payload}`));
      assert.ok(signed, "a valid ES256 signature");
      const payload = jws.payload ? decode(jws.payload) : undefined;
      if (url.pathname === "/account") {
        const kid = `${base}/acct/${accounts.size + 1}`;
        accounts.set(kid, header.jwk);
        return answer(201, { status: "valid" }, { location: kid });
      }
      if (url.pathname === "/order") {
        const order = { id: orders.length, name: payload.identifiers[0].value, status: "pending", token: base64url(crypto.getRandomValues(new Uint8Array(16))), jwk, authz: "pending" };
        orders.push(order);
        return answer(201, { status: "pending", authorizations: [`${base}/authz/${order.id}`], finalize: `${base}/finalize/${order.id}` }, { location: `${base}/orders/${order.id}` });
      }
      const [, kind, id] = url.pathname.split("/");
      const order = orders[Number(id)];
      if (kind === "authz") return answer(200, { status: order.authz, challenges: [{ type: "http-01", url: `${base}/nope`, token: "x" }, { type: "dns-01", url: `${base}/challenge/${order.id}`, token: order.token }] });
      if (kind === "challenge") {
        const expected = await dnsChallengeValue(order.token, order.jwk);
        const txt = [...dns.records.values()].find((record) => record.type === "TXT" && record.name === `_acme-challenge.${order.name}`);
        order.authz = txt?.content === `"${expected}"` ? "valid" : "invalid";
        return answer(200, { status: "processing" });
      }
      if (kind === "finalize") {
        assert.equal(payload.csr, "TUlJQ1NS");
        order.status = "valid";
        return answer(200, { status: "processing" });
      }
      if (kind === "orders") return answer(200, { status: order.status, ...(order.status === "valid" ? { certificate: `${base}/cert/${order.id}` } : {}) });
      if (kind === "cert") return answer(200, `CHAIN-${order.id}`, { "content-type": "application/pem-certificate-chain" });
      throw new Error(`unexpected ACME call ${url.pathname}`);
    },
  };
}

function fakeNode(clock) {
  const node = { address: "192.168.1.20", chains: [], certificate: null, calls: [] };
  const status = () => ({
    address: node.address, port: 9443, listening: Boolean(node.certificate), error: null,
    origin: node.name ? `https://${node.name}:9443` : null, notBefore: node.certificate?.notBefore ?? null, notAfter: node.certificate?.notAfter ?? null,
  });
  node.request = async (path, { method, body }) => {
    node.calls.push(`${method} ${path}`);
    if (path === "/internal/v1/lan") {
      node.name = body.name;
      assert.equal(body.allowOrigin, "https://yolo.example.com");
      return { ...status(), csr: "-----BEGIN CERTIFICATE REQUEST-----\nTUlJQ1NS\n-----END CERTIFICATE REQUEST-----\n" };
    }
    assert.equal(path, "/internal/v1/lan/certificate");
    node.chains.push(body.chain);
    node.certificate = { notBefore: clock.now, notAfter: clock.now + 90 * DAY };
    return status();
  };
  return node;
}

test("the control plane names the node, points a DNS-only record at it, and keeps its certificate current through ACME DNS-01", async () => {
  const clock = { now: Date.UTC(2026, 9, 12) };
  const kv = createMemoryKv();
  const dns = cloudflare();
  const acme = acmeServer(dns);
  const node = fakeNode(clock);
  const env = { MEDIA_DNS_TOKEN: TOKEN, PUBLIC_ORIGIN: "https://yolo.example.com", OAUTH_KV: kv };
  const logs = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    if (url.href.startsWith(CLOUDFLARE_API)) return dns.handle(url, init);
    return acme.handle(url, init);
  };
  const run = () => maintainLan(env, {
    node, fetchImpl, sleep: async () => {}, now: () => clock.now, log: (record) => logs.push(record),
    // The record exists before the server is asked to validate it.
    waitForTxt: async (name, value) => assert.ok([...dns.records.values()].some((record) => record.name === name && record.content === `"${value}"`)),
  });

  const first = await run();
  assert.equal(first.status, "ready");
  assert.match(first.name, /^yolo-lan-[0-9a-f]{8}\.example\.com$/, "a name outside the passkey relying party yolo.example.com");
  assert.deepEqual([...dns.records.values()].map(({ type, name, content, ttl, proxied }) => ({ type, name, content, ttl, proxied })), [
    { type: "A", name: first.name, content: "192.168.1.20", ttl: 60, proxied: false },
  ], "the A record stays; the challenge's TXT record is gone");
  assert.deepEqual(node.chains, ["CHAIN-0"]);
  assert.equal(first.origin, `https://${first.name}:9443`);
  assert.equal(JSON.stringify(first).includes("\"d\""), false, "the owner's view carries no account key");
  assert.deepEqual(lanWelcome(JSON.parse(await kv.get(LAN_STATE_KEY)), clock.now), { origin: first.origin, notAfter: clock.now + 90 * DAY });

  // Nothing due: no ACME order and no DNS write.
  clock.now += DAY;
  dns.writes.length = 0;
  await run();
  assert.deepEqual([acme.orders.length, dns.writes], [1, []]);

  // DHCP moved the node: the record follows.
  node.address = "192.168.1.31";
  const moved = await run();
  assert.deepEqual([moved.address, [...dns.records.values()][0].content, dns.writes, acme.orders.length], ["192.168.1.31", "192.168.1.31", ["PATCH"], 1]);
  assert.ok(logs.some((record) => record.event === "address_changed" && record.to === "192.168.1.31"));

  // Two thirds into the certificate's life it is renewed with the same account.
  clock.now += 60 * DAY;
  const renewed = await run();
  assert.deepEqual([renewed.status, node.chains, acme.orders.length], ["ready", ["CHAIN-0", "CHAIN-1"], 2]);
  assert.equal(acme.orders[1].jwk, acme.orders[0].jwk);
});

test("LAN_DNS_TOKEN, the secret's name before 0.5, is no longer read: the node is not named", async () => {
  const kv = createMemoryKv();
  const node = fakeNode({ now: Date.UTC(2026, 9, 14) });
  const fetched = [];
  const env = { LAN_DNS_TOKEN: TOKEN, PUBLIC_ORIGIN: "https://yolo.example.com", OAUTH_KV: kv };
  const view = await maintainLan(env, {
    node, fetchImpl: async (input) => fetched.push(String(input)), sleep: async () => {}, log: () => {},
  });
  assert.deepEqual([view.configured, view.status], [false, "off"]);
  assert.deepEqual([fetched, node.calls, await kv.get(LAN_STATE_KEY)], [[], [], null], "no DNS, no ACME, no node call, no state");
});

// The node's remote listener as the control plane sees it.
function fakeWanNode(clock) {
  const node = { publicAddress: "73.63.154.63", nat: null, enabled: null, chains: [], certificate: null };
  const listening = () => Boolean(node.certificate && node.enabled);
  const status = () => ({
    listening: listening(), origin: listening() ? `https://${node.name}:9444` : null, error: null,
    notBefore: node.certificate?.notBefore ?? null, notAfter: node.certificate?.notAfter ?? null,
    publicAddress: node.publicAddress, ipv6: null, addresses: ["192.168.1.20"], nat: node.nat, natReason: node.nat ? "The router's own public address 100.70.1.2 is a carrier-grade NAT or private address" : null,
    mapping: { mode: "auto", method: listening() ? "natpmp" : null, externalPort: listening() ? 9444 : null, error: null },
  });
  node.request = async (path, { method, body }) => {
    assert.equal(method, "PUT");
    if (path === "/internal/v1/wan") {
      Object.assign(node, { name: body.name, enabled: body.enabled });
      return { ...status(), csr: "-----BEGIN CERTIFICATE REQUEST-----\nTUlJQ1NS\n-----END CERTIFICATE REQUEST-----\n" };
    }
    assert.equal(path, "/internal/v1/wan/certificate");
    node.chains.push(body.chain);
    node.certificate = { notBefore: clock.now, notAfter: clock.now + 90 * DAY };
    return status();
  };
  return node;
}

test("remote access names the node again, publishes the home's public address, and lists the path once the Worker reaches it from outside", async () => {
  const clock = { now: Date.UTC(2026, 9, 13) };
  const db = createTestD1();
  const kv = createMemoryKv();
  const dns = cloudflare();
  const acme = acmeServer(dns);
  const node = fakeWanNode(clock);
  const env = { MEDIA_DNS_TOKEN: TOKEN, PUBLIC_ORIGIN: "https://yolo.example.com", OAUTH_KV: kv, DB: db };
  const logs = [];
  const probes = [];
  let reachable = true;
  const run = () => maintainWan(env, {
    node, sleep: async () => {}, now: () => clock.now, log: (record) => logs.push(record), waitForTxt: async () => true,
    fetchImpl: async (input, init = {}) => (String(input).startsWith(CLOUDFLARE_API) ? dns.handle(new URL(input), init) : acme.handle(new URL(input), init)),
    probe: async (url) => {
      probes.push(url);
      if (!reachable) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return Response.json({ ok: true, name: node.name, path: "wan" });
    },
  });
  const records = () => [...dns.records.values()].filter((record) => record.type !== "TXT").map(({ type, content, proxied }) => [type, content, proxied]);

  // Off until the owner turns remote access on: nothing is named.
  assert.equal((await run()).status, "off");
  assert.equal(node.name, undefined);

  await writeMediaSettings(db, "usr_owner", { remote: true });
  const on = await run();
  assert.equal(on.status, "ok");
  assert.match(on.name, /^yolo-wan-[0-9a-f]{8}\.example\.com$/);
  assert.deepEqual(records(), [["A", "73.63.154.63", false]], "a DNS-only record of the public address");
  assert.deepEqual([node.chains, probes], [["CHAIN-0"], [`https://${on.name}:9444/edge/probe`]]);
  assert.deepEqual(wanWelcome(JSON.parse(await kv.get(WAN_STATE_KEY)), clock.now), { origin: `https://${on.name}:9444`, notAfter: clock.now + 90 * DAY });

  // The ISP moved the address: the record follows. The outside check fails: no path.
  node.publicAddress = "73.63.154.99";
  reachable = false;
  const moved = await run();
  assert.deepEqual([moved.status, records()], ["unreachable", [["A", "73.63.154.99", false]]]);
  assert.equal(wanWelcome(JSON.parse(await kv.get(WAN_STATE_KEY)), clock.now), null);
  assert.ok(logs.some((record) => record.kind === "edge" && record.event === "address_changed" && record.to === "73.63.154.99"));

  // Behind carrier-grade NAT nothing can reach the record: it goes.
  node.nat = "cgnat";
  const behind = await run();
  assert.deepEqual([behind.status, records()], ["cgnat", []]);

  // Remote access off: the node closes the listener and the router port.
  node.nat = null;
  await writeMediaSettings(db, "usr_owner", { remote: false });
  const off = await run();
  assert.deepEqual([off.status, node.enabled, records()], ["off", false, []]);
});

test("a media name's state writes KV only when it changes, or once an hour, not on every cron run", async () => {
  // Workers Free allows 1,000 KV writes a day; a 5-minute cron that wrote
  // every run would use 288 of them for each name.
  const kv = createMemoryKv();
  let writes = 0;
  const put = kv.put;
  kv.put = async (...args) => {
    writes += 1;
    return put(...args);
  };
  const run = async (index, change) => {
    const now = 1_000_000 + index * 5 * 60_000;
    const previous = JSON.parse(kv.map.get("yolo:test") ?? "{}");
    await saveState(kv, "yolo:test", { ...previous, ...change(now) }, previous, now);
  };
  // Reachable from outside for two hours: the check's time changes every run.
  for (let index = 0; index < 24; index += 1) await run(index, (now) => ({ status: "ok", error: null, reachedAt: now }));
  assert.equal(writes, 2);
  // The same error on every run for the next hour.
  for (let index = 24; index < 36; index += 1) await run(index, (now) => ({ status: "error", error: { step: "reach", message: "no answer", at: now } }));
  assert.equal(writes, 3);
  await run(36, (now) => ({ status: "error", error: { step: "dns", message: "token rejected", at: now } }));
  assert.equal(writes, 4);
});

// The node certifying the home's public address itself, as the control
// plane sees it (Agent Note 2026-10-13-no-domain-deployment).
function fakeIpNode(clock) {
  const node = { publicAddress: "73.63.154.63", enabled: null, bodies: [], error: null, issuedFor: null };
  const valid = () => node.enabled && !node.error && node.issuedFor === node.publicAddress;
  node.request = async (path, { method, body }) => {
    assert.deepEqual([method, path], ["PUT", "/internal/v1/wan"], "everything goes through the one configure call");
    node.bodies.push(body);
    node.enabled = body.enabled;
    if (valid() || (node.enabled && !node.error)) node.issuedFor = node.publicAddress;
    const serving = valid();
    return {
      certificate: "ip", listening: serving, origin: serving ? `https://${node.publicAddress}:9444` : null, error: node.error,
      notBefore: serving ? clock.now : null, notAfter: serving ? clock.now + 160 * 60 * 60_000 : null,
      publicAddress: node.publicAddress, ipv6: null, addresses: serving ? ["192.168.1.20"] : [], nat: null, natReason: null,
      identifiers: serving ? [node.publicAddress] : [],
      mapping: { mode: "auto", method: serving ? "upnp" : null, externalPort: serving ? 9444 : null, error: null },
      challenge: { type: "http-01", externalPort: 80, internalPort: 9480, mapping: "auto", method: "upnp" },
      order: { running: false, failures: 0, retryAt: node.error ? clock.now + 30 * 60_000 : null, error: node.error, validatedAt: serving ? clock.now : null, ipv6Error: null },
    };
  };
  return node;
}

test("without a domain remote access needs no DNS token: the node certifies the home's address, the welcome lists it, and a new address reaches the screens", async () => {
  const clock = { now: Date.UTC(2026, 9, 13) };
  const db = createTestD1();
  const kv = createMemoryKv();
  const node = fakeIpNode(clock);
  const env = { WAN_CERTIFICATE: "ip", PUBLIC_ORIGIN: "https://yolo-control.owner.workers.dev", LAN_ACME_DIRECTORY: "https://acme.test/directory", OAUTH_KV: kv, DB: db };
  const outside = [];
  let changed = 0;
  const run = () => maintainWan(env, {
    node, now: () => clock.now,
    fetchImpl: async (input) => outside.push(String(input)),
    probe: async (url) => outside.push(url),
    onPathsChanged: async () => {
      changed += 1;
    },
  });

  const off = await run();
  assert.deepEqual([off.configured, off.certificate, off.status], [true, "ip", "off"], "ready to turn on with no secret");

  await writeMediaSettings(db, "usr_owner", { remote: true });
  const on = await run();
  assert.equal(on.status, "ok");
  assert.deepEqual(node.bodies.at(-1), { certificate: "ip", allowOrigin: "https://yolo-control.owner.workers.dev", enabled: true, acmeDirectory: "https://acme.test/directory" });
  assert.deepEqual([on.origin, on.address, on.name, on.challenge.type], ["https://73.63.154.63:9444", "73.63.154.63", null, "http-01"]);
  assert.deepEqual(outside, [], "no DNS, no ACME, and no probe from the Worker, which cannot fetch an address");
  assert.deepEqual(wanWelcome(JSON.parse(await kv.get(WAN_STATE_KEY)), clock.now), { origin: "https://73.63.154.63:9444", notAfter: clock.now + 160 * 60 * 60_000 });
  assert.equal(changed, 1, "connected screens learn the new path");

  // A new address: the node's new certificate and origin, and the screens hear of it.
  clock.now += 5 * 60_000;
  node.publicAddress = "73.63.154.99";
  const moved = await run();
  assert.equal(moved.origin, "https://73.63.154.99:9444");
  assert.equal(changed, 2);
  await run();
  assert.equal(changed, 2, "nothing new, nothing sent");

  // The router refuses port 80: the owner sees the node's instruction.
  node.error = "The router would not map its port 80 to this node for the certificate check. Forward TCP port 80 to 192.168.1.20:9480 on the router and set WAN_CHALLENGE_MAPPING=manual";
  const refused = await run();
  assert.equal(refused.status, "error");
  assert.match(refused.error.message, /Forward TCP port 80 to 192\.168\.1\.20:9480/);
  assert.equal(changed, 3, "the path is gone");
});

// A DNS provider plugin as the control plane sees it
// (Agent Note 2026-10-14-dns-provider-plugins): the definition a control
// entry registers, and a provider that keeps its records in memory in the
// Cloudflare stand-in's shape, so the ACME stand-in reads its challenge.
function fakeProvider({ settleMs = 90_000 } = {}) {
  const records = new Map();
  const calls = [];
  const made = [];
  const definition = {
    id: "fake-dns", plugin: "@fixture/fake-dns", title: "Fake DNS", secret: "FAKE_DNS_TOKEN",
    create: ({ token, zone }) => {
      made.push({ token, zone });
      return {
        settleMs,
        async zone(pageHost) {
          calls.push(["zone", pageHost]);
          return { id: `zone:${zone}`, name: zone, ttl: 60 };
        },
        async setAddress(at, name, type, address) {
          assert.equal(at.id, `zone:${zone}`);
          calls.push(["setAddress", name, type, address]);
          records.set(`${type} ${name}`, { type, name, content: address });
        },
        async clearAddress(at, name, type) {
          calls.push(["clearAddress", name, type]);
          records.delete(`${type} ${name}`);
        },
        async setTxt(at, name, value) {
          calls.push(["setTxt", name]);
          records.set(`TXT ${name} ${value}`, { type: "TXT", name, content: `"${value}"` });
          return `handle:${value}`;
        },
        async clearTxt(at, name, value, handle) {
          calls.push(["clearTxt", name, handle === `handle:${value}`]);
          records.delete(`TXT ${name} ${value}`);
        },
      };
    },
  };
  return { definition, records, calls, made, addresses: () => [...records.values()].filter((record) => record.type !== "TXT").map(({ type, name, content }) => [type, name, content]) };
}

// The LAN side of the node, for an instance on workers.dev.
function fakeLanNode(clock, origin) {
  const node = { address: "192.168.1.20", chains: [], certificate: null };
  const status = () => ({
    address: node.address, port: 9443, listening: Boolean(node.certificate), error: null,
    origin: node.name ? `https://${node.name}:9443` : null, notBefore: node.certificate?.notBefore ?? null, notAfter: node.certificate?.notAfter ?? null,
  });
  node.request = async (path, { body }) => {
    if (path === "/internal/v1/lan") {
      assert.equal(body.allowOrigin, origin);
      node.name = body.name;
      return { ...status(), csr: "-----BEGIN CERTIFICATE REQUEST-----\nTUlJQ1NS\n-----END CERTIFICATE REQUEST-----\n" };
    }
    node.chains.push(body.chain);
    node.certificate = { notBefore: clock.now, notAfter: clock.now + 90 * DAY };
    return status();
  };
  return node;
}

test("without a domain, a DNS provider plugin names the node in its own zone, publishes both records, and lets its records settle before the CA checks", async () => {
  const clock = { now: Date.UTC(2026, 9, 14) };
  const db = createTestD1();
  const kv = createMemoryKv();
  const dns = fakeProvider();
  const acme = acmeServer(dns);
  const origin = "https://yolo-abc123.owner.workers.dev";
  const env = {
    MEDIA_DNS_PROVIDER: "fake-dns", MEDIA_DNS_ZONE: "home.example.net", FAKE_DNS_TOKEN: "fake-token", WAN_CERTIFICATE: "name",
    PUBLIC_ORIGIN: origin, OAUTH_KV: kv, DB: db,
  };
  const events = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    assert.notEqual(url.hostname, "api.cloudflare.com", "the plugin's zone, never Cloudflare's");
    if (url.pathname.startsWith("/challenge/")) events.push("challenge");
    return acme.handle(url, init);
  };
  const options = {
    providers: [dns.definition], fetchImpl, now: () => clock.now, log: () => {},
    sleep: async (ms) => {
      if (ms >= 60_000) events.push(`settle ${ms}`);
    },
    waitForTxt: async (name, value) => {
      assert.ok([...dns.records.values()].some((record) => record.name === name && record.content === `"${value}"`));
      events.push("seen");
      return true;
    },
  };

  const lanNode = fakeLanNode(clock, origin);
  const lan = await maintainLan(env, { ...options, node: lanNode });
  assert.equal(lan.status, "ready", JSON.stringify(lan.error));
  assert.match(lan.name, /^yolo-lan-[0-9a-f]{8}\.home\.example\.net$/);
  assert.equal(lan.zone, "home.example.net");
  assert.deepEqual(dns.made[0], { token: "fake-token", zone: "home.example.net" }, "the provider gets its own secret and the instance's zone");
  assert.deepEqual(dns.addresses(), [["A", lan.name, "192.168.1.20"]]);
  assert.deepEqual(events, ["seen", "settle 90000", "challenge"], "the CA is asked only after the provider's settle time");
  assert.ok(dns.calls.some(([call, name, matched]) => call === "clearTxt" && name === `_acme-challenge.${lan.name}` && matched), "the challenge is removed with its own handle");
  assert.deepEqual(lanNode.chains, ["CHAIN-0"]);

  await writeMediaSettings(db, "usr_owner", { remote: true });
  const wanNode = fakeWanNode(clock);
  const probes = [];
  const wan = await maintainWan(env, {
    ...options, node: wanNode,
    probe: async (url) => {
      probes.push(url);
      return Response.json({ ok: true, name: wanNode.name, path: "wan" });
    },
  });
  assert.deepEqual([wan.status, wan.configured, wan.certificate], ["ok", true, "name"]);
  assert.match(wan.name, /^yolo-wan-[0-9a-f]{8}\.home\.example\.net$/);
  assert.deepEqual(dns.addresses(), [["A", lan.name, "192.168.1.20"], ["A", wan.name, "73.63.154.63"]]);
  assert.deepEqual(probes, [`https://${wan.name}:9444/edge/probe`], "the Worker checks the name from outside");

  const media = await mediaWelcome(env, "usr_owner", clock.now);
  assert.deepEqual(media.paths.map((entry) => [entry.path, entry.origin]), [["lan", lan.origin], ["wan", wan.origin]]);
  assert.equal(media.lanNeedsDomain, false, "a screen at home gets its LAN switch back");
});

test("a DNS provider without its plugin or its secret fails where the owner sees it, and Cloudflare's token is never used in its place", async () => {
  const clock = { now: Date.UTC(2026, 9, 14) };
  const kv = createMemoryKv();
  const db = createTestD1();
  await writeMediaSettings(db, "usr_owner", { remote: true });
  const dns = fakeProvider();
  const env = { MEDIA_DNS_PROVIDER: "fake-dns", MEDIA_DNS_ZONE: "home.example.net", MEDIA_DNS_TOKEN: TOKEN, PUBLIC_ORIGIN: "https://yolo.example.com", OAUTH_KV: kv, DB: db };
  const outside = [];
  const node = { request: async (path) => outside.push(path) };
  const options = { node, now: () => clock.now, log: () => {}, fetchImpl: async (input) => outside.push(String(input)), probe: async (url) => outside.push(url) };

  const unbundled = await maintainLan(env, { ...options, providers: [] });
  assert.deepEqual([unbundled.configured, unbundled.status, unbundled.error.step], [true, "error", "zone"]);
  assert.match(unbundled.error.message, /"fake-dns".*yolo\.config\.json/);
  const remote = await maintainWan(env, { ...options, providers: [] });
  assert.deepEqual([remote.status, remote.error.step], ["error", "zone"]);

  const unsecret = await maintainLan(env, { ...options, providers: [dns.definition] });
  assert.match(unsecret.error.message, /FAKE_DNS_TOKEN.*provision media-dns/);
  assert.deepEqual([outside, dns.made], [[], []], "no request anywhere: neither the node nor Cloudflare");
});

test("moving the media names to a DNS provider plugin names the node again in the new zone and writes the records there", async () => {
  const clock = { now: Date.UTC(2026, 9, 14) };
  const db = createTestD1();
  const kv = createMemoryKv();
  const cloudflareDns = cloudflare();
  const plugin = fakeProvider({ settleMs: 0 });
  const node = fakeWanNode(clock);
  // The node drops its certificate when it is given another name (service/node/src/edge.js).
  const request = node.request;
  node.request = async (path, init) => {
    if (path === "/internal/v1/wan" && init.body.name !== node.name) node.certificate = null;
    return request(path, init);
  };
  await writeMediaSettings(db, "usr_owner", { remote: true });
  const base = { PUBLIC_ORIGIN: "https://yolo.example.com", OAUTH_KV: kv, DB: db };
  // One CA, which keeps the ACME account, sees both providers' records.
  const acme = acmeServer({ get records() {
    return new Map([...cloudflareDns.records, ...plugin.records]);
  } });
  const run = (env) => maintainWan(env, {
    node, providers: [plugin.definition], sleep: async () => {}, now: () => clock.now, log: () => {}, waitForTxt: async () => true,
    fetchImpl: async (input, init = {}) => (String(input).startsWith(CLOUDFLARE_API) ? cloudflareDns.handle(new URL(input), init) : acme.handle(new URL(input), init)),
    probe: async () => Response.json({ ok: true, name: node.name, path: "wan" }),
  });

  const before = await run({ ...base, MEDIA_DNS_TOKEN: TOKEN });
  assert.match(before.name, /^yolo-wan-[0-9a-f]{8}\.example\.com$/);
  assert.equal("dns" in JSON.parse(await kv.get(WAN_STATE_KEY)), false, "Cloudflare's state reads as it did before DNS providers");

  clock.now += 5 * 60_000;
  const after = await run({ ...base, MEDIA_DNS_TOKEN: TOKEN, MEDIA_DNS_PROVIDER: "fake-dns", MEDIA_DNS_ZONE: "home.example.net", FAKE_DNS_TOKEN: "fake-token" });
  assert.equal(after.status, "ok", JSON.stringify(after.error));
  assert.match(after.name, /^yolo-wan-[0-9a-f]{8}\.home\.example\.net$/);
  assert.deepEqual(plugin.addresses(), [["A", after.name, "73.63.154.63"]], "the address goes to the new name although it did not change");
  assert.equal(node.chains.length, 2, "a certificate for the new name");
  assert.equal(after.origin, `https://${after.name}:9444`);
});

// Runs of the media names with a provider whose nameservers need time
// (Agent Note 2026-10-14-dns-provider-plugins): a run lasts minutes, the cron
// fires every 5, and Workers Free allows 50 subrequests a run.

const EDGE_LEASE_KEY = "yolo:edge:lease";
const providerEnv = (kv, db, extra = {}) => ({
  MEDIA_DNS_PROVIDER: "fake-dns", MEDIA_DNS_ZONE: "home.example.net", FAKE_DNS_TOKEN: "fake-token", WAN_CERTIFICATE: "name",
  PUBLIC_ORIGIN: "https://yolo-abc123.owner.workers.dev", OAUTH_KV: kv, DB: db, ...extra,
});

// Both sides of the node; a new name drops the certificate, as the node does
// (service/node/src/edge.js). `calls` counts every request to the node, and
// `names` keeps every name each side was given.
function fakeNodes(clock, origin) {
  const nodes = { lan: fakeLanNode(clock, origin), wan: fakeWanNode(clock), calls: 0, names: { lan: new Set(), wan: new Set() } };
  for (const [side, node] of [["lan", nodes.lan], ["wan", nodes.wan]]) {
    const request = node.request;
    node.request = async (path, init) => {
      nodes.calls += 1;
      if (path === `/internal/v1/${side}`) nodes.names[side].add(init.body.name);
      if (path === "/internal/v1/wan" && init.body.name !== node.name) node.certificate = null;
      return request(path, init);
    };
  }
  return nodes;
}

// The fake provider making one request per call through the fetch it was
// given, as a provider plugin does.
function requestingProvider(dns) {
  return {
    ...dns.definition,
    create: (context) => {
      const provider = dns.definition.create(context);
      const wrapped = { settleMs: provider.settleMs };
      for (const method of ["zone", "setAddress", "clearAddress", "setTxt", "clearTxt"]) {
        wrapped[method] = async (...args) => {
          await context.fetch(`https://dns.test/${method}`);
          return provider[method](...args);
        };
      }
      return wrapped;
    },
  };
}

test("a cron run orders at most one certificate, keeps its names in KV before it orders, and a run that starts meanwhile keeps those names and orders nothing", async () => {
  const clock = { now: Date.UTC(2026, 9, 14) };
  const db = createTestD1();
  const kv = createMemoryKv();
  await writeMediaSettings(db, "usr_owner", { remote: true });
  const dns = fakeProvider({ settleMs: 150_000 });
  const acme = acmeServer(dns);
  const env = providerEnv(kv, db);
  const nodes = fakeNodes(clock, env.PUBLIC_ORIGIN);
  let overlapping = false;
  let during = null;
  const seams = {
    now: () => clock.now, log: () => {}, waitForTxt: async () => true,
    fetchImpl: async (input, init = {}) => acme.handle(new URL(input), init),
    sleep: async (ms) => {
      clock.now += ms;
      if (ms !== 150_000 || overlapping) return;
      // The next cron run fires while this one waits for the provider's nameservers.
      overlapping = true;
      clock.now += 5 * 60_000 - ms;
      const persisted = JSON.parse((await kv.get(LAN_STATE_KEY)) ?? "{}");
      const orders = acme.orders.length;
      const result = await cron();
      during = { persisted: persisted.name ?? null, lan: result.lan?.name ?? null, wan: result.wan?.name ?? null, orders: acme.orders.length - orders };
    },
  };
  const cron = () => maintainMediaNames(env, {
    now: () => clock.now, log: () => {}, loadProviders: async () => [dns.definition],
    lan: { ...seams, node: nodes.lan },
    wan: { ...seams, node: nodes.wan, probe: async () => Response.json({ ok: true, name: nodes.wan.name, path: "wan" }) },
  });

  await cron();
  const lan = JSON.parse(await kv.get(LAN_STATE_KEY));
  const wan = JSON.parse(await kv.get(WAN_STATE_KEY));
  assert.deepEqual(during, { persisted: lan.name, lan: lan.name, wan: null, orders: 0 }, "the second run kept the name the first had saved, named nothing under its lease, and ordered nothing");
  assert.equal(acme.orders.length, 1, "one certificate a run");
  assert.equal(lan.ready, true);
  assert.match(wan.name ?? "", /^yolo-wan-[0-9a-f]{8}\.home\.example\.net$/, "the remote name and record are set up, its certificate waits");
  assert.notEqual(wan.status, "ok");
  assert.equal(await kv.get(EDGE_LEASE_KEY), null, "the lease goes with the run");

  clock.now += 5 * 60_000;
  await cron();
  const next = JSON.parse(await kv.get(WAN_STATE_KEY));
  assert.deepEqual([acme.orders.length, next.status, next.name], [2, "ok", wan.name], "the next run orders the remote certificate for the same name");
  assert.deepEqual(dns.addresses().filter(([, name]) => name.startsWith("yolo-wan-")), [["A", wan.name, "73.63.154.63"]], "no record left for another name");
  assert.deepEqual([nodes.names.lan.size, nodes.names.wan.size], [1, 1], "the node was never given another name");
});

test("a cron run that orders both first certificates stays inside Workers Free's 50 subrequests, even when the resolver never answers", async () => {
  const clock = { now: Date.UTC(2026, 9, 14) };
  const db = createTestD1();
  const kv = createMemoryKv();
  await writeMediaSettings(db, "usr_owner", { remote: true });
  const dns = fakeProvider({ settleMs: 150_000 });
  const acme = acmeServer(dns);
  const env = providerEnv(kv, db);
  const nodes = fakeNodes(clock, env.PUBLIC_ORIGIN);
  const requests = { resolver: 0, other: 0 };
  const seams = {
    now: () => clock.now, log: () => {},
    sleep: async (ms) => {
      clock.now += ms;
    },
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (url.hostname === "cloudflare-dns.com") {
        requests.resolver += 1;
        return Response.json({ Status: 3 });
      }
      requests.other += 1;
      return url.hostname === "dns.test" ? Response.json({}) : acme.handle(url, init);
    },
  };
  await maintainMediaNames(env, {
    now: () => clock.now, log: () => {}, loadProviders: async () => [requestingProvider(dns)],
    lan: { ...seams, node: nodes.lan },
    wan: { ...seams, node: nodes.wan, probe: async () => Response.json({ ok: true, name: nodes.wan.name, path: "wan" }) },
  });
  const total = requests.resolver + requests.other + nodes.calls;
  assert.ok(requests.resolver <= 4, `the resolver is asked at most 4 times for a slow provider, not ${requests.resolver}`);
  assert.ok(total <= 50, `${total} subrequests in one run`);
});

test("the owner's check never runs a slow provider's order inside the request; the cron run does", async () => {
  const clock = { now: Date.UTC(2026, 9, 14) };
  const kv = createMemoryKv();
  const db = createTestD1();
  const slow = fakeProvider({ settleMs: 150_000 });
  const acme = acmeServer(slow);
  const env = providerEnv(kv, db);
  const options = (dns) => ({
    providers: [dns.definition], node: fakeLanNode(clock, env.PUBLIC_ORIGIN), now: () => clock.now, log: () => {}, sleep: async () => {}, waitForTxt: async () => true,
    fetchImpl: async (input, init = {}) => acme.handle(new URL(input), init),
  });
  const cron = options(slow);
  const first = await maintainLan(env, cron);
  assert.deepEqual([first.status, acme.orders.length], ["ready", 1], "the cron run names the node and orders its certificate");

  // Two thirds into the certificate's life the owner presses Check now.
  clock.now += 61 * DAY;
  const checked = await maintainLan(env, { ...cron, interactive: true });
  assert.deepEqual([checked.name, checked.status, acme.orders.length], [first.name, "ready", 1], "no order while the owner waits");
  await maintainLan(env, cron);
  assert.equal(acme.orders.length, 2, "the cron run renews it");

  const fast = fakeProvider({ settleMs: 0 });
  const fastAcme = acmeServer(fast);
  const quick = await maintainLan(providerEnv(createMemoryKv(), createTestD1()), { ...options(fast), interactive: true, fetchImpl: async (input, init = {}) => fastAcme.handle(new URL(input), init) });
  assert.deepEqual([quick.status, fastAcme.orders.length], ["ready", 1], "a provider with no wait still orders while the owner waits");
});

test("the owner's settings run their checks as interactive runs, with the plugins' providers only when chosen", async () => {
  const { ownerChecks } = await import("../../src/edge/maintain.js");
  const clock = { now: Date.UTC(2026, 9, 14) };
  const slow = fakeProvider({ settleMs: 150_000 });
  const acme = acmeServer(slow);
  let loads = 0;
  const { checkLan, checkWan } = ownerChecks({
    loadProviders: async () => {
      loads += 1;
      return [slow.definition];
    },
    lan: {
      node: fakeLanNode(clock, "https://yolo-abc123.owner.workers.dev"), now: () => clock.now, log: () => {}, sleep: async () => {}, waitForTxt: async () => true,
      fetchImpl: async (input, init = {}) => acme.handle(new URL(input), init),
    },
  });
  assert.equal(typeof checkWan, "function");
  const checked = await checkLan(providerEnv(createMemoryKv(), createTestD1()));
  assert.deepEqual([checked.status, acme.orders.length, loads], ["pending", 0, 1], "no 3-minute order inside the owner's request");
  await checkLan({ PUBLIC_ORIGIN: "https://yolo.example.com", OAUTH_KV: createMemoryKv() });
  assert.equal(loads, 1, "Cloudflare's zone needs no plugin");
});

test("a provider's settle time is capped at 5 minutes", async () => {
  const clock = { now: Date.UTC(2026, 9, 14) };
  const dns = fakeProvider({ settleMs: 60 * 60_000 });
  const acme = acmeServer(dns);
  const sleeps = [];
  const lan = await maintainLan(providerEnv(createMemoryKv(), createTestD1()), {
    providers: [dns.definition], node: fakeLanNode(clock, "https://yolo-abc123.owner.workers.dev"), now: () => clock.now, log: () => {}, waitForTxt: async () => true,
    sleep: async (ms) => sleeps.push(ms),
    fetchImpl: async (input, init = {}) => acme.handle(new URL(input), init),
  });
  assert.equal(lan.status, "ready");
  assert.deepEqual(sleeps.filter((ms) => ms >= 60_000), [5 * 60_000]);
});

test("a provider's secret must be a secret: a binding of the same name is refused", async () => {
  const kv = createMemoryKv();
  const dns = fakeProvider();
  const env = providerEnv(kv, createTestD1(), { FAKE_DNS_TOKEN: createMemoryKv() });
  const lan = await maintainLan(env, { providers: [dns.definition], node: { request: async () => assert.fail("no node call") }, log: () => {}, fetchImpl: async () => assert.fail("no request") });
  assert.equal(lan.status, "error");
  assert.match(lan.error.message, /FAKE_DNS_TOKEN.*not a secret/);
  assert.deepEqual(dns.made, []);
});

test("the cron run loads the plugins' providers only when the instance chose one", async () => {
  const kv = createMemoryKv();
  let loads = 0;
  const loadProviders = async () => {
    loads += 1;
    return [];
  };
  await maintainMediaNames({ PUBLIC_ORIGIN: "https://yolo.example.com", OAUTH_KV: kv, DB: createTestD1() }, { loadProviders, lan: { log: () => {} }, wan: { log: () => {} } });
  assert.equal(loads, 0, "Cloudflare's zone needs no plugin");
  await maintainMediaNames(providerEnv(kv, createTestD1()), { loadProviders, lan: { log: () => {} }, wan: { log: () => {} } });
  assert.equal(loads, 1);
});

test("turning remote access off closes the node's listener first, even when the DNS records cannot be removed, and removes them later", async () => {
  const clock = { now: Date.UTC(2026, 9, 14) };
  const db = createTestD1();
  const kv = createMemoryKv();
  const dns = cloudflare();
  const acme = acmeServer(dns);
  const node = fakeWanNode(clock);
  let refuse = false;
  const env = { MEDIA_DNS_TOKEN: TOKEN, PUBLIC_ORIGIN: "https://yolo.example.com", OAUTH_KV: kv, DB: db };
  const logs = [];
  const run = () => maintainWan(env, {
    node, sleep: async () => {}, now: () => clock.now, log: (record) => logs.push(record), waitForTxt: async () => true,
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (!String(input).startsWith(CLOUDFLARE_API)) return acme.handle(url, init);
      if (refuse && init.method === "DELETE") return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
      return dns.handle(url, init);
    },
    probe: async () => Response.json({ ok: true, name: node.name, path: "wan" }),
  });
  const records = () => [...dns.records.values()].filter((record) => record.type === "A").map(({ content }) => content);

  await writeMediaSettings(db, "usr_owner", { remote: true });
  assert.equal((await run()).status, "ok");
  refuse = true;
  await writeMediaSettings(db, "usr_owner", { remote: false });
  const off = await run();
  assert.deepEqual([off.status, node.enabled], ["off", false], "the listener closes although the records stay");
  assert.deepEqual(records(), ["73.63.154.63"]);
  assert.ok(logs.some((record) => record.event === "records_left"));

  refuse = false;
  clock.now += 30 * 60_000;
  assert.equal((await run()).status, "off");
  assert.deepEqual(records(), [], "a later run removes them");
});

test("turning remote access off or on while another run's order holds the lease takes effect at once: the lease guards only naming and ordering", async () => {
  const clock = { now: Date.UTC(2026, 9, 14) };
  const db = createTestD1();
  const kv = createMemoryKv();
  const dns = cloudflare();
  const acme = acmeServer(dns);
  const node = fakeWanNode(clock);
  const env = { MEDIA_DNS_TOKEN: TOKEN, PUBLIC_ORIGIN: "https://yolo.example.com", OAUTH_KV: kv, DB: db };
  const options = {
    node, sleep: async () => {}, now: () => clock.now, log: () => {}, waitForTxt: async () => true,
    fetchImpl: async (input, init = {}) => (String(input).startsWith(CLOUDFLARE_API) ? dns.handle(new URL(input), init) : acme.handle(new URL(input), init)),
    probe: async () => Response.json({ ok: true, name: node.name, path: "wan" }),
  };
  const records = () => [...dns.records.values()].filter((record) => record.type === "A").map(({ content }) => content);
  await writeMediaSettings(db, "usr_owner", { remote: true });
  assert.equal((await maintainWan(env, options)).status, "ok");

  // The cron run is renewing the LAN certificate when the owner switches.
  await kv.put(lease.EDGE_LEASE_KEY, JSON.stringify({ id: "the-cron-run", until: clock.now + 10 * 60_000 }));
  await writeMediaSettings(db, "usr_owner", { remote: false });
  const off = await maintainWan(env, { ...options, interactive: true });
  assert.deepEqual([off.status, node.enabled, records()], ["off", false, []], "the listener closes and the record goes, as the settings say");

  await writeMediaSettings(db, "usr_owner", { remote: true });
  const on = await maintainWan(env, { ...options, interactive: true });
  assert.deepEqual([on.status, node.enabled, records()], ["ok", true, ["73.63.154.63"]], "the existing name comes back at once");
  assert.equal(acme.orders.length, 1, "no order under another run's lease");
  assert.equal(JSON.parse(await kv.get(lease.EDGE_LEASE_KEY)).id, "the-cron-run", "the other run's lease stays");
});

test("with a slow provider only the cron run names the node: the owner's check, which can miss the cron's KV writes for a minute, never picks a name", async () => {
  const clock = { now: Date.UTC(2026, 9, 14) };
  const db = createTestD1();
  const kv = createMemoryKv();
  await writeMediaSettings(db, "usr_owner", { remote: true });
  const slow = fakeProvider({ settleMs: 150_000 });
  const acme = acmeServer(slow);
  const env = providerEnv(kv, db);
  const nodes = fakeNodes(clock, env.PUBLIC_ORIGIN);
  const seams = {
    providers: [slow.definition], now: () => clock.now, log: () => {}, sleep: async () => {}, waitForTxt: async () => true,
    fetchImpl: async (input, init = {}) => acme.handle(new URL(input), init),
  };

  // The check, served from a location whose KV does not show the cron's name yet.
  const lan = await maintainLan(env, { ...seams, node: nodes.lan, interactive: true });
  const wan = await maintainWan(env, { ...seams, node: nodes.wan, interactive: true, probe: async () => assert.fail("no probe") });
  assert.deepEqual([lan.status, lan.name, wan.status, wan.name], ["pending", null, "pending", null]);
  assert.match(wan.reason ?? "", /cron run names/);
  assert.deepEqual([nodes.calls, slow.addresses(), await kv.get(LAN_STATE_KEY), await kv.get(WAN_STATE_KEY)], [0, [], null, null], "no name for the node, no record, nothing saved");

  await maintainMediaNames(env, {
    now: () => clock.now, log: () => {}, loadProviders: async () => [slow.definition],
    lan: { ...seams, node: nodes.lan }, wan: { ...seams, node: nodes.wan, probe: async () => Response.json({ ok: true, name: nodes.wan.name, path: "wan" }) },
  });
  assert.match(JSON.parse(await kv.get(LAN_STATE_KEY)).name, /^yolo-lan-/, "the cron run names it");

  // A provider with no wait is named on the owner's check, as Cloudflare's zone is.
  const fast = fakeProvider({ settleMs: 0 });
  const fastAcme = acmeServer(fast);
  const quick = await maintainLan(providerEnv(createMemoryKv(), createTestD1()), {
    ...seams, providers: [fast.definition], node: fakeLanNode(clock, env.PUBLIC_ORIGIN), interactive: true,
    fetchImpl: async (input, init = {}) => fastAcme.handle(new URL(input), init),
  });
  assert.match(quick.name ?? "", /^yolo-lan-/);
});

test("the lease lasts as long as a cron run may, and a run deletes only its own", async () => {
  assert.equal(lease.LEASE_MS, 15 * 60_000, "a cron run's wall-time limit");
  const kv = createMemoryKv();
  const writes = [];
  const put = kv.put;
  kv.put = async (key, value, options) => {
    writes.push({ key, options });
    return put(key, value, options);
  };
  const run = lease.createEdgeRun(kv, { now: () => 1_000_000 });
  assert.equal(await run.mayOrder(), true);
  assert.deepEqual(writes, [{ key: lease.EDGE_LEASE_KEY, options: { expirationTtl: 900 } }]);
  assert.equal(JSON.parse(await kv.get(lease.EDGE_LEASE_KEY)).until, 1_000_000 + 15 * 60_000);

  // Its lease expired and another run took one; this run's end leaves that alone.
  await kv.put(lease.EDGE_LEASE_KEY, JSON.stringify({ id: "the-next-run", until: 2_000_000 }));
  await run.done();
  assert.equal(JSON.parse(await kv.get(lease.EDGE_LEASE_KEY)).id, "the-next-run");
});

test("a cron run logs a failed path the way it always did when KV or a plugin fails, and never throws", async (t) => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  t.after(() => {
    console.error = original;
  });
  const broken = { get: async () => {
    throw new Error("KV is unavailable");
  }, put: async () => {}, delete: async () => {} };
  await maintainMediaNames({ MEDIA_DNS_TOKEN: TOKEN, PUBLIC_ORIGIN: "https://yolo.example.com", OAUTH_KV: broken, DB: createTestD1() }, { lan: { log: () => {} }, wan: { log: () => {} } });
  assert.deepEqual(errors.map((line) => line.split(" ").slice(0, 3).join(" ")), ["LAN maintenance failed", "Remote maintenance failed"]);

  errors.length = 0;
  await maintainMediaNames(providerEnv(createMemoryKv(), createTestD1()), {
    lan: { log: () => {} }, wan: { log: () => {} },
    loadProviders: async () => {
      throw new Error("the plugin's factory failed");
    },
  });
  assert.deepEqual(errors.map((line) => line.split(" ").slice(0, 3).join(" ")), ["LAN maintenance failed", "Remote maintenance failed"]);
});

test("records left after remote access went off are retried with the certificate backoff, not on every run", async () => {
  const clock = { now: Date.UTC(2026, 9, 14) };
  const db = createTestD1();
  const kv = createMemoryKv();
  const dns = cloudflare();
  const acme = acmeServer(dns);
  const node = fakeWanNode(clock);
  let refuse = false;
  let deletes = 0;
  const env = { MEDIA_DNS_TOKEN: TOKEN, PUBLIC_ORIGIN: "https://yolo.example.com", OAUTH_KV: kv, DB: db };
  const run = () => maintainWan(env, {
    node, sleep: async () => {}, now: () => clock.now, log: () => {}, waitForTxt: async () => true,
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (!String(input).startsWith(CLOUDFLARE_API)) return acme.handle(url, init);
      if (init.method === "DELETE") {
        deletes += 1;
        if (refuse) return Response.json({ success: false, errors: [{ code: 10000, message: "Invalid API Token" }] }, { status: 403 });
      }
      return dns.handle(url, init);
    },
    probe: async () => Response.json({ ok: true, name: node.name, path: "wan" }),
  });
  await writeMediaSettings(db, "usr_owner", { remote: true });
  await run();
  refuse = true;
  deletes = 0;
  await writeMediaSettings(db, "usr_owner", { remote: false });
  for (let minute = 0; minute < 60; minute += 5) {
    await run();
    clock.now += 5 * 60_000;
  }
  assert.equal(deletes, 2, "the switch's run and one retry 30 minutes later, not 12");
  refuse = false;
  clock.now += 30 * 60_000;
  await run();
  assert.equal([...dns.records.values()].some((record) => record.type === "A"), false, "removed once the token works again");
});
