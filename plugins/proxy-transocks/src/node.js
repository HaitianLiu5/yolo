import { createHash } from "node:crypto";
import { connect as netConnect } from "node:net";
import { YoloError } from "@useyolo/plugin-api";
import { createTransocksApi } from "./api.js";

// Official proxy provider plugin: Transocks' China lines for the media node's
// egress rules (Agent Note 2026-10-28-transocks-proxy-provider). The owner
// gives only the account, in .env:
//
//   TRANSOCKS_ACCOUNT=owner@example.com   (or a phone number, with TRANSOCKS_COUNTRY_CODE=1)
//   TRANSOCKS_PASSWORD=…
//
// and a proxy in yolo.config.json's egress.proxies names the provider:
//
//   "proxies": { "cn": { "provider": "transocks" } }
//
// The provider signs in, lists the account's lines, keeps the ones that exit
// in China (not relays abroad, and only `options.locations` when given),
// measures each one's connect time from the node, opens a session on the
// fastest, and checks that it tunnels before handing it out. It signs in
// again when the session ends, opens a new session on the line before its
// time is up, and moves to the next line when the node says the proxy failed
// and the line fails its check. No log line or error carries the password,
// the token, or a line's address or credentials.

export const PROVIDER_ID = "transocks";
export const LINE_TTL_MS = 11 * 60 * 60_000; // the extension ends a session after 12 hours
export const LINES_TTL_MS = 60 * 60_000;
export const DEAD_MS = 10 * 60_000;
export const PING_TTL_MS = 10 * 60_000;
export const CANDIDATES = 5;
const RELOGIN_BEFORE_MS = 5 * 60_000;
const PING_TIMEOUT_MS = 2_000;
const PING_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_TARGET = "www.baidu.com:443";

// The time to open a TCP connection to host:port, or Infinity.
export function tcpPing(host, port, { timeoutMs = PING_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = netConnect({ host, port });
    const done = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(Infinity), timeoutMs);
    socket.once("connect", () => done(performance.now() - started));
    socket.once("error", () => done(Infinity));
  });
}

// Whether an endpoint's proxy takes its credentials and opens a tunnel.
export function probeEndpoint(endpoint, { target = PROBE_TARGET, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const proxy = new URL(endpoint.url);
    const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) || 80 });
    let answer = "";
    const done = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("error", () => done(false));
    socket.once("connect", () => {
      const auth = Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64");
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      answer += chunk.toString("latin1");
      if (answer.includes("\r\n")) done(/^HTTP\/1\.[01] 200/.test(answer));
    });
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

export function accountFrom(env) {
  const account = String(env.TRANSOCKS_ACCOUNT ?? "").trim();
  const password = String(env.TRANSOCKS_PASSWORD ?? "");
  if (!account || !password) throw new YoloError("not_found", "TRANSOCKS_ACCOUNT and TRANSOCKS_PASSWORD are not set");
  const countryCode = String(env.TRANSOCKS_COUNTRY_CODE ?? "").replace(/[^\d]/g, "") || null;
  if (!account.includes("@") && !countryCode) throw new YoloError("invalid_request", "TRANSOCKS_ACCOUNT is a phone number, so TRANSOCKS_COUNTRY_CODE must be its calling code, such as 1 or 86");
  const deviceId = String(env.TRANSOCKS_DEVICE_ID ?? "").trim() || createHash("sha256").update(`yolo-media-node:${account}`).digest("hex");
  return { account, password, countryCode, deviceId };
}

// The lines a proxy's options allow: China exits, optionally only some locations.
export function eligible(lines, options = {}) {
  const locations = Array.isArray(options.locations) ? options.locations.map((place) => String(place).toLowerCase()) : [];
  return lines.filter((line) => !line.relay && line.host && (!locations.length || locations.some((place) => `${line.location} ${line.name}`.toLowerCase().includes(place))));
}

