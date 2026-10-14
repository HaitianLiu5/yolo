import { YoloError } from "@useyolo/core";
import { cloudflareDns, dnsToken } from "./cloudflare-dns.js";

// The DNS provider behind the node's media names
// (Agent Note 2026-10-14-dns-provider-plugins). The instance's
// media.dns.provider, rendered as the var MEDIA_DNS_PROVIDER, chooses it:
//
// - "cloudflare" (or unset), built in: the zone that holds PUBLIC_ORIGIN's
//   host, with the MEDIA_DNS_TOKEN secret (cloudflare-dns.js). Without the
//   secret there are no names.
// - Any other id: the provider a plugin's control entry registered
//   (plugins.js), with the Worker secret that registration names and the
//   zone in the var MEDIA_DNS_ZONE. A chosen provider whose plugin or secret
//   is missing is an error the owner sees, never a fall back to another
//   provider, which would hand one provider's token to another.
//
// A provider, as `create()` returns it and edge/names.js, lan.js, and
// wan.js call it:
//
//   zone(pageHost)                     → { id, name, ...its own fields }: the
//                                        zone the names go under, kept in
//                                        the media state, or an error
//   setAddress(zone, name, type, address, { comment })
//                                      creates or moves the A or AAAA record
//   clearAddress(zone, name, type)     deletes it; succeeds when there is none
//   setTxt(zone, name, value)          → handle: adds a TXT value beside
//                                        any other at the name (DNS-01)
//   clearTxt(zone, name, value, handle)  removes that value alone
//   settleMs                           optional: how long to wait after public
//                                        DNS answers a new TXT value before
//                                        the CA checks it, for a provider
//                                        whose nameservers catch up later
//
// Records are DNS-only with a short TTL; the provider writes nothing else.

export const BUILT_IN_PROVIDER = "cloudflare";
const METHODS = Object.freeze(["zone", "setAddress", "clearAddress", "setTxt", "clearTxt"]);

/** The instance's DNS provider id. */
export const mediaDnsProvider = (env) => String(env.MEDIA_DNS_PROVIDER || BUILT_IN_PROVIDER);

/**
 * Whether the instance names its media listeners at all: the built-in
 * provider once MEDIA_DNS_TOKEN is set, any other provider once chosen (its
 * plugin and secret are checked when it runs, and their absence is shown).
 */
export const mediaDnsConfigured = (env) => (mediaDnsProvider(env) === BUILT_IN_PROVIDER ? Boolean(dnsToken(env)) : true);

/**
 * The provider for this run, with `id` and `key` (the provider and its zone,
 * which the media state keeps to notice a move), or null when the instance
 * names nothing. Throws when the chosen provider cannot be used.
 * @param {object} env  the Worker's env
 * @param {{ providers?: Array<{ id: string, secret: string, create: Function }>, fetchImpl?: Function, sleep?: Function }} [options]
 *   `providers` are the plugins' registrations (plugins.js)
 */
export async function openMediaDns(env, { providers = [], fetchImpl = (...args) => fetch(...args), sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  const id = mediaDnsProvider(env);
  if (id === BUILT_IN_PROVIDER) {
    const token = dnsToken(env);
    return token ? { ...cloudflareDns({ token, fetchImpl }), id, key: id, settleMs: 0 } : null;
  }
  const definition = providers.find((entry) => entry.id === id);
  if (!definition) {
    throw new YoloError("invalid_request", `No plugin provides the DNS provider "${id}" that media.dns.provider names: list its plugin in yolo.config.json, then deploy again`);
  }
  const token = env[definition.secret];
  if (!token) throw new YoloError("forbidden", `The Worker has no ${definition.secret} secret for the DNS provider "${id}": npm run yolo -- provision media-dns`);
  const zone = env.MEDIA_DNS_ZONE ? String(env.MEDIA_DNS_ZONE).trim().toLowerCase().replace(/\.$/, "") : null;
  const provider = await definition.create({ token, zone, fetch: fetchImpl, sleep });
  const missing = METHODS.filter((method) => typeof provider?.[method] !== "function");
  if (missing.length) throw new YoloError("internal", `The DNS provider "${id}" has no ${missing.join(", ")}`);
  const settleMs = Number(provider.settleMs);
  return {
    id,
    key: `${id}:${zone ?? ""}`,
    settleMs: Number.isFinite(settleMs) && settleMs > 0 ? settleMs : 0,
    zone: (pageHost) => provider.zone(pageHost),
    setAddress: (...args) => provider.setAddress(...args),
    clearAddress: (...args) => provider.clearAddress(...args),
    setTxt: (...args) => provider.setTxt(...args),
    clearTxt: (...args) => provider.clearTxt(...args),
  };
}

// Whether public DNS answers `name` with the TXT `value` yet. Cloudflare's
// authoritative servers usually have a new record within seconds; asking a
// public resolver avoids an ACME validation that fails early. A provider's
// `settleMs` comes on top, for the authoritative servers that resolver did
// not ask.
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
