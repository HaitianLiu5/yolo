import assert from "node:assert/strict";
import { test } from "node:test";
import { YoloError } from "@useyolo/plugin-api";
import register from "../src/control.js";
import { createDesecProvider, DESEC_API, PROVIDER, SECRET, SETTLE_MS } from "../src/desec.js";
import { API, fakeDesec, throttled } from "./fake-desec.js";

// The deSEC DNS provider against a stand-in of deSEC's API: the records and
// challenges the control plane asks for, deSEC's limits, and its errors.

const TOKEN = "desec-token-never-shown";
const ZONE = "home.dedyn.io";

function provider(desec, { sleeps = [], zone = ZONE } = {}) {
  return createDesecProvider({
    token: TOKEN, zone, api: API, fetch: desec.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

test("the plugin registers the deSEC provider with its own secret, and the provider talks to deSEC's API", async () => {
  const registered = [];
  register({ options: {}, log: console, registerDnsProvider: (id, definition) => registered.push({ id, ...definition }) });
  assert.deepEqual(registered.map(({ id, secret }) => ({ id, secret })), [{ id: "desec", secret: "DESEC_TOKEN" }]);
  assert.deepEqual([PROVIDER, SECRET, DESEC_API], ["desec", "DESEC_TOKEN", "https://desec.io/api/v1"]);
  const made = registered[0].create({ token: TOKEN, zone: ZONE, fetch: async () => {}, sleep: async () => {} });
  for (const method of ["zone", "setAddress", "clearAddress", "setTxt", "clearTxt"]) assert.equal(typeof made[method], "function", method);
  assert.ok(made.settleMs >= 60_000, "a new TXT record is given time to reach every deSEC nameserver");
  assert.equal(made.settleMs, SETTLE_MS);
  assert.throws(() => registered[0].create({ token: TOKEN, zone: null, fetch: async () => {} }), (error) => error instanceof YoloError && /media\.dns\.zone/.test(error.message));
});

test("the zone is the configured deSEC name, read with the token, with the domain's minimum TTL", async () => {
  const desec = fakeDesec({ token: TOKEN, minimumTtl: 60 });
  const zone = await provider(desec).zone("yolo-abc123.owner.workers.dev");
  assert.deepEqual(zone, { id: ZONE, name: ZONE, ttl: 60 });
  assert.deepEqual(desec.requests.map(({ method, path, authorization }) => [method, path, authorization]), [
    ["GET", "/api/v1/domains/home.dedyn.io/", `Token ${TOKEN}`],
  ]);

  // A custom domain at deSEC has a minimum TTL of an hour.
  const custom = fakeDesec({ token: TOKEN, domain: "example.net", minimumTtl: 3600 });
  assert.equal((await provider(custom, { zone: "example.net" }).zone()).ttl, 3600);

  const other = fakeDesec({ token: TOKEN, domain: "someone-else.dedyn.io" });
  await assert.rejects(provider(other).zone(), (error) => error.code === "forbidden" && /home\.dedyn\.io/.test(error.message) && !error.message.includes(TOKEN));
});

test("an address record is created, moved, and cleared with one write each, at the zone's minimum TTL, and a private address is accepted", async () => {
  const desec = fakeDesec({ token: TOKEN });
  const dns = provider(desec);
  const zone = await dns.zone();
  const name = "yolo-lan-3f9a01c2.home.dedyn.io";

  await dns.setAddress(zone, name, "A", "192.168.1.20");
  assert.deepEqual(desec.get("yolo-lan-3f9a01c2", "A"), { subname: "yolo-lan-3f9a01c2", type: "A", records: ["192.168.1.20"], ttl: 60 });
  await dns.setAddress(zone, name, "A", "192.168.1.31");
  await dns.setAddress(zone, "yolo-wan-0badcafe.home.dedyn.io", "AAAA", "2001:db8::20");
  assert.deepEqual(desec.get("yolo-lan-3f9a01c2", "A").records, ["192.168.1.31"]);
  assert.deepEqual(desec.writes().map(({ method, path, body }) => [method, path, body]), [
    ["PUT", "/api/v1/domains/home.dedyn.io/rrsets/", [{ subname: "yolo-lan-3f9a01c2", type: "A", records: ["192.168.1.20"], ttl: 60 }]],
    ["PUT", "/api/v1/domains/home.dedyn.io/rrsets/", [{ subname: "yolo-lan-3f9a01c2", type: "A", records: ["192.168.1.31"], ttl: 60 }]],
    ["PUT", "/api/v1/domains/home.dedyn.io/rrsets/", [{ subname: "yolo-wan-0badcafe", type: "AAAA", records: ["2001:db8::20"], ttl: 60 }]],
  ], "no read before a write: the zone carries the TTL");

  await dns.clearAddress(zone, name, "A");
  await dns.clearAddress(zone, name, "AAAA");
  assert.equal(desec.get("yolo-lan-3f9a01c2", "A"), null);
  assert.deepEqual(desec.writes().slice(3).map(({ method, path }) => [method, path]), [
    ["DELETE", "/api/v1/domains/home.dedyn.io/rrsets/yolo-lan-3f9a01c2/A/"],
    ["DELETE", "/api/v1/domains/home.dedyn.io/rrsets/yolo-lan-3f9a01c2/AAAA/"],
  ], "clearing a record that is not there succeeds too");

  // The apex is "@" in a URL and "" in a body.
  await dns.setAddress(zone, ZONE, "A", "192.168.1.5");
  await dns.clearAddress(zone, ZONE, "A");
  assert.deepEqual(desec.writes().slice(5).map(({ method, path, body }) => [method, path, body?.[0]?.subname]), [
    ["PUT", "/api/v1/domains/home.dedyn.io/rrsets/", ""],
    ["DELETE", "/api/v1/domains/home.dedyn.io/rrsets/@/A/", undefined],
  ]);

  // A zone from an older state without its TTL reads the domain once.
  const fresh = fakeDesec({ token: TOKEN, minimumTtl: 120 });
  const older = provider(fresh);
  await older.setAddress({ id: ZONE, name: ZONE }, name, "A", "192.168.1.20");
  await older.setAddress({ id: ZONE, name: ZONE }, name, "A", "192.168.1.21");
  assert.deepEqual(fresh.requests.map(({ method }) => method), ["GET", "PUT", "PUT"]);
  assert.equal(fresh.get("yolo-lan-3f9a01c2", "A").ttl, 120);
});

test("a DNS-01 value replaces whatever is at its name, so a value a failed removal left behind goes too, and the RRset goes after the order", async () => {
  const desec = fakeDesec({ token: TOKEN });
  const dns = provider(desec);
  const zone = await dns.zone();
  const name = "_acme-challenge.yolo-lan-3f9a01c2.home.dedyn.io";
  const sub = "_acme-challenge.yolo-lan-3f9a01c2";
  // An earlier order's value, whose removal failed.
  await dns.setTxt(zone, name, "stale-value");
  desec.requests.length = 0;

  const handle = await dns.setTxt(zone, name, "value-two");
  assert.deepEqual(desec.get(sub, "TXT"), { subname: sub, type: "TXT", records: ["\"value-two\""], ttl: 60 }, "only the new value, quoted as deSEC requires");
  await dns.clearTxt(zone, name, "value-two", handle);
  assert.equal(desec.get(sub, "TXT"), null);
  assert.deepEqual(desec.requests.map(({ method, path }) => [method, path]), [
    ["PUT", "/api/v1/domains/home.dedyn.io/rrsets/"],
    ["DELETE", "/api/v1/domains/home.dedyn.io/rrsets/_acme-challenge.yolo-lan-3f9a01c2/TXT/"],
  ], "one request each, no read: two subrequests an order");
});

test("a TTL that deSEC raised is read again and kept in the zone", async () => {
  const desec = fakeDesec({ token: TOKEN, minimumTtl: 3600 });
  const dns = provider(desec);
  const zone = { id: ZONE, name: ZONE, ttl: 60 };
  await dns.setAddress(zone, "yolo-lan-3f9a01c2.home.dedyn.io", "A", "192.168.1.20");
  assert.equal(desec.get("yolo-lan-3f9a01c2", "A").ttl, 3600);
  assert.equal(zone.ttl, 3600, "the media state keeps the new TTL");
  assert.deepEqual(desec.requests.map(({ method }) => method), ["PUT", "GET", "PUT"]);
});

test("a name outside the zone is refused before any request", async () => {
  const desec = fakeDesec({ token: TOKEN });
  const dns = provider(desec);
  for (const name of ["yolo-lan-1.other.dedyn.io", "evilhome.dedyn.io", "dedyn.io"]) {
    await assert.rejects(dns.setAddress({ id: ZONE, name: ZONE, ttl: 60 }, name, "A", "192.168.1.20"), (error) => error.code === "invalid_request" && error.message.includes(name));
  }
  assert.deepEqual(desec.requests, []);
});

test("deSEC's rate limits: a 429 waits for Retry-After or backs off, then retries; a wait longer than a run allows fails at once", async () => {
  const desec = fakeDesec({ token: TOKEN });
  const sleeps = [];
  const dns = provider(desec, { sleeps });
  const zone = { id: ZONE, name: ZONE, ttl: 60 };
  const name = "yolo-lan-3f9a01c2.home.dedyn.io";

  desec.script(throttled(2));
  await dns.setAddress(zone, name, "A", "192.168.1.20");
  assert.deepEqual(sleeps, [2000]);
  assert.deepEqual(desec.get("yolo-lan-3f9a01c2", "A").records, ["192.168.1.20"]);

  // Without Retry-After: 1 second, then 2.
  sleeps.length = 0;
  desec.script(throttled(null), throttled(null));
  await dns.setAddress(zone, name, "A", "192.168.1.21");
  assert.deepEqual(sleeps, [1000, 2000]);

  // Server errors back off the same way.
  sleeps.length = 0;
  desec.script(() => new Response("Bad gateway", { status: 502 }));
  await dns.setAddress(zone, name, "A", "192.168.1.22");
  assert.deepEqual(sleeps, [1000]);

  // The hourly or daily limit: no waiting inside a cron run.
  sleeps.length = 0;
  desec.script(throttled(2400));
  await assert.rejects(dns.setAddress(zone, name, "A", "192.168.1.23"), (error) => error instanceof YoloError && error.code === "rate_limited" && /2400 seconds/.test(error.message));
  assert.deepEqual(sleeps, []);

  // Three 429s in a row: give up after two retries.
  desec.script(throttled(1), throttled(1), throttled(1));
  await assert.rejects(dns.setAddress(zone, name, "A", "192.168.1.24"), (error) => error.code === "rate_limited" && error.retryable);
  assert.deepEqual(sleeps, [1000, 1000]);
  assert.deepEqual(desec.get("yolo-lan-3f9a01c2", "A").records, ["192.168.1.22"]);
});

test("deSEC's refusals become Yolo errors that say why, never with the token", async () => {
  const zone = { id: ZONE, name: ZONE, ttl: 60 };
  const name = "yolo-wan-0badcafe.home.dedyn.io";

  const blocked = fakeDesec({ token: TOKEN, blocked: ["203.0.113.9"] });
  await assert.rejects(provider(blocked).setAddress(zone, name, "A", "203.0.113.9"), (error) => error.code === "invalid_request" && /IP address 203\.0\.113\.9 not allowed/.test(error.message));


  const wrong = fakeDesec({ token: "another-token" });
  await assert.rejects(provider(wrong).setTxt(zone, `_acme-challenge.${name}`, "v"), (error) => error.code === "forbidden" && /DESEC_TOKEN/.test(error.message) && !error.message.includes(TOKEN));

  const down = createDesecProvider({ token: TOKEN, zone: ZONE, api: API, sleep: async () => {}, fetch: async () => {
    throw new TypeError("fetch failed");
  } });
  await assert.rejects(down.zone(), (error) => error.code === "resolve_failed" && /did not answer/.test(error.message));

  const policy = fakeDesec({ token: TOKEN });
  policy.script(() => Response.json({ detail: "Insufficient token permissions." }, { status: 403 }));
  await assert.rejects(provider(policy).clearAddress(zone, name, "A"), (error) => error.code === "forbidden" && /Insufficient token permissions/.test(error.message));
});
