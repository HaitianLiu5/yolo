import { toYoloError, YoloError } from "@useyolo/core";
import { createNodeClient } from "../node-client.js";
import { remoteWanted } from "../store/media-settings.js";
import { BUILT_IN_PROVIDER, mediaDnsConfigured, mediaDnsProvider, openMediaDns, waitForTxt as publicTxt } from "./dns.js";
import { createEdgeRun } from "./lease.js";
import { readState, saveBeforeOrder, saveState } from "./lan.js";
import { acmeDirectory, backOff, issueIfDue, namedLater, nameInZone, renewAt } from "./names.js";

// Remote direct play's control plane side
// (Agent Note 2026-10-13-media-off-the-worker). With a DNS provider (dns.js,
// Agent Note 2026-10-14-dns-provider-plugins) and the owner's remote access
// on, maintainWan() runs on the cron trigger after maintainLan(), and when
// the owner asks in settings:
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
//
// Without a domain (WAN_CERTIFICATE "ip",
// Agent Note 2026-10-13-no-domain-deployment) there is no zone, name,
// record, or DNS-01: step 2 tells the node to certify the home's public
// address itself, and the node answers its origin, `https://<address>:<port>`,
// and its certificate. A Worker cannot fetch an IP address, so the CA's own
// check from outside, which the node's certificate proves, replaces step 5.
//
// When the remote origin a welcome lists changes, `onPathsChanged()` lets the
// connected screens know (index.js: the Hubs' `media` broadcast).

export const WAN_STATE_KEY = "yolo:wan";
const PROBE_TIMEOUT_MS = 5_000;
export const WAN_STATES = Object.freeze(["off", "pending", "ok", "cgnat", "unreachable", "certificate", "error"]);

const consoleLog = (record) => console.log(record);

export const readWanState = (kv) => readState(kv, WAN_STATE_KEY);

/** How the remote listener is certified: "name" (a name in the owner's zone) or "ip" (no domain). */
export const wanCertificate = (env) => (env.WAN_CERTIFICATE === "ip" ? "ip" : "name");

/** What a device's welcome says about the remote origin, or null. */
export function wanWelcome(state, now = Date.now()) {
  if (state?.status !== "ok" || !state.origin || !(state.notAfter > now)) return null;
  return { origin: state.origin, notAfter: state.notAfter };
}

/** The owner's view in settings: never the account key. */
export function presentWan(state, env, { remote = false, now = Date.now() } = {}) {
  const certificate = wanCertificate(env);
  const byAddress = certificate === "ip";
  const configured = byAddress || mediaDnsConfigured(env);
  const status = !configured || !remote ? "off" : state?.notAfter && !(state.notAfter > now) && state.status === "ok" ? "certificate" : state?.status ?? "pending";
  return {
    configured,
    certificate,
    on: remote,
    status,
    reason: state?.reason ?? null,
    zone: byAddress ? null : state?.zone?.name ?? null,
    name: byAddress ? null : state?.name ?? null,
    origin: state?.origin ?? null,
    address: state?.address ?? null,
    ipv6: state?.ipv6 ?? null,
    mapping: state?.mapping ?? null,
    notAfter: state?.notAfter ?? null,
    renewAt: state?.notAfter ? renewAt(state) : null,
    reachedAt: state?.reachedAt ?? null,
    checkedAt: state?.checkedAt ?? null,
    error: state?.error ?? null,
    retryAt: (byAddress ? state?.nodeRetryAt : state?.retryAt) ?? null,
    // Without a domain: how the CA reaches the node, and when it last did.
    challenge: byAddress ? state?.challenge ?? null : null,
    validatedAt: byAddress ? state?.validatedAt ?? null : null,
    ipv6Error: byAddress ? state?.ipv6Error ?? null : null,
  };
}

// The router mapping as the node reported it, with the router's address and
// the port the node asks for, which the refusal's router step names
// (edge/paths.js); and the node's own address and port behind it.
const mappingOf = (mapping) => (mapping ? {
  mode: mapping.mode, method: mapping.method, externalPort: mapping.externalPort, error: mapping.error, gateway: mapping.gateway ?? null, requestedPort: mapping.requestedPort ?? null,
} : null);
const listenerOf = (wan) => (wan?.port ? { address: wan.address ?? null, port: wan.port } : null);

