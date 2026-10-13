import { toYoloError, YoloError } from "@useyolo/core";
import { createNodeClient } from "../node-client.js";
import { remoteWanted } from "../store/media-settings.js";
import { createDnsClient, waitForTxt as publicTxt } from "./dns.js";
import { readState, saveState } from "./lan.js";
import { acmeDirectory, backOff, dnsToken, issueIfDue, nameInZone, renewAt } from "./names.js";

// Remote direct play's control plane side
// (Agent Note 2026-10-13-media-off-the-worker). With the MEDIA_DNS_TOKEN
// secret set and the owner's remote access on, maintainWan() runs on the
// cron trigger after maintainLan(), and when the owner asks in settings:
//
// 1. The node's remote name, `yolo-wan-<8 hex digits>.<zone>`, chosen once.
// 2. The node, through nodeFetch(): the name, the page origin, and the
//    switch; it answers the home's public address as the internet sees it,
//    its router mapping, its global IPv6 address when it listens there,
//    whether it is behind carrier-grade or double NAT, and a certificate
//    request.
// 3. DNS-only records from the name to the public IPv4 address (A) and the
//    node's IPv6 address (AAAA), moved when an address changes. Behind
//    carrier-grade NAT the records are removed: nothing could reach them.
// 4. A certificate for exactly that name, as for the LAN name.
// 5. The outside check: the Worker fetches https://<name>:<port>/edge/probe.
//    A Worker's fetch() goes to the port in the URL of a DNS-only host, so a
//    probe that answers proves the router forwards from the internet.
//
// Remote access off: the records go, and the node closes the listener and
// deletes its router mapping. The state is one KV value, WAN_STATE_KEY.

export const WAN_STATE_KEY = "yolo:wan";
const PROBE_TIMEOUT_MS = 5_000;
export const WAN_STATES = Object.freeze(["off", "pending", "ok", "cgnat", "unreachable", "certificate", "error"]);

const consoleLog = (record) => console.log(record);

export const readWanState = (kv) => readState(kv, WAN_STATE_KEY);

/** What a device's welcome says about the remote origin, or null. */
export function wanWelcome(state, now = Date.now()) {
  if (state?.status !== "ok" || !state.origin || !(state.notAfter > now)) return null;
  return { origin: state.origin, notAfter: state.notAfter };
}

/** The owner's view in settings: never the account key. */
export function presentWan(state, env, { remote = false, now = Date.now() } = {}) {
  const configured = Boolean(dnsToken(env));
  const status = !configured || !remote ? "off" : state?.notAfter && !(state.notAfter > now) && state.status === "ok" ? "certificate" : state?.status ?? "pending";
  return {
    configured,
    on: remote,
    status,
    reason: state?.reason ?? null,
    zone: state?.zone?.name ?? null,
    name: state?.name ?? null,
    origin: state?.origin ?? null,
    address: state?.address ?? null,
    ipv6: state?.ipv6 ?? null,
    mapping: state?.mapping ?? null,
    notAfter: state?.notAfter ?? null,
    renewAt: state?.notAfter ? renewAt(state) : null,
    reachedAt: state?.reachedAt ?? null,
    checkedAt: state?.checkedAt ?? null,
    error: state?.error ?? null,
    retryAt: state?.retryAt ?? null,
  };
}

async function removeRecords(dns, state) {
  if (!state.zone || !state.name) return;
  for (const type of ["A", "AAAA"]) await dns.deleteAddress(state.zone.id, state.name, type);
  state.records = {};
}

/**
 * @param {object} env  the Worker's env (MEDIA_DNS_TOKEN, PUBLIC_ORIGIN, LAN_ACME_DIRECTORY, OAUTH_KV, DB, node bindings)
 * @param {object} [options]  test seams
 */
