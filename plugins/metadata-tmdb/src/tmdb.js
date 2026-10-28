import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { YoloError } from "@useyolo/plugin-api";

// The Movie Database's API, as the metadata plugin uses it (Agent Note
// 2026-10-25-metadata-plugins): search, find by external id, and the movie,
// TV, season, and episode records, with the owner's own key. Responses are
// cached for 30 days, well within TMDB's six-month limit on cached data.

export const API = "https://api.themoviedb.org/3";
export const IMAGES = "https://image.tmdb.org/t/p";
export const ATTRIBUTION = Object.freeze({
  text: "This product uses the TMDB API but is not endorsed or certified by TMDB.",
  url: "https://www.themoviedb.org/",
});
const CACHE_MS = 30 * 86_400_000;
const TIMEOUT_MS = 8000;

// "en" → "en-US", "zh" → "zh-CN"; a full tag as given.
export function tmdbLanguage(language) {
  const tag = String(language || "en");
  if (/^[a-z]{2}-[A-Z]{2}$/.test(tag)) return tag;
  const defaults = { en: "en-US", zh: "zh-CN", "zh-hans": "zh-CN", "zh-hant": "zh-TW", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES" };
  return defaults[tag.toLowerCase()] ?? tag;
}

/** A sized image URL for a TMDB path, or null. */
export const image = (path, size) => (typeof path === "string" && path.startsWith("/") ? `${IMAGES}/${size}${path}` : null);

export function createTmdbClient({ key, fetch = globalThis.fetch, cacheDir = null, now = Date.now }) {
  // A v4 read access token is a JWT; a v3 key is 32 hex digits.
  const bearer = typeof key === "string" && key.includes(".");
  const memory = new Map();
  const file = (path) => (cacheDir ? join(cacheDir, `${createHash("sha256").update(path).digest("hex").slice(0, 32)}.json`) : null);

  function cached(path) {
    let entry = memory.get(path);
    if (!entry && cacheDir) {
      try {
        entry = JSON.parse(readFileSync(file(path), "utf8"));
      } catch {
        entry = null;
      }
    }
    return entry && entry.expires > now() ? entry.value : undefined;
  }

  function store(path, value) {
    const entry = { expires: now() + CACHE_MS, value };
    memory.set(path, entry);
    if (memory.size > 2000) memory.delete(memory.keys().next().value);
    if (!cacheDir) return;
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(`${file(path)}.tmp`, JSON.stringify(entry));
      renameSync(`${file(path)}.tmp`, file(path));
    } catch {}
  }

  /** GET `path` with `query`; null for a 404, which TMDB gives a missing season or episode. */
  async function get(path, query = {}) {
    if (!key) throw new YoloError("not_found", "No TMDB key is set (TMDB_API_KEY)");
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== null && value !== undefined && value !== ""));
    const name = `${path}?${params}`;
    const hit = cached(name);
    if (hit !== undefined) return hit;
    if (!bearer) params.set("api_key", key);
    const response = await fetch(`${API}${path}?${params}`, {
      headers: { accept: "application/json", ...(bearer ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) {
      store(name, null);
      return null;
    }
    if (response.status === 401) throw new YoloError("forbidden", "TMDB rejected the key: check TMDB_API_KEY");
    if (response.status === 429) throw new YoloError("rate_limited", "TMDB asked Yolo to slow down");
    if (!response.ok) throw new YoloError("resolve_failed", `TMDB answered ${response.status}`);
    const value = await response.json();
    store(name, value);
    return value;
  }

  return { configured: Boolean(key), get };
}
