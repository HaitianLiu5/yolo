import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_USER_AGENT } from "./formats.js";

// Yolo's own sign-in to Tencent Video, for full replays and paid live games
// (Agent Note 2026-10-26-tencent-sports-replays). It is a WeChat sign-in on
// Tencent Sports: the owner scans a QR code once (`npm run yolo -- accounts
// login`, setup.js), or Yolo starts from the sign-in in the owner's cookies
// file. Tencent Sports gives such a sign-in a Tencent Video session of under
// two hours (init/login with videoAuth), and its WeChat refresh token renews
// it (init/refresh) for about 30 days, as Tencent Sports' own page does; the
// node renews it on demand. The sign-in is kept in the plugin's state
// directory, mode 0600, and never logged.

const API = "https://app.sports.qq.com/init";
const OAUTH = "https://matchweb.sports.qq.com/wx/oAuth";
const WECHAT_APP = "wxf51d5e4cfe881d5a";
const WECHAT_QR = "https://open.weixin.qq.com/connect/qrconnect";
const WECHAT_POLL = "https://lp.open.weixin.qq.com/connect/l/qrconnect";
const TIMEOUT_MS = 8_000;
// Renew a session with less than this left, and wait this long after a
// renewal failed before trying again.
const RENEW_MARGIN_MS = 10 * 60_000;
const RETRY_AFTER_MS = 60_000;
const HEADERS = { "user-agent": BROWSER_USER_AGENT, referer: "https://sports.qq.com/", origin: "https://sports.qq.com" };

export const STATE_FILE = "tencent.json";
export const COOKIES_FILE = "tencent-cookies.txt";

// The cookies a Netscape cookies file holds for `domain` and its subdomains,
// by name: { name: value }.
export function cookiesFor(text, domain) {
  const cookies = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.startsWith("#HttpOnly_") ? raw.slice("#HttpOnly_".length) : raw;
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 7) continue;
    const host = fields[0].replace(/^\./, "").toLowerCase();
    if (host === domain || host.endsWith(`.${domain}`)) cookies[fields[5]] = fields[6];
  }
  return cookies;
}

const cookieHeader = (cookies) => Object.entries(cookies).filter(([, value]) => value).map(([name, value]) => `${name}=${value}`).join("; ");

// A WeChat sign-in, which is all Yolo renews: its app and refresh token.
const signedIn = (cookies) => cookies?.main_login === "wx" && Boolean(cookies.appid && cookies.refresh_token);