export function createTransocksProvider({ env, log, fetchImpl = globalThis.fetch, now = () => Date.now(), ping = tcpPing, probe = probeEndpoint, createApi = createTransocksApi }) {
  let api = null;
  let session = null; // { token, expiresAt }
  let lineList = null; // { lines, at }
  const pings = new Map(); // line id → { ms, at }
  const dead = new Map(); // line id → until
  const picks = new Map(); // options key → { line, endpoint, expiresAt }

  function client() {
    api ??= createApi({ ...accountFrom(env), fetchImpl, now });
    return api;
  }

  async function signIn() {
    session = await client().login();
    log.info("Signed in to Transocks");
    return session;
  }

  // fn(token), signing in first when there is no session or it is about to
  // end, and once more when the API says the session is gone.
  async function withSession(fn) {
    if (!session || (session.expiresAt != null && session.expiresAt - RELOGIN_BEFORE_MS <= now())) await signIn();
    try {
      return await fn(session.token);
    } catch (error) {
      if (error.apiCode !== 20001 && error.apiCode !== 20010) throw error;
      await signIn();
      return fn(session.token);
    }
  }

  async function lines() {
    if (lineList && now() - lineList.at < LINES_TTL_MS) return lineList.lines;
    const fetched = await withSession((token) => client().lines(token));
    lineList = { lines: fetched, at: now() };
    return fetched;
  }

  // The eligible lines that answer, fastest first.
  async function ranked(options) {
    const candidates = eligible(await lines(), options).filter((line) => !(dead.get(line.id) > now()));
    await mapLimit(candidates.filter((line) => !(now() - (pings.get(line.id)?.at ?? -Infinity) < PING_TTL_MS)), PING_CONCURRENCY, async (line) => {
      const ms = Math.min(await ping(line.host, line.detectPort), await ping(line.host, line.detectPort));
      pings.set(line.id, { ms, at: now() });
    });
    return candidates.filter((line) => Number.isFinite(pings.get(line.id)?.ms)).sort((a, b) => pings.get(a.id).ms - pings.get(b.id).ms);
  }

  // A checked session on `line`, or null.
  async function open(line) {
    let endpoint;
    try {
      endpoint = await withSession((token) => client().connect(token, line.id));
    } catch (error) {
      if (error.apiCode === 20001 || error.apiCode === 20010 || error.code === "unauthorized" || error.code === "forbidden") throw error;
      log.warn({ line: line.name, err: error.message }, "Transocks line would not open");
      return null;
    }
    if (await probe(endpoint)) return endpoint;
    log.warn({ line: line.name }, "Transocks line opened but does not tunnel");
    await withSession((token) => client().disconnect(token, line.id)).catch(() => {});
    return null;
  }

  async function choose(key, options) {
    const order = await ranked(options);
    if (!order.length) throw new YoloError("resolve_failed", "No Transocks China line answers from this node now");
    for (const line of order.slice(0, CANDIDATES)) {
      const endpoint = await open(line);
      if (!endpoint) {
        dead.set(line.id, now() + DEAD_MS);
        continue;
      }
      const pick = { line, endpoint, expiresAt: now() + LINE_TTL_MS };
      picks.set(key, pick);
      log.info({ line: line.name, location: line.location, connectMs: Math.round(pings.get(line.id).ms) }, "Transocks line chosen");
      return pick;
    }
    throw new YoloError("resolve_failed", `None of the ${Math.min(order.length, CANDIDATES)} fastest Transocks lines works now`);
  }

  async function endpoint(options = {}, { refused = false, failed = false } = {}) {
    const key = JSON.stringify(options ?? {});
    const pick = picks.get(key);
    const result = (chosen) => ({ url: chosen.endpoint.url, username: chosen.endpoint.username, password: chosen.endpoint.password, expiresAt: chosen.expiresAt });
    if (pick && !refused && !failed && pick.expiresAt > now()) return result(pick);
    if (pick) {
      // The node says the proxy failed: a line that still tunnels was not the
      // problem (the site was), so it stays.
      if (failed && !refused && await probe(pick.endpoint)) return result(pick);
      // Expired or refused: a new session on the same line first.
      if (!failed && !(dead.get(pick.line.id) > now())) {
        const renewed = await open(pick.line);
        if (renewed) {
          const next = { line: pick.line, endpoint: renewed, expiresAt: now() + LINE_TTL_MS };
          picks.set(key, next);
          return result(next);
        }
      }
      log.warn({ line: pick.line.name }, "Transocks line failed; choosing another");
      dead.set(pick.line.id, now() + DEAD_MS);
      picks.delete(key);
      await withSession((token) => client().disconnect(token, pick.line.id)).catch(() => {});
    }
    return result(await choose(key, options));
  }

  return {
    endpoint,
    async shutdown() {
      const open = [...picks.values()];
      picks.clear();
      if (!session) return;
      await Promise.allSettled(open.map((pick) => client().disconnect(session.token, pick.line.id)));
    },
  };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function proxyTransocksPlugin(yolo) {
  const provider = createTransocksProvider({ env: yolo.env, log: yolo.log });
  yolo.registerProxyProvider(PROVIDER_ID, { endpoint: (options, context) => provider.endpoint(options, context) });
  yolo.on("shutdown", () => provider.shutdown());
}
