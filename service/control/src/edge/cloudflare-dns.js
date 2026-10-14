import { YoloError } from "@useyolo/core";

// The built-in DNS provider: the owner's zone through the Cloudflare API, with
// the MEDIA_DNS_TOKEN Worker secret (Agent Note 2026-10-12-lan-direct-play,
// Agent Note 2026-10-13-media-off-the-worker). The token needs Zone Read (to
// find the zone's id) and DNS Edit on that zone, nothing else. Records are
// DNS-only: Cloudflare does not proxy to private addresses, and media must
// not pass through Cloudflare's proxy. `cloudflareDns()` is the provider
// interface of edge/dns.js over this client.

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
export const RECORD_TTL = 60;
const IDENTICAL_RECORD = 81057;

/**
 * The Cloudflare API token for the media names: MEDIA_DNS_TOKEN. Its name
 * before 0.5, LAN_DNS_TOKEN, is no longer read
 * (Agent Note 2026-10-13-versions-and-releases).
 */
export const dnsToken = (env) => env.MEDIA_DNS_TOKEN || null;

export function createDnsClient({ token, fetchImpl = (...args) => fetch(...args), api = CLOUDFLARE_API }) {
  async function call(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new YoloError("resolve_failed", "The Cloudflare API did not answer", { cause: error });
    }
    const data = await response.json().catch(() => null);
    if (response.ok && data?.success) return data.result;
    const first = data?.errors?.[0];
    throw Object.assign(new YoloError(response.status === 401 || response.status === 403 ? "forbidden" : "resolve_failed",
      `Cloudflare API: ${first?.message || `HTTP ${response.status}`}`), { apiCode: first?.code ?? null });
  }

  const records = (zoneId, query = "") => `/zones/${encodeURIComponent(zoneId)}/dns_records${query}`;

  return {
    // The most specific zone the token can read that contains `hostname`.
    async findZone(hostname) {
      const labels = String(hostname).toLowerCase().split(".");
      for (let index = 0; index < labels.length - 1; index += 1) {
        const candidate = labels.slice(index).join(".");
        const [zone] = await call("GET", `/zones?${new URLSearchParams({ name: candidate })}`);
        if (zone?.id) return { id: zone.id, name: zone.name };
      }
      return null;
    },

    // The name's A (or AAAA) record, created or moved to `address`.
    async upsertAddress(zoneId, name, address, { type = "A", comment = "Yolo LAN direct play (managed by Yolo)" } = {}) {
      const [existing] = await call("GET", records(zoneId, `?${new URLSearchParams({ type, name })}`));
      const fields = { content: address, ttl: RECORD_TTL, proxied: false };
      if (existing) {
        if (existing.content === address && existing.proxied === false && existing.ttl === RECORD_TTL) return existing;
        return call("PATCH", records(zoneId, `/${encodeURIComponent(existing.id)}`), fields);
      }
      return call("POST", records(zoneId), { type, name, ...fields, comment });
    },

    // Deletes the name's records of `type`; returns how many there were.
    async deleteAddress(zoneId, name, type = "A") {
      const found = await call("GET", records(zoneId, `?${new URLSearchParams({ type, name })}`));
      for (const record of found) await call("DELETE", records(zoneId, `/${encodeURIComponent(record.id)}`));
      return found.length;
    },

    // A TXT record; null when an identical one exists already.
    async createTxt(zoneId, name, value) {
      try {
        return (await call("POST", records(zoneId), { type: "TXT", name, content: `"${value}"`, ttl: RECORD_TTL })).id;
      } catch (error) {
        if (error.apiCode === IDENTICAL_RECORD) return null;
        throw error;
      }
    },

    async deleteRecord(zoneId, id) {
      if (id) await call("DELETE", records(zoneId, `/${encodeURIComponent(id)}`));
    },
  };
}

/**
 * The provider interface (edge/dns.js) over the zone that holds the page's
 * host. A TXT record's handle is its record id.
 */
export function cloudflareDns({ token, fetchImpl }) {
  const client = createDnsClient({ token, fetchImpl });
  return {
    async zone(pageHost) {
      const zone = await client.findZone(pageHost);
      if (!zone) throw new YoloError("forbidden", `MEDIA_DNS_TOKEN cannot read a zone that contains ${pageHost}; give it Zone Read and DNS Edit on that zone`);
      return zone;
    },
    setAddress: (zone, name, type, address, { comment } = {}) => client.upsertAddress(zone.id, name, address, { type, comment }),
    clearAddress: (zone, name, type) => client.deleteAddress(zone.id, name, type),
    setTxt: (zone, name, value) => client.createTxt(zone.id, name, value),
    clearTxt: (zone, _name, _value, id) => client.deleteRecord(zone.id, id),
  };
}
