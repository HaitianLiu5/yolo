import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import { YoloError } from "@useyolo/plugin-api";

// Transocks' account API, as its browser extension (3.4.4) speaks it (Agent
// Note 2026-10-28-transocks-proxy-provider). Every request and most answers
// are sealed: AES-256-CBC with a key and IV derived from the extension's
// public client key and the request's time, and an HMAC-SHA1 signature. The
// API is private and may change; this module is the only place that knows
// its shape.
//
// No error or return value of this module carries the account's password or
// token; the line credentials it returns are the provider's to hand to the node.

export const API_ORIGINS = Object.freeze(["https://webapi.fobwifi.com", "https://b.kolavpn.xyz"]);
const CLIENT_ID = "ikobbjiomdcedikdmkfhlhoagpailcbh";
const CLIENT_KEY = `${CLIENT_ID}tZn7uJwcHjAJr4fQ3`;
const CLIENT_VERSION = 1811;
const APP_VERSION = "3.4.4";
const ORG = "transocks_pro";
const DEVICE = "chrome";
const REQUEST_TIMEOUT_MS = 15_000;

// The API's codes that mean the session is gone: signed out, or signed in elsewhere.
export const SESSION_GONE = new Set([20001, 20010]);
const MESSAGES = {
  40001: "the account or password is wrong",
  40050: "the account or password is wrong",
  40009: "the password is wrong",
  40012: "the account is unknown",
  40002: "the account is disabled",
  40003: "the account has too many devices signed in",
  40021: "the membership has expired",
  40022: "the line has as many users as it takes",
  20001: "the session has ended",
  20010: "the account signed in on another device",
};

function keys(t) {
  const salt = Buffer.from(CLIENT_KEY + String(t).slice(-8), "utf8");
  const key = createHash("sha256").update(salt).digest();
  const iv = createHash("sha256").update(Buffer.concat([key, salt])).digest().subarray(0, 16);
  return { key, iv };
}

const sign = (text) => createHmac("sha1", CLIENT_KEY).update(text).digest("base64");

/** A request body sealed as the extension seals it, at `t` seconds since the epoch. */
export function seal(payload, t = Math.floor(Date.now() / 1000)) {
  const { key, iv } = keys(t);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]).toString("base64");
  return { encrypted, t, sign: sign(`encrypted=${encrypted}&pub_key=${CLIENT_ID}&t=${t}&version=${CLIENT_VERSION}`), version: CLIENT_VERSION, pub_key: CLIENT_ID };
}

/** A sealed answer, or request, opened; one that is not sealed is returned as it is. */
export function open(body) {
  if (!body?.encrypted) return body;
  const signed = body.pub_key ? `encrypted=${body.encrypted}&pub_key=${body.pub_key}&t=${body.t}&version=${body.version}` : `encrypted=${body.encrypted}&t=${body.t}`;
  if (sign(signed) !== body.sign) throw new YoloError("resolve_failed", "Transocks answered with a bad signature");
  const { key, iv } = keys(body.t);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const text = Buffer.concat([decipher.update(Buffer.from(body.encrypted, "base64")), decipher.final()]).toString("utf8");
  return { ...JSON.parse(text), t: body.t };
}

/** The API's own words for a failed answer, never the request. */
export function apiError(answer) {
  const code = Number(answer?.code);
  const said = MESSAGES[code] ?? answer?.data?.error ?? answer?.msg ?? answer?.error ?? `code ${answer?.code}`;
  const error = new YoloError(code === 40001 || code === 40050 || code === 40009 || code === 40012 ? "unauthorized" : "resolve_failed", `Transocks: ${said}`);
  error.apiCode = code;
  return error;
}

/**
 * A client for one account. `account` is an email address or a phone number,
 * `countryCode` the phone's calling code; `deviceId` names this node to
 * Transocks as the extension's fingerprint names a browser.
 */
