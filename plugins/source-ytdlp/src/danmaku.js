import { readFile } from "node:fs/promises";
import { BROWSER_USER_AGENT } from "./formats.js";

// Bilibili's danmaku (bullet comments) for the source's `comments`
// capability (Agent Note 2026-10-13-danmaku).
//
// yt-dlp names an item's comment XML, https://comment.bilibili.com/<cid>.xml,
// as its `danmaku` subtitle, but only when asked for subtitles (--write-subs),
// so comments need their own yt-dlp call; its answer is kept per page URL.
// The XML is the whole item in one request, capped by Bilibili at its newest
// `maxlimit` comments. Measured anonymously on 2026-10-13 it held 2 to 3
// times what the segmented protobuf API (the web player's 6-minute
// segments) gave for the same videos: 7,200 against 2,827 for a 44-minute
// video, 600 against 283 for a 2-minute one. So the XML comes first, and a
// segment of the protobuf API is the fallback when the XML fails.
//
// Requests carry a browser's User-Agent and Bilibili's Referer, as the
// plugin's media requests do, and the cookies of the configured cookies file
// for the host; a browser profile's cookies (cookiesFromBrowser) reach only
// yt-dlp, so with them comments are fetched anonymously.

export const SEGMENT_SECONDS = 360;
const SEGMENT_API = "https://api.bilibili.com/x/v2/dm/web/seg.so";
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
// Comments beyond this many in one answer are dropped (a segment of a very
// busy video holds a few thousand).
export const MAX_COMMENTS_PER_ANSWER = 20_000;
const MAX_TEXT = 100;
const MAX_ITEMS = 32;
// Bilibili modes: 1–3 scroll right to left, 4 bottom, 5 top, 6 scrolls left
// to right (drawn as a scroll). 7 (positioned), 8 (code), and 9 (BAS) are
// scripted effects, which Yolo does not draw.
const MODES = Object.freeze({ 1: "scroll", 2: "scroll", 3: "scroll", 4: "bottom", 5: "top", 6: "scroll" });
// The special pool holds scripted comments; 0 is normal, 1 subtitles.
const SPECIAL_POOL = 2;
const NORMAL_FONT_SIZE = 25;

const PAGE_HOSTS = /(^|\.)bilibili\.com$|^b23\.tv$/i;
const OFFICIAL_XML = /^https:\/\/comment\.bilibili\.com\/(\d+)\.xml$/i;

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** Whether a page URL is Bilibili's, which alone has danmaku. */
export const isBilibiliPage = (url) => PAGE_HOSTS.test(hostOf(url));

/** The cid in Bilibili's own comment XML URL, else null. */
export function danmakuCid(xmlUrl) {
  return OFFICIAL_XML.exec(String(xmlUrl || ""))?.[1] ?? null;
}

/** The comment XML that yt-dlp lists for an item, or null. */
export function danmakuXmlUrl(info) {
  const formats = Array.isArray(info?.subtitles?.danmaku) ? info.subtitles.danmaku : [];
  return formats.find((format) => format?.ext === "xml" && /^https?:\/\//i.test(String(format.url || "")))?.url ?? null;
}

// `weight` is Bilibili's rank of the comment for its "smart blocking", 1
// (hidden first) to 10; its player hides those below 3 by default.
function comment(seconds, mode, fontSize, color, text, weight) {
  const kind = MODES[mode];
  const body = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!kind || !body || !(seconds >= 0)) return null;
  const parsed = {
    t: Math.round(seconds * 1000) / 1000,
    text: body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT)}…` : body,
    mode: kind,
    color: `#${((Number(color) >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`,
    size: Number(fontSize) > 0 ? Math.round((Number(fontSize) / NORMAL_FONT_SIZE) * 100) / 100 : 1,
  };
  const rank = Number(weight);
  if (Number.isInteger(rank) && rank >= 0 && rank <= 10) parsed.weight = rank;
  return parsed;
}

const bySecond = (left, right) => left.t - right.t;

const ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" });
function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? match;
    const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/**
 * Comments of Bilibili's comment XML: `<d p="seconds,mode,size,color,sent,pool,user,id,weight">text</d>`.
 * @returns {Array<{ t: number, text: string, mode: string, color: string, size: number, weight?: number }>}
 */