export async function maintainWan(env, {
  node = createNodeClient(env),
  fetchImpl = (...args) => fetch(...args),
  probe = (url) => fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store" }),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  waitForTxt = (name, value) => publicTxt(name, value, { fetchImpl, sleep }),
  now = () => Date.now(),
  log = consoleLog,
} = {}) {
  const token = dnsToken(env);
  const remote = token ? await remoteWanted(env.DB) : false;
  const kv = env.OAUTH_KV;
  const previous = (await readWanState(kv)) ?? {};
  if (!token) return presentWan(previous, env, { remote, now: now() });
  const state = { ...previous, records: { ...previous.records } };
  const dns = createDnsClient({ token, fetchImpl });
  const pageOrigin = new URL(env.PUBLIC_ORIGIN).origin;
  const event = (name, fields = {}) => log({ kind: "edge", path: "wan", event: name, name: state.name, ...fields });
  let issued = false;
  try {
    if (!remote) {
      if (previous.status && previous.status !== "off") {
        state.step = "dns";
        await removeRecords(dns, state);
        state.step = "node";
        if (state.name) await node.request("/internal/v1/wan", { method: "PUT", body: { name: state.name, allowOrigin: pageOrigin, enabled: false }, timeoutMs: 30_000 });
        event("off");
      }
      Object.assign(state, { status: "off", reason: null, origin: null, error: null, mapping: null });
    } else {
      state.step = "zone";
      await nameInZone(state, { dns, pageHost: new URL(pageOrigin).hostname, prefix: "yolo-wan-" });

      state.step = "node";
      let wan = await node.request("/internal/v1/wan", { method: "PUT", body: { name: state.name, allowOrigin: pageOrigin, enabled: true }, timeoutMs: 30_000 });
      if (wan.nat === "cgnat") {
        state.step = "dns";
        await removeRecords(dns, state);
        if (previous.status !== "cgnat") event("cgnat", { reason: wan.natReason });
        Object.assign(state, { status: "cgnat", reason: wan.natReason, origin: null, error: null, mapping: wan.mapping ?? null });
      } else {
        state.step = "address";
        const address = wan.publicAddress ?? wan.mapping?.externalAddress ?? null;
        if (!address) throw new YoloError("resolve_failed", `The node does not know the home's public address yet${wan.publicAddressError ? ` (${wan.publicAddressError})` : ""}`);
        const ipv6 = wan.ipv6 && (wan.addresses || []).includes(wan.ipv6) ? wan.ipv6 : null;

        state.step = "dns";
        for (const [type, value] of [["A", address], ["AAAA", ipv6]]) {
          if (state.records[type] === value) continue;
          if (value) await dns.upsertAddress(state.zone.id, state.name, value, { type, comment: "Yolo remote direct play (managed by Yolo)" });
          else await dns.deleteAddress(state.zone.id, state.name, type);
          if (state.records[type] && value) event("address_changed", { type, from: state.records[type], to: value });
          state.records[type] = value;
        }

        const installed = await issueIfDue(state, {
          listener: wan, dns, directory: acmeDirectory(env), fetchImpl, sleep, waitForTxt, now,
          install: (chain) => node.request("/internal/v1/wan/certificate", { method: "PUT", body: { name: state.name, chain }, timeoutMs: 30_000 }),
        });
        if (installed) {
          wan = installed;
          issued = true;
        }
        Object.assign(state, {
          address, ipv6, origin: wan.origin, notBefore: wan.notBefore, notAfter: wan.notAfter, error: null, reason: null,
          mapping: wan.mapping ? { mode: wan.mapping.mode, method: wan.mapping.method, externalPort: wan.mapping.externalPort, error: wan.mapping.error } : null,
        });

        state.step = "listener";
        if (!(wan.notAfter > now())) {
          state.status = "certificate";
        } else if (!wan.listening) {
          state.status = "pending";
          if (wan.error) throw new YoloError("resolve_failed", wan.error);
        } else if (!wan.origin) {
          state.step = "router";
          throw new YoloError("resolve_failed", wan.mapping?.error || "The router has no port mapping for the node yet");
        } else {
          state.step = "reach";
          let reached = false;
          let why = null;
          try {
            const response = await probe(`${wan.origin}/edge/probe`);
            const body = await response.json().catch(() => null);
            reached = response.ok && body?.path === "wan" && body?.name === state.name;
            if (!reached) why = `answered ${response.status}`;
          } catch (failure) {
            why = failure?.name === "TimeoutError" ? "no answer within 5 seconds" : failure.message;
          }
          if (reached) {
            state.status = "ok";
            state.reachedAt = now();
          } else {
            state.status = "unreachable";
            state.reason = `${wan.origin} ${why} from outside the home: the router does not forward the port, or the ISP or a firewall blocks it`;
            if (previous.status !== "unreachable") event("unreachable", { reason: state.reason });
          }
        }
      }
    }
  } catch (error) {
    const yolo = toYoloError(error);
    state.error = { step: state.step, message: yolo.message.slice(0, 300), at: now() };
    state.status = "error";
    if (state.step === "certificate" || state.step === "install") backOff(state, now());
    event("error", { step: state.error.step, message: state.error.message, failures: state.failures ?? 0, retryAt: state.retryAt ?? null });
  }
  if (issued) event("certificate", { notAfter: state.notAfter, directory: acmeDirectory(env) });
  await saveState(kv, WAN_STATE_KEY, state, previous, now());
  return presentWan(state, env, { remote, now: now() });
}
