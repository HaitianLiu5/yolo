import { YoloError } from "@useyolo/plugin-api";

// The deSEC DNS provider (Agent Note 2026-10-14-dns-provider-plugins): the
// node's media names, their address records, and their DNS-01 challenges
// under one deSEC domain, normally a free `<name>.dedyn.io`, through deSEC's
// REST API (https://desec.readthedocs.io/en/latest/dns/rrsets.html).
//
// - Auth: `Authorization: Token <secret>`, the Worker secret DESEC_TOKEN.
// - Writes are one bulk PUT to `domains/{name}/rrsets/`, which creates or
//   replaces the RRsets it lists and deletes those listed with no records;
//   DELETE of one RRset answers 204 whether or not it existed.
// - TTL: the domain's `minimum_ttl`, 60 seconds for a dedyn.io name and an
//   hour for other domains unless deSEC lowered it, read once with the zone
//   and again when deSEC refuses a TTL.
// - DNS-01: one PUT sets the challenge's RRset to the new value alone and one
//   DELETE removes the RRset, two requests an order. The control plane runs
//   one order at a time (its lease), so nothing else shares that RRset, and
//   a value a failed removal left behind goes with the next order.
// - Rate limits: RRset writes are limited per domain (2/s, 15/min, 100/h,
//   300/day) and reads per account (10/s, 50/min); a 429 carries Retry-After.
//   A wait up to a minute is taken and the request retried, at most twice;
//   a longer one fails as rate_limited, and the control plane's next run, or
//   its backoff for certificates, tries again.
// - Propagation: deSEC publishes a write at once, but its anycast
//   nameservers catch up at different times, usually within seconds and
//   sometimes minutes later, so `settleMs` asks the control plane to wait
//   after public DNS answers a challenge before the CA checks it.
//
// The token never appears in an error or a log line.

