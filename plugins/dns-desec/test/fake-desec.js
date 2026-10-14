import assert from "node:assert/strict";

// A stand-in for deSEC's REST API (https://desec.readthedocs.io/), as far as
// the plugin uses it: the domain, single RRsets by subname and type ("@" for
// the apex), bulk PUT on rrsets/ that creates, replaces, or (with empty
// records) deletes, DELETE that answers 204 whether or not the RRset
// existed, token auth, the domain's minimum TTL, and deSEC's 400 for an A
// record in a blocked subnet. `script()` queues answers (such as 429s) that
// come before the stand-in's own. It never reaches the network: a request
// for desec.io itself fails the test.

export const API = "https://desec.test/api/v1";

export function fakeDesec({ token, domain = "home.dedyn.io", minimumTtl = 60, blocked = [] } = {}) {
  const rrsets = new Map();
  const requests = [];
  const queue = [];
  const key = (subname, type) => `${subname}/${type}`;
  const reply = (status, body) => (body === undefined ? new Response(null, { status }) : Response.json(body, { status }));
  const notFound = () => reply(404, { detail: "Not found." });

  async function fetch(input, init = {}) {
    const url = new URL(input);
    assert.notEqual(url.hostname, "desec.io", "tests never call deSEC itself");
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ method, path: url.pathname, body, authorization: headers.get("authorization") });
    if (queue.length) return queue.shift()();
    if (headers.get("authorization") !== `Token ${token}`) return reply(401, { detail: "Invalid token." });
    const path = url.pathname.slice(new URL(API).pathname.length);
    const domainPath = /^\/domains\/([^/]+)\/$/.exec(path);
    if (domainPath) {
      if (decodeURIComponent(domainPath[1]) !== domain) return notFound();
      return reply(200, { name: domain, minimum_ttl: minimumTtl, published: "2026-10-14T00:00:00Z", touched: "2026-10-14T00:00:00Z" });
    }
    const bulk = /^\/domains\/([^/]+)\/rrsets\/$/.exec(path);
    if (bulk) {
      if (decodeURIComponent(bulk[1]) !== domain) return notFound();
      assert.equal(method, "PUT", "rrsets are written with bulk PUT");
      for (const rrset of body) {
        if (rrset.records.length && rrset.ttl < minimumTtl) return reply(400, [{ ttl: [`Ensure this value is greater than or equal to ${minimumTtl}.`] }]);
        const refused = rrset.type === "A" && rrset.records.find((record) => blocked.includes(record));
        if (refused) return reply(400, [{ non_field_errors: [`IP address ${refused} not allowed.`] }]);
      }
      for (const rrset of body) {
        if (rrset.records.length) rrsets.set(key(rrset.subname, rrset.type), { subname: rrset.subname, type: rrset.type, records: [...rrset.records], ttl: rrset.ttl });
        else rrsets.delete(key(rrset.subname, rrset.type));
      }
      return reply(200, body.filter((rrset) => rrset.records.length));
    }
    const single = /^\/domains\/([^/]+)\/rrsets\/([^/]+)\/([A-Z]+)\/$/.exec(path);
    assert.ok(single, `unexpected deSEC call ${method} ${url.pathname}`);
    if (decodeURIComponent(single[1]) !== domain) return notFound();
    const subname = decodeURIComponent(single[2]) === "@" ? "" : decodeURIComponent(single[2]);
    const found = rrsets.get(key(subname, single[3]));
    if (method === "GET") return found ? reply(200, { domain, ...found, name: `${subname ? `${subname}.` : ""}${domain}.` }) : notFound();
    assert.equal(method, "DELETE");
    rrsets.delete(key(subname, single[3]));
    return reply(204);
  }

  return {
    fetch,
    rrsets,
    requests,
    writes: () => requests.filter((request) => request.method !== "GET"),
    get: (subname, type) => rrsets.get(key(subname, type)) ?? null,
    script(...answers) {
      queue.push(...answers);
    },
  };
}

// A 429 as deSEC sends it: a Retry-After header in seconds (or none) and a
// human-readable detail.
export const throttled = (seconds) => () => new Response(JSON.stringify({ detail: `Request was throttled. Expected available in ${seconds ?? "some"} seconds.` }), {
  status: 429,
  headers: { "content-type": "application/json", ...(seconds == null ? {} : { "retry-after": String(seconds) }) },
});