export function createTransocksApi({ account, password, countryCode = null, deviceId, fetchImpl = globalThis.fetch, now = () => Date.now(), origins = API_ORIGINS }) {
  let origin = origins[0];

  async function post(path, body, { token } = {}) {
    let lastError = null;
    for (const candidate of [origin, ...origins.filter((other) => other !== origin)]) {
      try {
        const response = await fetchImpl(`${candidate}${path}`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json; charset=utf-8", ...(token ? { Authorization: `${token.token_type} ${token.access_token}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status >= 500) throw new YoloError("resolve_failed", `Transocks answered ${response.status}`);
        if (!response.ok) throw Object.assign(new YoloError("resolve_failed", `Transocks answered ${response.status}`), { final: true });
        origin = candidate;
        return open(await response.json());
      } catch (error) {
        if (error.final) throw error;
        lastError = error;
      }
    }
    throw new YoloError("resolve_failed", `Transocks could not be reached: ${lastError?.message ?? "no answer"}`);
  }

  const ok = (answer) => {
    if (answer?.code === 0 || answer?.status === "ok") return answer;
    throw apiError(answer);
  };
  const base = (target) => ({ target, device: DEVICE, mac: deviceId, org: ORG, app_version: APP_VERSION });
  // /ext/gateway/line takes the sealed body with the device beside it, as the extension sends it.
  const lineBody = (payload) => ({ ...seal(payload, Math.floor(now() / 1000)), device: DEVICE, mac: DEVICE });

  return {
    /** Signs in, signing out the account's oldest device when it has too many. → { token, expiresAt } */
    async login() {
      const sameAs = account.includes("@") ? { email: account, auth: "email" } : { phone: account.replace(/[^\d]/g, ""), cc: String(countryCode ?? ""), auth: "mobile" };
      const answer = ok(await post("/ext/gateway", seal({ ...base("login"), language: "cn", ...sameAs, password, autokick: 1, auth_type: "jwt", model: "Yolo media node", os: process.versions.node }, Math.floor(now() / 1000))));
      const token = answer.data?.token;
      if (!token?.access_token) throw new YoloError("resolve_failed", "Transocks signed in without a token");
      if (answer.data?.expired) throw new YoloError("forbidden", "Transocks: the membership has expired");
      return { token: { token_type: token.token_type || "Bearer", access_token: token.access_token }, expiresAt: Number(token.exp) > 0 ? Number(token.exp) * 1000 : null };
    },

    /** The account's lines. → [{ id, name, location, host, detectPort, relay }] */
    async lines(token) {
      const answer = ok(await post("/ext/gateway/line", lineBody(base("lines")), { token }));
      const lines = answer.lines ?? answer.data?.lines ?? [];
      return lines.filter((line) => !line.error).map((line) => ({ id: line.id, name: String(line.name ?? line.id), location: String(line.location ?? ""), host: line.iPAddr, detectPort: Number(line.detectPort), relay: Boolean(line.isRelay) }));
    },

    /** Opens a session on a line. → { url, username, password, name } */
    async connect(token, lineID) {
      const answer = ok(await post("/ext/gateway/line", lineBody({ ...base("connect"), protocol: "http", proto: "HTTP", lineID, recommendLine: false, available_line: [] }), { token }));
      const conf = answer.config?.HTTPConf;
      if (!conf?.server || !conf?.port) throw new YoloError("resolve_failed", "Transocks gave the line no HTTP proxy");
      return { url: `http://${conf.server}:${conf.port}`, username: String(conf.username ?? ""), password: String(conf.password ?? ""), name: String(answer.lineName ?? lineID) };
    },

    /** Closes a session on a line; best effort. */
    async disconnect(token, lineID) {
      await post("/ext/gateway/line", lineBody({ ...base("disconnect"), protocol: "http", proto: "HTTP", lineID, recommendLine: false, available_line: [] }), { token }).catch(() => {});
    },
  };
}
