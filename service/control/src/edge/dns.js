import { YoloError } from "@useyolo/core";

// The owner's zone through the Cloudflare API, with the MEDIA_DNS_TOKEN
// Worker secret (Agent Note 2026-10-12-lan-direct-play,
// Agent Note 2026-10-13-media-off-the-worker). The token needs Zone Read (to
// find the zone's id) and DNS Edit on that zone, nothing else. Records are
// DNS-only: Cloudflare does not proxy to private addresses, and media must
// not pass through Cloudflare's proxy.

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
export const RECORD_TTL = 60;
const IDENTICAL_RECORD = 81057;

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

// Whether public DNS answers `name` with the TXT `value` yet. Cloudflare's
// authoritative servers usually have a new record within seconds; asking a
// public resolver avoids an ACME validation that fails early.
export async function waitForTxt(name, value, {
  fetchImpl = (...args) => fetch(...args), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), timeoutMs = 60_000, intervalMs = 3_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`https://cloudflare-dns.com/dns-query?${new URLSearchParams({ name, type: "TXT" })}`, { headers: { accept: "application/dns-json" } });
      const data = await response.json();
      if ((data?.Answer || []).some((answer) => String(answer.data).replace(/"/g, "") === value)) return true;
    } catch {
      // Try again.
    }
    await sleep(intervalMs);
  }
  return false;
}
