import assert from "node:assert/strict";
import { test } from "node:test";
import { base64url } from "@useyolo/core";
import { dnsChallengeValue, LETS_ENCRYPT_STAGING_DIRECTORY } from "../../src/lan/acme.js";
import { CLOUDFLARE_API } from "../../src/lan/dns.js";
import { LAN_STATE_KEY, lanWelcome, maintainLan } from "../../src/lan/maintain.js";
import { createMemoryKv } from "../helpers/kv.js";

// LAN direct play's control plane side (Agent Note 2026-10-12-lan-direct-play)
// against stand-ins: an ACME server answering at Let's Encrypt's staging
// directory that checks JWS signatures and the DNS-01 record, the
// Cloudflare DNS API, and the node behind nodeFetch().

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
  const env = { LAN_DNS_TOKEN: TOKEN, PUBLIC_ORIGIN: "https://yolo.example.com", OAUTH_KV: kv };
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