// Without a domain: the node certifies the home's address and reports
// whether it serves under it.
async function maintainByAddress(env, state, previous, { node, now, event, remote, pageOrigin }) {
  const body = (enabled) => ({ certificate: "ip", allowOrigin: pageOrigin, enabled, acmeDirectory: acmeDirectory(env) });
  if (!remote) {
    if (previous.status && previous.status !== "off") {
      state.step = "node";
      await node.request("/internal/v1/wan", { method: "PUT", body: body(false), timeoutMs: 30_000 });
      event("off");
    }
    Object.assign(state, { status: "off", reason: null, origin: null, error: null, mapping: null });
    return;
  }
  state.step = "node";
  const wan = await node.request("/internal/v1/wan", { method: "PUT", body: body(true), timeoutMs: 30_000 });
  Object.assign(state, {
    certificate: "ip", mapping: mappingOf(wan.mapping), listener: listenerOf(wan), challenge: wan.challenge ?? null, ipv6Error: wan.order?.ipv6Error ?? null, nodeRetryAt: wan.order?.retryAt ?? null,
  });
  if (wan.nat === "cgnat") {
    if (previous.status !== "cgnat") event("cgnat", { reason: wan.natReason });
    Object.assign(state, { status: "cgnat", reason: wan.natReason, origin: null, error: null });
    return;
  }
  const address = wan.publicAddress ?? wan.mapping?.externalAddress ?? null;
  if (address && previous.address && address !== previous.address) event("address_changed", { type: "A", from: previous.address, to: address });
  Object.assign(state, {
    address, ipv6: wan.identifiers?.[1] ?? null, origin: wan.origin ?? null, notBefore: wan.notBefore ?? null, notAfter: wan.notAfter ?? null,
    validatedAt: wan.order?.validatedAt ?? state.validatedAt ?? null, error: null, reason: null,
  });
  if (wan.listening && wan.origin && wan.notAfter > now()) {
    // The CA reached the node from outside when it validated the address.
    Object.assign(state, { status: "ok", reachedAt: state.validatedAt });
    return;
  }
  state.status = "pending";
  if (wan.order?.running) {
    state.reason = `Requesting a certificate for ${address ?? "the home's address"}`;
    return;
  }
  state.step = !address ? "address" : "certificate";
  const failure = wan.order?.error || wan.error || (!address ? `The node does not know the home's public address yet${wan.publicAddressError ? ` (${wan.publicAddressError})` : ""}` : null);
  if (failure) throw new YoloError("resolve_failed", failure);
}

// The records go only through the provider that wrote them; after a move to
// another provider they stay with the previous one, and are forgotten here.
async function removeRecords(dns, state) {
  if (state.zone && state.name && (state.dns ?? BUILT_IN_PROVIDER) === dns.key) {
    for (const type of ["A", "AAAA"]) await dns.clearAddress(state.zone, state.name, type);
  }
  state.records = {};
}

/**
 * @param {object} env  the Worker's env (MEDIA_DNS_TOKEN, or MEDIA_DNS_PROVIDER, MEDIA_DNS_ZONE, and the
 *   provider's secret; PUBLIC_ORIGIN, LAN_ACME_DIRECTORY, WAN_CERTIFICATE, OAUTH_KV, DB, node bindings)
 * @param {object} [options]  `providers`, the plugins' DNS providers (plugins.js); `run`, the cron
 *   run this is part of (lease.js), else it is a run of its own; either way it chooses no name and
 *   orders nothing while another run's order holds the lease, and the remote-access switch takes
 *   effect regardless. `interactive` when a person waits on it (the owner's check), which leaves a
 *   slow provider's naming and order to the cron run; the rest are test seams
 */
export async function maintainWan(env, options = {}) {
  const { run = null, interactive = false, now = () => Date.now() } = options;
  // Alone, as the owner's check, this is a run of its own (lease.js).
  const own = run ? null : createEdgeRun(env.OAUTH_KV, { now, interactive });
  try {
    return await maintainWanRun(env, { ...options, run: run ?? own });
  } finally {
    await own?.done();
  }
}

