import { toYoloError, YoloError } from "@useyolo/core";
import { createNodeClient } from "../node-client.js";
import { createAccountKey, createAcmeClient, csrFromPem, LETS_ENCRYPT_STAGING_DIRECTORY } from "./acme.js";
import { createDnsClient, waitForTxt as publicTxt } from "./dns.js";

// LAN direct play's control plane side (Agent Note 2026-10-12-lan-direct-play).
// With the LAN_DNS_TOKEN Worker secret set, maintainLan() runs every few
// minutes (the Worker's cron trigger) and when the owner asks in settings:
//
// 1. The node's name: one label in the owner's zone, outside the passkey
//    relying party (PUBLIC_ORIGIN's host), chosen once.
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
const LABEL_PREFIX = "yolo-lan-";
const QUIET_WRITE_MS = 60 * 60_000;
const RETRY_BASE_MS = 30 * 60_000;
const RETRY_MAX_MS = 24 * 60 * 60_000;

const consoleLog = (record) => console.log(record);

export async function readLanState(kv) {
  const text = await kv?.get(LAN_STATE_KEY);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** When the certificate is due: two thirds into its lifetime. */
export function renewAt({ notBefore, notAfter }) {
  if (!notAfter) return null;
  const start = Number(notBefore) || Number(notAfter) - 90 * 24 * 60 * 60_000;
  return Math.round(start + (Number(notAfter) - start) * 2 / 3);
}

/** What a device's welcome says about the LAN origin, or null. */
export function lanWelcome(state, now = Date.now()) {
  if (!state?.ready || !state.origin || !(state.notAfter > now)) return null;
  return { origin: state.origin, notAfter: state.notAfter };
}

/** The owner's view in settings: never the account key. */
export function presentLan(state, env, now = Date.now()) {
  const configured = Boolean(env.LAN_DNS_TOKEN);
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

const randomLabel = () => `${LABEL_PREFIX}${[...crypto.getRandomValues(new Uint8Array(4))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

// The fields whose change is worth a KV write.
const essence = ({ checkedAt: _checked, ...rest } = {}) => JSON.stringify(rest);

/**
 * @param {object} env  the Worker's env (LAN_DNS_TOKEN, PUBLIC_ORIGIN, LAN_ACME_DIRECTORY, OAUTH_KV, node bindings)
 * @param {object} [options]  test seams
 */
export async function maintainLan(env, {
  node = createNodeClient(env),
  fetchImpl = (...args) => fetch(...args),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  waitForTxt = (name, value) => publicTxt(name, value, { fetchImpl, sleep }),
  now = () => Date.now(),
  log = consoleLog,
} = {}) {
  if (!env.LAN_DNS_TOKEN) return presentLan(null, env, now());
  const kv = env.OAUTH_KV;
  const previous = (await readLanState(kv)) ?? {};
  const state = { ...previous };
  const dns = createDnsClient({ token: env.LAN_DNS_TOKEN, fetchImpl });
  const directory = env.LAN_ACME_DIRECTORY || LETS_ENCRYPT_STAGING_DIRECTORY;
  const pageOrigin = new URL(env.PUBLIC_ORIGIN).origin;
  const pageHost = new URL(pageOrigin).hostname;
  let step = "zone";
  let issued = false;
  try {
    if (!state.zone) {
      state.zone = await dns.findZone(pageHost);
      if (!state.zone) throw new YoloError("forbidden", `LAN_DNS_TOKEN cannot read a zone that contains ${pageHost}; give it Zone Read and DNS Edit on that zone`);
    }
    if (!state.name || !state.name.endsWith(`.${state.zone.name}`)) state.name = `${randomLabel()}.${state.zone.name}`;
    // A name under the relying party's host could ask for the owner's passkeys.
    if (state.name === pageHost || state.name.endsWith(`.${pageHost}`)) {
      throw new YoloError("invalid_request", `The zone ${state.zone.name} has no name outside ${pageHost} for the node`);
    }

    step = "node";
    let lan = await node.request("/internal/v1/lan", { method: "PUT", body: { name: state.name, allowOrigin: pageOrigin }, timeoutMs: 10_000 });
    if (!lan.address) throw new YoloError("resolve_failed", "The node has no private IPv4 address on the home network");

    step = "dns";
    if (state.record?.name !== state.name || state.record?.address !== lan.address) {
      const record = await dns.upsertAddress(state.zone.id, state.name, lan.address);
      if (state.record?.address && state.record.address !== lan.address) {
        log({ kind: "lan", event: "address_changed", name: state.name, from: state.record.address, to: lan.address });
      }
      state.record = { id: record.id, name: state.name, address: lan.address };
    }

    step = "certificate";
    const due = !lan.notAfter || now() >= renewAt(lan);
    if (due && !(state.retryAt > now())) {
      if (!state.account || state.account.directory !== directory) state.account = { directory, key: await createAccountKey(), url: null };
      const acme = createAcmeClient({ directoryUrl: directory, accountKey: state.account.key, accountUrl: state.account.url, fetchImpl, sleep });
      const txtName = `_acme-challenge.${state.name}`;
      const chain = await acme.issue({
        name: state.name,
        csr: csrFromPem(lan.csr),
        presentTxt: (value) => dns.createTxt(state.zone.id, txtName, value),
        removeTxt: (id) => dns.deleteRecord(state.zone.id, id).catch(() => {}),
        waitForTxt: (value) => waitForTxt(txtName, value),
      });
      state.account.url = acme.accountUrl;
      step = "install";
      lan = await node.request("/internal/v1/lan/certificate", { method: "PUT", body: { name: state.name, chain }, timeoutMs: 10_000 });
      issued = true;
      state.failures = 0;
      state.retryAt = null;
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
    state.error = { step, message: yolo.message.slice(0, 300), at: now() };
    if (step === "certificate" || step === "install") {
      state.failures = (Number(state.failures) || 0) + 1;
      state.retryAt = now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (state.failures - 1));
    }
    // A failed step keeps what the node last said: its certificate serves
    // until it expires.
    state.ready = Boolean(state.ready && state.notAfter > now());
    log({ kind: "lan", event: "error", step, message: state.error.message, failures: state.failures ?? 0, retryAt: state.retryAt ?? null });
  }
  if (issued) log({ kind: "lan", event: "certificate", name: state.name, notAfter: state.notAfter, directory });
  state.checkedAt = now();
  if (essence(state) !== essence(previous) || !(previous.checkedAt > now() - QUIET_WRITE_MS)) {
    await kv.put(LAN_STATE_KEY, JSON.stringify(state));
  }
  return presentLan(state, env, now());
}