export function parseDanmakuXml(xml) {
  const comments = [];
  for (const [, attributes, text] of String(xml).matchAll(/<d\s+p="([^"]*)"\s*>([\s\S]*?)<\/d>/g)) {
    const [seconds, mode, size, color, , pool, , , weight] = attributes.split(",");
    if (Number(pool) === SPECIAL_POOL) continue;
    const parsed = comment(Number(seconds), Number(mode), Number(size), Number(color), decodeXml(text), weight === undefined || weight === "" ? NaN : Number(weight));
    if (parsed) comments.push(parsed);
    if (comments.length >= MAX_COMMENTS_PER_ANSWER) break;
  }
  return comments.sort(bySecond);
}

// --- Protocol Buffers, as much as one segment needs -------------------------
// DmSegMobileReply { repeated DanmakuElem elems = 1; }
// DanmakuElem { progress = 2 (ms); mode = 3; fontsize = 4; color = 5; content = 7 (string); weight = 9; pool = 11; }

function reader(bytes) {
  let offset = 0;
  const varint = () => {
    let value = 0;
    let scale = 1;
    for (let shift = 0; shift < 64; shift += 7) {
      if (offset >= bytes.length) throw new Error("A danmaku segment ends inside a number");
      const byte = bytes[offset++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
    throw new Error("A danmaku segment has a number longer than 64 bits");
  };
  return {
    get done() {
      return offset >= bytes.length;
    },
    // Returns [field, wire type, value]: a number, or the bytes of a length-delimited field.
    next() {
      const key = varint();
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (wire === 0) return [field, wire, varint()];
      if (wire === 2) {
        const length = varint();
        if (offset + length > bytes.length) throw new Error("A danmaku segment field runs past its end");
        const value = bytes.subarray(offset, offset + length);
        offset += length;
        return [field, wire, value];
      }
      if (wire === 1 || wire === 5) {
        offset += wire === 1 ? 8 : 4;
        return [field, wire, null];
      }
      throw new Error(`A danmaku segment has an unknown wire type ${wire}`);
    },
  };
}

const utf8 = new TextDecoder();

function element(bytes) {
  const fields = { progress: 0, mode: 1, fontsize: NORMAL_FONT_SIZE, color: 0xffffff, content: "", weight: NaN, pool: 0 };
  const read = reader(bytes);
  while (!read.done) {
    const [field, , value] = read.next();
    if (field === 2) fields.progress = value;
    else if (field === 3) fields.mode = value;
    else if (field === 4) fields.fontsize = value;
    else if (field === 5) fields.color = value;
    else if (field === 7 && value) fields.content = utf8.decode(value);
    else if (field === 9) fields.weight = value;
    else if (field === 11) fields.pool = value;
  }
  if (fields.pool === SPECIAL_POOL) return null;
  return comment(fields.progress / 1000, fields.mode, fields.fontsize, fields.color, fields.content, fields.weight);
}

/** Comments of one protobuf segment (`seg.so`). */
export function parseDanmakuSegment(bytes) {
  const comments = [];
  const read = reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  while (!read.done) {
    const [field, wire, value] = read.next();
    if (field !== 1 || wire !== 2) continue;
    const parsed = element(value);
    if (parsed) comments.push(parsed);
    if (comments.length >= MAX_COMMENTS_PER_ANSWER) break;
  }
  return comments.sort(bySecond);
}

// --- Cookies ---------------------------------------------------------------

/** The Cookie header a Netscape cookies file gives `url`, or null. */
export function cookieHeader(text, url, now = Date.now()) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  const host = target.hostname.toLowerCase();
  const pairs = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.startsWith("#HttpOnly_") ? raw.slice("#HttpOnly_".length) : raw;
    if (!line || line.startsWith("#")) continue;
    const [domain, , path = "/", secure, expires, name, value = ""] = line.split("\t");
    if (!domain || !name) continue;
    const bare = domain.toLowerCase().replace(/^\./, "");
    if (host !== bare && !host.endsWith(`.${bare}`)) continue;
    if (!target.pathname.startsWith(path || "/")) continue;
    if (secure === "TRUE" && target.protocol !== "https:") continue;
    const expiry = Number(expires);
    if (expiry > 0 && expiry * 1000 < now) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.length ? pairs.join("; ") : null;
}

// --- Fetching --------------------------------------------------------------

async function fetchBody(url, { headers, fetchImpl }) {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  // The segment API answers 304 for a segment past the item's end.
  if (response.status === 204 || response.status === 304) return { body: new Uint8Array(0), type: "" };
  if (!response.ok) throw new Error(`${hostOf(url)} answered ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error(`${hostOf(url)} sent more than 8 MiB of comments`);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error(`${hostOf(url)} sent more than 8 MiB of comments`);
  return { body, type: response.headers.get("content-type") || "" };
}

/**
 * The `comments` capability for the yt-dlp source.
 * @param {object} options
 * @param {{ danmaku: (url: string) => Promise<object> }} options.ytdlp
 * @param {string | null} [options.cookiesFile]  a Netscape cookies file
 */
export function createDanmaku({ ytdlp, cookiesFile = null, fetchImpl = globalThis.fetch, logger = console, readText = (file) => readFile(file, "utf8") } = {}) {
  const items = new Map(); // page URL → Promise<{ xmlUrl, cid, headers } | null>

  // What yt-dlp says about the item's comments, once per page URL (the most
  // recent MAX_ITEMS). A failure is not kept, so the next call asks again.
  function lookup(url) {
    if (items.has(url)) {
      const known = items.get(url);
      items.delete(url);
      items.set(url, known);
      return known;
    }
    const pending = ytdlp.danmaku(url).then((info) => {
      const xmlUrl = danmakuXmlUrl(info);
      if (!xmlUrl) return null;
      const given = info.http_headers && typeof info.http_headers === "object" ? info.http_headers : {};
      return {
        xmlUrl,
        cid: danmakuCid(xmlUrl),
        headers: { "User-Agent": BROWSER_USER_AGENT, Referer: "https://www.bilibili.com/", ...given, Accept: "*/*" },
      };
    });
    items.set(url, pending);
    pending.catch(() => items.delete(url));
    while (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
    return pending;
  }

  async function headersFor(item, url) {
    if (!cookiesFile) return item.headers;
    try {
      const cookie = cookieHeader(await readText(cookiesFile), url);
      return cookie ? { ...item.headers, Cookie: cookie } : item.headers;
    } catch (error) {
      logger.warn?.(`danmaku: the cookies file could not be read: ${error.message}`);
      return item.headers;
    }
  }

  async function segment(item, index) {
    const url = `${SEGMENT_API}?type=1&oid=${item.cid}&segment_index=${index + 1}`;
    const { body, type } = await fetchBody(url, { headers: await headersFor(item, url), fetchImpl });
    // A refusal (risk control, a removed video) is JSON with a code.
    if (/json/i.test(type)) throw new Error(`${hostOf(url)} refused the segment: ${utf8.decode(body.subarray(0, 200))}`);
    return parseDanmakuSegment(body);
  }

  async function wholeXml(item) {
    const { body } = await fetchBody(item.xmlUrl, { headers: await headersFor(item, item.xmlUrl), fetchImpl });
    return parseDanmakuXml(utf8.decode(body));
  }

  /**
   * The item's comments: the whole item from the XML, else the segment that
   * holds `start`. Null for an item without danmaku.
   */
  return async function comments(pageUrl, { start = 0 } = {}) {
    if (!isBilibiliPage(pageUrl)) return null;
    const item = await lookup(pageUrl);
    if (!item) return null;
    try {
      return { comments: await wholeXml(item), start: 0, end: null };
    } catch (error) {
      if (!item.cid) throw error;
      logger.warn?.(`danmaku: the comment XML failed (${error.message}); reading a segment`);
    }
    const index = Math.max(0, Math.floor(Number(start) / SEGMENT_SECONDS) || 0);
    return { comments: await segment(item, index), start: index * SEGMENT_SECONDS, end: (index + 1) * SEGMENT_SECONDS };
  };
}
