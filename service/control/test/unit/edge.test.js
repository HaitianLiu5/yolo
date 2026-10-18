import assert from "node:assert/strict";
import { test } from "node:test";
import { base64url, dnsChallengeValue, LETS_ENCRYPT_STAGING_DIRECTORY } from "@useyolo/core";
import { LAN_STATE_KEY } from "../../src/edge/lan.js";
import { createEdgeRun, EDGE_LEASE_KEY } from "../../src/edge/lease.js";
import { maintainMediaNames } from "../../src/edge/maintain.js";
import { WAN_STATE_KEY } from "../../src/edge/wan.js";
import { writeMediaSettings } from "../../src/store/media-settings.js";
import { createTestD1 } from "../helpers/d1.js";
import { createMemoryKv } from "../helpers/fakes.js";

// The node's media names and certificates on the control plane's side
// (Agent Note 2026-10-12-lan-direct-play, Agent Note 2026-10-14-dns-provider-plugins):
// one certificate order a cron run, under a KV lease, against a stand-in ACME
// server, a DNS provider plugin, and the node.

const DAY = 24 * 60 * 60_000;
const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

// RFC 8555 as far as one order needs: single-use nonces, and a challenge
// valid only when the zone holds the right TXT record for the account's key.
function acmeServer(dns) {
  const base = new URL(LETS_ENCRYPT_STAGING_DIRECTORY).origin;
  const nonces = new Set();
  const accounts = new Map();
  const orders = [];
  const answer = (status, body, headers = {}) => {
    const nonce = base64url(crypto.getRandomValues(new Uint8Array(12)));
    nonces.add(nonce);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "replay-nonce": nonce, ...headers } });
  };
  async function handle(input, init = {}) {
    const url = new URL(input);
    if (url.href === LETS_ENCRYPT_STAGING_DIRECTORY) return Response.json({ newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order` });
    if (url.pathname === "/nonce") return answer(200, "");
    const jws = JSON.parse(init.body);
    const header = decode(jws.protected);
    assert.ok(header.url === url.href && nonces.delete(header.nonce), "a fresh nonce for this URL");
    const payload = jws.payload ? decode(jws.payload) : undefined;
    const jwk = header.jwk ?? accounts.get(header.kid);
    if (url.pathname === "/account") {
      accounts.set(`${base}/acct/${accounts.size + 1}`, header.jwk);
      return answer(201, { status: "valid" }, { location: `${base}/acct/${accounts.size}` });
    }
    if (url.pathname === "/order") {
      const order = { id: orders.length, name: payload.identifiers[0].value, status: "pending", token: base64url(crypto.getRandomValues(new Uint8Array(16))), jwk, authz: "pending" };
      orders.push(order);
      return answer(201, { status: "pending", authorizations: [`${base}/authz/${order.id}`], finalize: `${base}/finalize/${order.id}` }, { location: `${base}/orders/${order.id}` });
    }
    const [, kind, id] = url.pathname.split("/");
    const order = orders[Number(id)];
    if (kind === "authz") return answer(200, { status: order.authz, challenges: [{ type: "dns-01", url: `${base}/challenge/${order.id}`, token: order.token }] });
    if (kind === "challenge") {
      const expected = await dnsChallengeValue(order.token, order.jwk);
      order.authz = dns.records.get(`TXT _acme-challenge.${order.name}`) === expected ? "valid" : "invalid";
      return answer(200, { status: "processing" });
    }
    if (kind === "finalize") return (order.status = "valid", answer(200, { status: "processing" }));
    if (kind === "orders") return answer(200, { status: order.status, ...(order.status === "valid" ? { certificate: `${base}/cert/${order.id}` } : {}) });
    return answer(200, `CHAIN-${order.id}`, { "content-type": "application/pem-certificate-chain" });
  }
  return { orders, handle };
}

// A DNS provider plugin's definition, keeping its records in memory.
function fakeProvider({ settleMs }) {
  const records = new Map();
  const definition = {
    id: "fake-dns", plugin: "@fixture/fake-dns", title: "Fake DNS", secret: "FAKE_DNS_TOKEN",
    create: ({ zone }) => ({
      settleMs,
      zone: async () => ({ id: zone, name: zone, ttl: 60 }),
      setAddress: async (_at, name, type, address) => void records.set(`${type} ${name}`, address),
      clearAddress: async (_at, name, type) => void records.delete(`${type} ${name}`),
      setTxt: async (_at, name, value) => (records.set(`TXT ${name}`, value), "handle"),
      clearTxt: async (_at, name) => void records.delete(`TXT ${name}`),
    }),
  };
  return { definition, records };
}

// One side of the node ("lan" or "wan"); a new name drops its certificate, as the node does.
function fakeSide(clock, side) {
  const node = { names: new Set() };
  const status = () => ({
    listening: Boolean(node.certificate), origin: node.certificate ? `https://${node.name}:9443` : null, error: null, ...node.certificate,
    ...(side === "lan" ? { address: "192.168.1.20" } : { publicAddress: "73.63.154.63", addresses: [], nat: null, mapping: { externalPort: 9443 } }),
  });
  node.request = async (path, { body }) => {
    if (path === `/internal/v1/${side}`) {
      if (body.name !== node.name) delete node.certificate;
      node.name = body.name;
      node.names.add(body.name);
      return { ...status(), csr: "-----BEGIN CERTIFICATE REQUEST-----\nTUlJQ1NS\n-----END CERTIFICATE REQUEST-----\n" };
    }
    node.certificate = { notBefore: clock.now, notAfter: clock.now + 90 * DAY };
    return status();
  };
  return node;
}

