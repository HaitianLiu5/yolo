import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../src/control.js";
import { createDesecProvider } from "../src/desec.js";

// The deSEC DNS provider's contract with the control plane, against a
// stand-in of deSEC's REST API that never reaches desec.io
// (Agent Note 2026-10-14-dns-provider-plugins). ops/test/media-dns-plugin
// covers the setup entry through provision.

const TOKEN = "desec-token-never-shown";
const ZONE = "home.dedyn.io";
const API = "https://desec.test/api/v1";

// deSEC as far as the plugin uses it: the domain, bulk PUT on rrsets/, and
// DELETE of one RRset; `queue` holds answers (429s) that come first.
function fakeDesec({ minimumTtl = 60 } = {}) {
  const rrsets = new Map();
  const requests = [];
  const queue = [];
  const fetch = async (input, init = {}) => {
    const path = new URL(input).pathname.replace("/api/v1", "");
    const body = init.body && JSON.parse(init.body);
    requests.push([init.method ?? "GET", path, body]);
    if (queue.length) return queue.shift()();
    if (new Headers(init.headers).get("authorization") !== `Token ${TOKEN}`) return Response.json({ detail: "Invalid token." }, { status: 401 });
    if (path === `/domains/${ZONE}/`) return Response.json({ name: ZONE, minimum_ttl: minimumTtl });
    if (init.method === "DELETE") {
      rrsets.delete(path.split("/").slice(4, 6).join("/"));
      return new Response(null, { status: 204 });
    }
    if (body.some((rrset) => rrset.ttl < minimumTtl)) return Response.json([{ ttl: [`Ensure this value is greater than or equal to ${minimumTtl}.`] }], { status: 400 });
    for (const rrset of body) rrsets.set(`${rrset.subname || "@"}/${rrset.type}`, rrset);
    return Response.json(body);
  };
  return { fetch, rrsets, requests, queue };
}
const throttled = (seconds) => () => new Response(JSON.stringify({ detail: "Request was throttled." }), { status: 429, headers: seconds ? { "retry-after": String(seconds) } : {} });
const provider = (desec, sleeps = []) => createDesecProvider({ token: TOKEN, zone: ZONE, api: API, fetch: desec.fetch, sleep: async (ms) => sleeps.push(ms) });

test("the plugin registers provider desec with its secret DESEC_TOKEN, and records are written in one request each at the zone's TTL", async () => {
  const registered = [];
  register({ options: {}, log: console, registerDnsProvider: (id, definition) => registered.push({ id, ...definition }) });
  assert.deepEqual(registered.map(({ id, secret }) => [id, secret]), [["desec", "DESEC_TOKEN"]]);
  assert.ok(registered[0].create({ token: TOKEN, zone: ZONE, fetch: async () => {} }).settleMs >= 60_000, "a TXT record gets time to reach every deSEC nameserver");

  const desec = fakeDesec();
  const dns = provider(desec);
  const zone = await dns.zone();
  assert.deepEqual(zone, { id: ZONE, name: ZONE, ttl: 60 });
  await dns.setAddress(zone, `yolo-lan-1.${ZONE}`, "A", "192.168.1.20");
  await dns.setAddress(zone, ZONE, "AAAA", "2001:db8::20");
  await dns.clearAddress(zone, `yolo-lan-1.${ZONE}`, "A");
  const handle = await dns.setTxt(zone, `_acme-challenge.yolo-lan-1.${ZONE}`, "value");
  await dns.clearTxt(zone, `_acme-challenge.yolo-lan-1.${ZONE}`, "value", handle);
  assert.deepEqual(desec.requests, [
    ["GET", `/domains/${ZONE}/`, undefined],
    ["PUT", `/domains/${ZONE}/rrsets/`, [{ subname: "yolo-lan-1", type: "A", records: ["192.168.1.20"], ttl: 60 }]],
    ["PUT", `/domains/${ZONE}/rrsets/`, [{ subname: "", type: "AAAA", records: ["2001:db8::20"], ttl: 60 }]],
    ["DELETE", `/domains/${ZONE}/rrsets/yolo-lan-1/A/`, undefined],
    ["PUT", `/domains/${ZONE}/rrsets/`, [{ subname: "_acme-challenge.yolo-lan-1", type: "TXT", records: ["\"value\""], ttl: 60 }]],
    ["DELETE", `/domains/${ZONE}/rrsets/_acme-challenge.yolo-lan-1/TXT/`, undefined],
  ]);

  // A TTL that deSEC raised is read again and kept in the zone.
  const raised = fakeDesec({ minimumTtl: 3600 });
  await provider(raised).setAddress(zone, `yolo-lan-1.${ZONE}`, "A", "192.168.1.21");
  assert.equal(zone.ttl, 3600);
  assert.equal(raised.rrsets.get("yolo-lan-1/A").ttl, 3600);
});

test("a name outside the zone is refused before any request; rate limits wait within a run; errors never carry the token", async () => {
  const desec = fakeDesec();
  const sleeps = [];
  const dns = provider(desec, sleeps);
  const zone = { id: ZONE, name: ZONE, ttl: 60 };
  for (const name of ["yolo-lan-1.other.dedyn.io", "evilhome.dedyn.io", "dedyn.io"]) {
    await assert.rejects(dns.setAddress(zone, name, "A", "192.168.1.20"), { code: "invalid_request" });
  }
  assert.deepEqual(desec.requests, []);

  desec.queue.push(throttled(2), throttled(null));
  await dns.setAddress(zone, `yolo-lan-1.${ZONE}`, "A", "192.168.1.20");
  assert.deepEqual(sleeps, [2000, 2000]);
  // deSEC's hourly or daily limit: no waiting inside a cron run.
  desec.queue.push(throttled(2400));
  await assert.rejects(dns.setAddress(zone, `yolo-lan-1.${ZONE}`, "A", "192.168.1.21"), (error) => error.code === "rate_limited" && /2400 seconds/.test(error.message));

  const wrong = createDesecProvider({ token: "another", zone: ZONE, api: API, fetch: desec.fetch, sleep: async () => {} });
  await assert.rejects(wrong.setTxt(zone, `_acme-challenge.${ZONE}`, "v"), (error) => error.code === "forbidden" && /DESEC_TOKEN/.test(error.message) && !error.message.includes(TOKEN));
});