export const PROVIDER = "desec";
export const SECRET = "DESEC_TOKEN";
const DESEC_API = "https://desec.io/api/v1";
// certbot-dns-desec waits 80 seconds; deSEC's slowest nameservers have been
// measured up to about 170 seconds behind a write. With the control plane's
// at most 4 questions to a public resolver, 15 seconds apart, an order takes
// about 4 minutes, inside the 5 between cron runs.
const SETTLE_MS = 150_000;
const MIN_TTL = 60;
const DEFAULT_TTL = 3600;
const MAX_WAIT_MS = 60_000;
const RETRIES = 2;

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Retry-After in milliseconds: seconds, or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(header, now = Date.now()) {
  if (header == null || header === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

// deSEC's error bodies: { detail }, { field: [messages] }, or a list of
// those for a bulk request. One line, without structure.
function describe(data) {
  const parts = [];
  const walk = (value) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(data);
  return parts.join("; ").slice(0, 300);
}

/**
 * deSEC's API: `request(method, path, body)` → the parsed answer, or null
 * for 204; throws YoloError (not_found for 404).
 */
export function createDesecClient({ token, fetch: fetchImpl = (...args) => fetch(...args), sleep = defaultSleep, api = DESEC_API }) {
  async function request(method, path, body) {
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(`${api}${path}`, {
          method,
          headers: { authorization: `Token ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new YoloError("resolve_failed", "The deSEC API did not answer", { cause: error });
      }
      if (response.status === 429 || response.status >= 500) {
        const wait = retryAfterMs(response.headers.get("retry-after")) ?? 1000 * 2 ** attempt;
        await response.body?.cancel();
        if (attempt < RETRIES && wait <= MAX_WAIT_MS) {
          await sleep(wait);
          continue;
        }
        if (response.status === 429) {
          const seconds = Math.ceil(wait / 1000);
          throw new YoloError("rate_limited", `deSEC's API limits this domain's requests for now; it allows the next in ${seconds} second${seconds === 1 ? "" : "s"}`);
        }
        throw new YoloError("resolve_failed", `The deSEC API answered ${response.status}`);
      }
      if (response.status === 204) return null;
      const data = await response.json().catch(() => null);
      if (response.ok) return data;
      const detail = describe(data);
      if (response.status === 401) throw new YoloError("forbidden", `deSEC rejected the token in ${SECRET}: it is wrong, expired, or deleted`);
      if (response.status === 403) throw new YoloError("forbidden", `deSEC refused: ${detail || "forbidden"}`);
      if (response.status === 404) throw new YoloError("not_found", `deSEC has no ${path}`);
      throw Object.assign(new YoloError("invalid_request", `deSEC refused the change: ${detail || `HTTP ${response.status}`}`), { desec: data });
    }
  }
  return { request };
}

const normalize = (name) => String(name ?? "").trim().toLowerCase().replace(/\.$/, "");

// Whether deSEC's 400 body (one object, or one per RRset of a bulk write)
// refuses the TTL.
const refusedTtl = (data) => [data].flat().some((entry) => entry && typeof entry === "object" && Object.hasOwn(entry, "ttl"));

/** The subname of `name` in `zone` ("" for the apex), or an error for a name outside it. */
export function subnameOf(zone, name) {
  const full = normalize(name);
  if (full === zone) return "";
  if (full.endsWith(`.${zone}`)) return full.slice(0, -zone.length - 1);
  throw new YoloError("invalid_request", `${name} is not a name in the deSEC domain ${zone}`);
}

/**
 * The DNS provider the control plane calls (Agent Note
 * 2026-10-14-dns-provider-plugins). `zone` is the instance's
 * media.dns.zone (MEDIA_DNS_ZONE), the deSEC domain the names go under.
 */
export function createDesecProvider({ token, zone, fetch, sleep, api }) {
  const domain = normalize(zone);
  if (!domain) throw new YoloError("invalid_request", "No deSEC name is set: media.dns.zone in yolo.instance.json, such as yourname.dedyn.io (npm run yolo -- provision media-dns)");
  const { request } = createDesecClient({ token, fetch, sleep, api });
  const base = (zoneName) => `/domains/${encodeURIComponent(normalize(zoneName) || domain)}`;
  const one = (zoneName, subname, type) => `${base(zoneName)}/rrsets/${subname ? encodeURIComponent(subname) : "@"}/${type}/`;

  let read = null;
  const readDomain = () => (read ??= request("GET", `${base(domain)}/`).catch((error) => {
    read = null;
    if (error.code === "not_found") throw new YoloError("forbidden", `The deSEC account of ${SECRET} has no domain ${domain}: register it at desec.io, or correct media.dns.zone`);
    throw error;
  }));
  const ttlOf = (data) => Math.max(MIN_TTL, Number(data?.minimum_ttl) || DEFAULT_TTL);
  const ttl = async (zoneInfo) => (Number.isFinite(zoneInfo?.ttl) ? zoneInfo.ttl : ttlOf(await readDomain()));
  // A TTL under the domain's minimum, which deSEC may raise after the zone was
  // read: the domain is read again, the zone keeps the new TTL (the media
  // state saves it), and the write is tried once more.
  const put = async (zoneInfo, subname, type, records) => {
    const write = async () => request("PUT", `${base(zoneInfo?.name)}/rrsets/`, [{ subname, type, records, ttl: await ttl(zoneInfo) }]);
    try {
      await write();
    } catch (error) {
      if (error.code !== "invalid_request" || !refusedTtl(error.desec)) throw error;
      read = null;
      const fresh = ttlOf(await readDomain());
      if (zoneInfo && typeof zoneInfo === "object") zoneInfo.ttl = fresh;
      else throw error;
      await write();
    }
  };
  const subname = (zoneInfo, name) => subnameOf(normalize(zoneInfo?.name) || domain, name);

  return {
    settleMs: SETTLE_MS,

    // The configured domain, as long as the token's account holds it.
    async zone() {
      const data = await readDomain();
      const name = normalize(data?.name) || domain;
      return { id: name, name, ttl: ttlOf(data) };
    },

    async setAddress(zoneInfo, name, type, address) {
      await put(zoneInfo, subname(zoneInfo, name), type, [address]);
    },

    async clearAddress(zoneInfo, name, type) {
      await request("DELETE", one(zoneInfo?.name, subname(zoneInfo, name), type));
    },

    // The control plane runs one order at a time under its lease, so the new
    // value replaces the RRset: a value an earlier removal left behind goes
    // with it, and the write needs no read first.
    async setTxt(zoneInfo, name, value) {
      const quoted = `"${value}"`;
      await put(zoneInfo, subname(zoneInfo, name), "TXT", [quoted]);
      return quoted;
    },

    // The name's whole TXT RRset, which holds only this order's value.
    async clearTxt(zoneInfo, name) {
      await request("DELETE", one(zoneInfo?.name, subname(zoneInfo, name), "TXT"));
    },
  };
}
