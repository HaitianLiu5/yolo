import { toYoloError, YoloError } from "@useyolo/core";
import { createNodeClient } from "../node-client.js";
import { mediaDnsConfigured, mediaDnsProvider, openMediaDns, waitForTxt as publicTxt } from "./dns.js";
import { acmeDirectory, backOff, issueIfDue, nameInZone, renewAt } from "./names.js";

// LAN direct play's control plane side (Agent Note 2026-10-12-lan-direct-play).
// With a DNS provider (dns.js: the MEDIA_DNS_TOKEN Worker secret for the
// built-in Cloudflare zone, or a plugin's provider,
// Agent Note 2026-10-14-dns-provider-plugins), maintainLan() runs every few
// minutes (the Worker's cron trigger) and when the owner asks in settings:
//
// 1. The node's name: one label in the provider's zone, outside the passkey
//    relying party (PUBLIC_ORIGIN's host), chosen once (names.js).
// 2. The node, through nodeFetch(): its name and the page origin it allows;
//    it answers its private address, its certificate's validity, and a
//    certificate request for its own key.
// 3. A DNS-only A record from the name to that address, moved when the
//    address changes.
// 4. A Let's Encrypt certificate by ACME DNS-01 when the node has none for
//    the name, or two thirds of its lifetime have passed; the chain goes to
//    the node. Failures back off up to a day.
//
// Everything lives in one KV value, LAN_STATE_KEY, including the ACME
// account key. Nothing is written when nothing changed, except once an hour.

export const LAN_STATE_KEY = "yolo:lan";
const QUIET_WRITE_MS = 60 * 60_000;

const consoleLog = (record) => console.log(record);

export async function readState(kv, key) {
  const text = await kv?.get(key);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const readLanState = (kv) => readState(kv, LAN_STATE_KEY);

// Writes `state` when something worth keeping changed, or once an hour, so
// a 5-minute cron stays far inside Workers Free's 1,000 KV writes a day. The
// times of the last check, the last outside reach, and the last failure of
// an unchanged error are not changes; the hourly write keeps them fresh.
const essence = ({ checkedAt: _checked, step: _step, reachedAt: _reached, error, ...rest } = {}) => JSON.stringify({
  ...rest,
  error: error ? { step: error.step, message: error.message } : error,
});
export async function saveState(kv, key, state, previous, now) {
  state.checkedAt = now;
  delete state.step;
  if (essence(state) !== essence(previous) || !(previous.checkedAt > now - QUIET_WRITE_MS)) await kv.put(key, JSON.stringify(state));
}

/** What a device's welcome says about the LAN origin, or null. */
export function lanWelcome(state, now = Date.now()) {
  if (!state?.ready || !state.origin || !(state.notAfter > now)) return null;
  return { origin: state.origin, notAfter: state.notAfter };
}

/** The owner's view in settings: never the account key. */
export function presentLan(state, env, now = Date.now()) {
  const configured = mediaDnsConfigured(env);
  const welcome = lanWelcome(state, now);
  return {
    configured,
    status: !configured ? "off" : state?.error ? "error" : welcome ? "ready" : "pending",
    zone: state?.zone?.name ?? null,
    name: state?.name ?? null,
    origin: state?.origin ?? null,
    address: state?.address ?? null,
    notAfter: state?.notAfter ?? null,
    renewAt: state?.notAfter ? renewAt(state) : null,
    checkedAt: state?.checkedAt ?? null,
    error: state?.error ?? null,
    retryAt: state?.retryAt ?? null,
  };
}

/**
 * @param {object} env  the Worker's env (MEDIA_DNS_TOKEN, or MEDIA_DNS_PROVIDER, MEDIA_DNS_ZONE, and the
 *   provider's secret; PUBLIC_ORIGIN, LAN_ACME_DIRECTORY, OAUTH_KV, node bindings)
 * @param {object} [options]  `providers`, the plugins' DNS providers (plugins.js); the rest are test seams
 */
export async function maintainLan(env, {
  providers = [],
  node = createNodeClient(env),
  fetchImpl = (...args) => fetch(...args),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  waitForTxt = (name, value) => publicTxt(name, value, { fetchImpl, sleep }),
  now = () => Date.now(),
  log = consoleLog,
} = {}) {
  if (!mediaDnsConfigured(env)) return presentLan(null, env, now());
  const kv = env.OAUTH_KV;
  const previous = (await readLanState(kv)) ?? {};
  const state = { ...previous };
  const directory = acmeDirectory(env);
  const pageOrigin = new URL(env.PUBLIC_ORIGIN).origin;
  let issued = false;
  try {
    state.step = "zone";
    const dns = await openMediaDns(env, { providers, fetchImpl, sleep });
    await nameInZone(state, { dns, pageHost: new URL(pageOrigin).hostname, prefix: "yolo-lan-" });

    state.step = "node";
    let lan = await node.request("/internal/v1/lan", { method: "PUT", body: { name: state.name, allowOrigin: pageOrigin }, timeoutMs: 10_000 });
    if (!lan.address) throw new YoloError("resolve_failed", "The node has no private IPv4 address on the home network");

    state.step = "dns";
    if (state.record?.name !== state.name || state.record?.address !== lan.address) {
      const record = await dns.setAddress(state.zone, state.name, "A", lan.address, { comment: "Yolo LAN direct play (managed by Yolo)" });
      if (state.record?.address && state.record.address !== lan.address) {
        log({ kind: "lan", event: "address_changed", name: state.name, from: state.record.address, to: lan.address });
      }
      state.record = { id: record?.id ?? null, name: state.name, address: lan.address };
    }

    const installed = await issueIfDue(state, {
      listener: lan, dns, directory, fetchImpl, sleep, waitForTxt, now,
      install: (chain) => node.request("/internal/v1/lan/certificate", { method: "PUT", body: { name: state.name, chain }, timeoutMs: 10_000 }),
    });
    if (installed) {
      lan = installed;
      issued = true;
    }

    Object.assign(state, {
      address: lan.address,
      origin: lan.origin,
      notBefore: lan.notBefore,
      notAfter: lan.notAfter,
      ready: Boolean(lan.listening && lan.notAfter > now()),
      error: lan.error ? { step: "listener", message: String(lan.error).slice(0, 300), at: now() } : null,
    });
  } catch (error) {
    const yolo = toYoloError(error);
    state.error = { step: state.step, message: yolo.message.slice(0, 300), at: now() };
    if (state.step === "certificate" || state.step === "install") backOff(state, now());
    // A failed step keeps what the node last said: its certificate serves
    // until it expires.
    state.ready = Boolean(state.ready && state.notAfter > now());
    log({ kind: "lan", event: "error", provider: mediaDnsProvider(env), step: state.error.step, message: state.error.message, failures: state.failures ?? 0, retryAt: state.retryAt ?? null });
  }
  if (issued) log({ kind: "lan", event: "certificate", provider: mediaDnsProvider(env), name: state.name, notAfter: state.notAfter, directory });
  await saveState(kv, LAN_STATE_KEY, state, previous, now());
  return presentLan(state, env, now());
}