async function getJson(url, cookies, fetchImpl) {
  const response = await fetchImpl(url, { headers: { ...HEADERS, cookie: cookieHeader(cookies) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Tencent Sports answered ${response.status}`);
  const body = await response.json();
  if (body?.code !== 0 || !body.data) throw new Error(`Tencent Sports answered code ${body?.code}: ${body?.msg || "no message"}`);
  return body.data;
}

// The cookies an answer sets, over `cookies`; an empty value keeps the old one.
function withAnswer(cookies, data) {
  const next = { ...cookies };
  for (const { name, value } of Array.isArray(data.cookie) ? data.cookie : []) {
    if (name && value) next[name] = String(value);
  }
  if (data.wxReply?.access_token) next.access_token = data.wxReply.access_token;
  if (data.wxReply?.refresh_token) next.refresh_token = data.wxReply.refresh_token;
  return next;
}

/**
 * Renews a WeChat sign-in's Tencent Video session: { cookies, until }, with
 * `until` in milliseconds. `refresh: false` skips the WeChat token's renewal,
 * for a sign-in that has just been made.
 */
export async function renewSession(cookies, { fetchImpl = globalThis.fetch, now = Date.now(), refresh = true } = {}) {
  let next = { ...cookies };
  if (refresh) {
    const query = new URLSearchParams({ os: "web", appid: next.appid, refresh_token: next.refresh_token, qimei: "" });
    next = withAnswer(next, await getJson(`${API}/refresh?${query}`, next, fetchImpl));
  }
  const login = await getJson(`${API}/login?os=web&videoAuth=1&qimei=`, next, fetchImpl);
  next = withAnswer(next, login);
  if (!next.vuserid || !next.vusession) throw new Error("Tencent Sports gave no Tencent Video session");
  const ttl = Number(login.tokenTTL) > 0 ? Number(login.tokenTTL) : 3600;
  return { cookies: next, until: now + ttl * 1000 };
}

// What Tencent Video's APIs read for a WeChat session, on .video.qq.com.
const VIDEO_COOKIES = ["main_login", "appid", "openid", "access_token", "refresh_token", "vuserid", "vusession", "video_appid", "video_platform"];

/**
 * The owner's cookies file with this session's Tencent Video cookies in
 * place of any it has, for yt-dlp's Tencent Video runs.
 */
export function mergedCookiesFile(text, cookies, until) {
  const replaced = new Set(VIDEO_COOKIES);
  const kept = String(text ?? "").split(/\r?\n/).filter((raw) => {
    if (!raw || raw.startsWith("# Netscape")) return false;
    const line = raw.startsWith("#HttpOnly_") ? raw.slice("#HttpOnly_".length) : raw;
    const fields = line.split("\t");
    if (line.startsWith("#") || fields.length < 7) return true;
    const host = fields[0].replace(/^\./, "").toLowerCase();
    return !((host === "video.qq.com" || host === "v.qq.com") && replaced.has(fields[5]));
  });
  const expires = String(Math.floor(until / 1000));
  const lines = VIDEO_COOKIES.filter((name) => cookies[name]).flatMap((name) => [".video.qq.com", ".v.qq.com"].map((host) => [host, "TRUE", "/", "FALSE", expires, name, cookies[name]].join("\t")));
  return ["# Netscape HTTP Cookie File", ...kept, ...lines, ""].join("\n");
}

function writePrivate(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

/** The sign-in kept in `stateDir`: { cookies, until, via, at }, or null. */
export function readSignIn(stateDir) {
  if (!stateDir) return null;
  try {
    const value = JSON.parse(readFileSync(join(stateDir, STATE_FILE), "utf8"));
    return signedIn(value?.cookies) ? value : null;
  } catch {
    return null;
  }
}

export function writeSignIn(stateDir, signIn) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writePrivate(join(stateDir, STATE_FILE), `${JSON.stringify(signIn, null, 2)}\n`);
}

export function removeSignIn(stateDir) {
  for (const name of [STATE_FILE, COOKIES_FILE]) rmSync(join(stateDir, name), { force: true });
}

/**
 * The node's Tencent sign-in. `session()` is the current Tencent Video
 * session, renewed when it ends soon ({ vuserid, vusession, cookie }, the
 * cookie header Tencent Video's APIs read), or null without a sign-in or
 * when renewing failed. `ytdlpCookies()` is the cookies file yt-dlp reads
 * for Tencent Video with that session, or null.
 */
export function createTencentAccount({ stateDir = null, cookiesFile = null, fetchImpl = globalThis.fetch, now = () => Date.now(), logger = console } = {}) {
  let current = null; // { cookies, until, via, at }
  let seenMtime = null;
  let renewing = null;
  let failedAt = 0;
  let mergedFor = null;

  const ownCookies = () => {
    if (!cookiesFile) return "";
    try {
      return readFileSync(cookiesFile, "utf8");
    } catch {
      return "";
    }
  };
  const stateMtime = () => {
    try {
      return statSync(join(stateDir, STATE_FILE)).mtimeMs;
    } catch {
      return null;
    }
  };

  // The kept sign-in, read again when `accounts login` wrote a new one and
  // dropped when `accounts logout` removed it; else the WeChat sign-in of
  // the owner's cookies file, which Yolo then keeps.
  function load() {
    const mtime = stateDir ? stateMtime() : null;
    if (mtime !== seenMtime) {
      seenMtime = mtime;
      current = mtime == null ? null : readSignIn(stateDir);
      failedAt = 0;
    }
    if (current) return current;
    const cookies = cookiesFor(ownCookies(), "sports.qq.com");
    return signedIn(cookies) ? { cookies, until: 0, via: "cookies", at: now() } : null;
  }

  async function renew(signIn) {
    let renewed;
    try {
      renewed = await renewSession(signIn.cookies, { fetchImpl, now: now() });
    } catch (error) {
      // A cookies file exported since has a newer sign-in to start from.
      const exported = cookiesFor(ownCookies(), "sports.qq.com");
      if (!signedIn(exported) || exported.refresh_token === signIn.cookies.refresh_token) throw error;
      renewed = await renewSession(exported, { fetchImpl, now: now() });
      signIn = { ...signIn, via: "cookies", at: now() };
    }
    current = { ...signIn, ...renewed };
    if (stateDir) {
      writeSignIn(stateDir, current);
      seenMtime = stateMtime();
    }
    return current;
  }

  async function session() {
    const signIn = load();
    if (!signIn) return null;
    if (signIn.until - RENEW_MARGIN_MS <= now()) {
      if (now() - failedAt < RETRY_AFTER_MS) return null;
      renewing ??= renew(signIn).catch((error) => {
        failedAt = now();
        logger.warn?.(`Tencent sign-in could not be renewed (${error.message}): paid games play only a preview until the owner runs npm run yolo -- accounts login`);
        return null;
      }).finally(() => {
        renewing = null;
      });
      if (!(await renewing)) return null;
    }
    const { cookies } = current ?? signIn;
    const video = Object.fromEntries(VIDEO_COOKIES.map((name) => [name, cookies[name]]));
    return {
      vuserid: cookies.vuserid,
      vusession: cookies.vusession,
      cookie: cookieHeader({ ...video, v_main_login: "wx", v_vuserid: cookies.vuserid, v_vusession: cookies.vusession }),
    };
  }

  return {
    session,
    async ytdlpCookies() {
      if (!stateDir || !(await session())) return null;
      const file = join(stateDir, COOKIES_FILE);
      // Written again only for a new session, so yt-dlp's own updates to it
      // last until then.
      if (mergedFor !== current.cookies.vusession) {
        writePrivate(file, mergedCookiesFile(ownCookies(), current.cookies, current.until));
        mergedFor = current.cookies.vusession;
      }
      return file;
    },
    status() {
      const signIn = load();
      return signIn ? { signedIn: true, via: signIn.via, sessionUntil: signIn.until ? new Date(signIn.until).toISOString() : null } : { signedIn: false };
    },
  };
}

// --- Signing in with WeChat --------------------------------------------------

/**
 * A WeChat QR code for signing in to Tencent Sports: { uuid, text, image },
 * `text` being what the code says, for a terminal to draw, and `image` the
 * picture WeChat serves.
 */
export async function wechatQrCode({ fetchImpl = globalThis.fetch } = {}) {
  const query = new URLSearchParams({ appid: WECHAT_APP, redirect_uri: `${OAUTH}?appid=${WECHAT_APP}&`, response_type: "code", scope: "snsapi_login", state: "state" });
  const response = await fetchImpl(`${WECHAT_QR}?${query}`, { headers: { "user-agent": BROWSER_USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`WeChat answered ${response.status}`);
  const uuid = (await response.text()).match(/connect\/qrcode\/([\w-]+)/)?.[1];
  if (!uuid) throw new Error("WeChat gave no QR code");
  return { uuid, text: `https://open.weixin.qq.com/connect/confirm?uuid=${uuid}`, image: `https://open.weixin.qq.com/connect/qrcode/${uuid}` };
}

/**
 * Waits for the owner to scan and confirm the QR code `uuid` in WeChat:
 * the authorization code, after `onScanned()` when the code is scanned.
 * Throws when the code expires or the owner cancels.
 */
export async function wechatCode(uuid, { fetchImpl = globalThis.fetch, onScanned = () => {}, signal } = {}) {
  let last = "";
  for (;;) {
    signal?.throwIfAborted();
    const response = await fetchImpl(`${WECHAT_POLL}?uuid=${encodeURIComponent(uuid)}${last ? `&last=${last}` : ""}&_=${Date.now()}`, {
      headers: { "user-agent": BROWSER_USER_AGENT },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    const code = text.match(/wx_errcode=(\d+)/)?.[1];
    // 408: waiting; 404: scanned; 405: confirmed; 403: cancelled; 402: expired.
    if (code === "405") {
      const value = text.match(/wx_code='([^']*)'/)?.[1];
      if (value) return value;
    } else if (code === "404") {
      if (last !== "404") onScanned();
    } else if (code === "403") {
      throw new Error("The sign-in was cancelled in WeChat");
    } else if (code === "402" || code === "500") {
      throw new Error("The QR code expired: run the sign-in again");
    }
    if (code) last = code;
  }
}

/**
 * Turns WeChat's authorization code into a Tencent Sports sign-in with its
 * first Tencent Video session: { cookies, until, via: "wechat", at }.
 */
export async function signInWithCode(code, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const response = await fetchImpl(`${OAUTH}?appid=${WECHAT_APP}&code=${encodeURIComponent(code)}&state=state`, { headers: HEADERS, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const cookies = { main_login: "wx", appid: WECHAT_APP };
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(at + 1)) cookies[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  if (!signedIn(cookies)) throw new Error("Tencent Sports did not accept the WeChat sign-in");
  return { ...(await renewSession(cookies, { fetchImpl, now, refresh: false })), via: "wechat", at: now };
}