async function maintainWanRun(env, {
  providers = [],
  run,
  node = createNodeClient(env),
  fetchImpl = (...args) => fetch(...args),
  probe = (url) => fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store" }),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  waitForTxt = (name, value, options) => publicTxt(name, value, { fetchImpl, sleep, now, ...options }),
  now = () => Date.now(),
  log = consoleLog,
  onPathsChanged = async () => {},
} = {}) {
  const byAddress = wanCertificate(env) === "ip";
  const named = !byAddress && mediaDnsConfigured(env);
  const remote = named || byAddress ? await remoteWanted(env.DB) : false;
  const kv = env.OAUTH_KV;
  const previous = (await readWanState(kv)) ?? {};
  if (!named && !byAddress) return presentWan(previous, env, { remote, now: now() });
  const state = { ...previous, records: { ...previous.records } };
  const openDns = () => openMediaDns(env, { providers, fetchImpl, sleep });
  const pageOrigin = new URL(env.PUBLIC_ORIGIN).origin;
  const event = (name, fields = {}) => log({ kind: "edge", path: "wan", event: name, name: byAddress ? null : state.name, ...(byAddress ? {} : { provider: mediaDnsProvider(env) }), ...fields });
  let issued = false;
  try {
    if (byAddress) {
      await maintainByAddress(env, state, previous, { node, now, event, remote, pageOrigin });
    } else if (!remote) {
      const turnedOff = Boolean(previous.status && previous.status !== "off");
      if (turnedOff) {
        // The listener closes first: a DNS failure must never keep it open.
        state.step = "node";
        if (state.name) await node.request("/internal/v1/wan", { method: "PUT", body: { name: state.name, allowOrigin: pageOrigin, enabled: false }, timeoutMs: 30_000 });
        event("off");
      }
      // Then the records, at best effort. While some remain, a later run tries
      // again after the certificate backoff (30 minutes, doubling up to a
      // day), kept in fields of its own.
      const left = Object.values(state.records).some(Boolean);
      if (turnedOff || (left && !(state.recordsRetryAt > now()))) {
        state.step = "dns";
        try {
          await removeRecords(await openDns(), state);
          delete state.recordFailures;
          delete state.recordsRetryAt;
        } catch (failure) {
          backOff(state, now(), { counter: "recordFailures", until: "recordsRetryAt" });
          event("records_left", { message: toYoloError(failure).message.slice(0, 300), records: state.records, retryAt: state.recordsRetryAt });
        }
      }
      Object.assign(state, { status: "off", reason: null, origin: null, error: null, mapping: null });
    } else {
      state.step = "zone";
      const dns = await openDns();
      // No name yet, and this run may not choose one: it changes and saves nothing.
      if (!(await nameInZone(state, { dns, pageHost: new URL(pageOrigin).hostname, prefix: "yolo-wan-", run }))) {
        return presentWan({ ...previous, status: "pending", reason: namedLater({ run, dns }), error: null }, env, { remote, now: now() });
      }
      delete state.recordFailures;
      delete state.recordsRetryAt;

      state.step = "node";
      let wan = await node.request("/internal/v1/wan", { method: "PUT", body: { name: state.name, allowOrigin: pageOrigin, enabled: true }, timeoutMs: 30_000 });
      if (wan.nat === "cgnat") {
        state.step = "dns";
        await removeRecords(dns, state);
        if (previous.status !== "cgnat") event("cgnat", { reason: wan.natReason });
        Object.assign(state, { status: "cgnat", reason: wan.natReason, origin: null, error: null, mapping: mappingOf(wan.mapping), listener: listenerOf(wan) });
      } else {
        state.step = "address";
        const address = wan.publicAddress ?? wan.mapping?.externalAddress ?? null;
        if (!address) throw new YoloError("resolve_failed", `The node does not know the home's public address yet${wan.publicAddressError ? ` (${wan.publicAddressError})` : ""}`);
        const ipv6 = wan.ipv6 && (wan.addresses || []).includes(wan.ipv6) ? wan.ipv6 : null;

        state.step = "dns";
        for (const [type, value] of [["A", address], ["AAAA", ipv6]]) {
          if (state.records[type] === value) continue;
          if (value) await dns.setAddress(state.zone, state.name, type, value, { comment: "Yolo remote direct play (managed by Yolo)" });
          else await dns.clearAddress(state.zone, state.name, type);
          if (state.records[type] && value) event("address_changed", { type, from: state.records[type], to: value });
          state.records[type] = value;
        }

        const installed = await issueIfDue(state, {
          listener: wan, dns, directory: acmeDirectory(env), fetchImpl, sleep, waitForTxt, now, run,
          persist: () => saveBeforeOrder(kv, WAN_STATE_KEY, state, previous),
          install: (chain) => node.request("/internal/v1/wan/certificate", { method: "PUT", body: { name: state.name, chain }, timeoutMs: 30_000 }),
        });
        if (installed) {
          wan = installed;
          issued = true;
        }
        Object.assign(state, {
          address, ipv6, origin: wan.origin, notBefore: wan.notBefore, notAfter: wan.notAfter, error: null, reason: null,
          mapping: mappingOf(wan.mapping), listener: listenerOf(wan),
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
    state.error = { step: state.step, message: yolo.message.slice(0, 600), at: now() };
    state.status = "error";
    // Without a domain the node backs off its own orders.
    if (!byAddress && (state.step === "certificate" || state.step === "install")) backOff(state, now());
    event("error", { step: state.error.step, message: state.error.message, failures: state.failures ?? 0, retryAt: (byAddress ? state.nodeRetryAt : state.retryAt) ?? null });
  }
  if (issued) event("certificate", { notAfter: state.notAfter, directory: acmeDirectory(env) });
  await saveState(kv, WAN_STATE_KEY, state, previous, now());
  if (wanWelcome(previous, now())?.origin !== wanWelcome(state, now())?.origin) await onPathsChanged();
  return presentWan(state, env, { remote, now: now() });
}