test("a cron run orders at most one certificate, keeps its names in KV before it orders, and a run that starts meanwhile orders nothing and names nothing", async () => {
  const clock = { now: Date.UTC(2026, 9, 14) };
  const db = createTestD1();
  const kv = createMemoryKv();
  await writeMediaSettings(db, "usr_owner", { remote: true });
  const dns = fakeProvider({ settleMs: 150_000 });
  const acme = acmeServer(dns);
  const env = { MEDIA_DNS_PROVIDER: "fake-dns", MEDIA_DNS_ZONE: "home.example.net", FAKE_DNS_TOKEN: "t", WAN_CERTIFICATE: "name", PUBLIC_ORIGIN: "https://yolo-abc.owner.workers.dev", OAUTH_KV: kv, DB: db };
  const nodes = { lan: fakeSide(clock, "lan"), wan: fakeSide(clock, "wan") };
  let during = null;
  const seams = {
    log: () => {}, waitForTxt: async () => true, fetchImpl: acme.handle,
    async sleep(ms) {
      clock.now += ms;
      if (ms !== 150_000 || during) return;
      // The next cron run fires while this one waits for the provider's nameservers.
      during = { saved: JSON.parse(await kv.get(LAN_STATE_KEY)).name, orders: acme.orders.length };
      clock.now += 5 * 60_000 - ms;
      const views = await cron();
      Object.assign(during, { lan: views.lan.name, wan: views.wan.name, ordered: acme.orders.length - during.orders });
    },
  };
  const cron = () => maintainMediaNames(env, {
    now: () => clock.now, log: () => {}, loadProviders: async () => [dns.definition],
    lan: { ...seams, node: nodes.lan }, wan: { ...seams, node: nodes.wan, probe: async () => Response.json({ ok: true, name: nodes.wan.name, path: "wan" }) },
  });
  const state = async (key) => JSON.parse(await kv.get(key));

  await cron();
  const lan = await state(LAN_STATE_KEY);
  assert.deepEqual(during, { saved: lan.name, orders: 1, lan: lan.name, wan: null, ordered: 0 }, "the second run kept the saved name, named nothing under the lease, and ordered nothing");
  assert.deepEqual([acme.orders.length, lan.ready, (await state(WAN_STATE_KEY)).status === "ok"], [1, true, false], "one certificate a run");
  assert.equal(await kv.get(EDGE_LEASE_KEY), null, "the lease goes with the run");

  for (const [later, orders, why] of [[5 * 60_000, 2, "the next run orders the remote one"], [DAY, 2, "nothing due"], [60 * DAY, 3, "renewal two thirds into its life"]]) {
    clock.now += later;
    await cron();
    assert.deepEqual([acme.orders.length, (await state(WAN_STATE_KEY)).status], [orders, "ok"], why);
  }
  assert.deepEqual([nodes.lan.names.size, nodes.wan.names.size], [1, 1], "the node was never given another name");
  assert.deepEqual([...dns.records.keys()].sort(), [`A ${lan.name}`, `A ${nodes.wan.name}`], "both A records, no challenge left");
});

test("the lease lasts a cron run's 15 minutes, a run deletes only its own, and a person's check never starts a slow order", async () => {
  const kv = createMemoryKv();
  const put = kv.put;
  kv.put = async (key, value, options) => (assert.deepEqual(options, { expirationTtl: 900 }), put(key, value));
  const run = createEdgeRun(kv, { now: () => 1_000_000 });
  assert.deepEqual([await run.mayOrder(), await run.mayOrder()], [true, false]);
  assert.equal(await createEdgeRun(kv, { now: () => 1_000_000 }).mayOrder(), false, "another run's lease holds");
  kv.map.set(EDGE_LEASE_KEY, JSON.stringify({ id: "the-next-run", until: 2_000_000 }));
  await run.done();
  assert.equal(JSON.parse(await kv.get(EDGE_LEASE_KEY)).id, "the-next-run");
  const owner = createEdgeRun(createMemoryKv(), { interactive: true });
  assert.deepEqual([await owner.mayOrder({ slow: true }), await owner.mayName({ slow: true }), await owner.mayOrder()], [false, false, true]);
});
