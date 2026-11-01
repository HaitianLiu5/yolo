import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YoloError } from "@useyolo/plugin-api";

// GET JSON from a public API, kept for 30 days in memory and in the plugin's
// cacheDir, so a show asked about again, or its next episode, costs no
// request. A 404 is an answer too: null.

const CACHE_MS = 30 * 86_400_000;
const TIMEOUT_MS = 8000;
export const USER_AGENT = "Yolo/1.0 (https://useyolo.app; a self-hosted media server)";

export function createJsonClient({ name, fetch = globalThis.fetch, cacheDir = null, headers = {}, now = Date.now }) {
  const memory = new Map();
  const file = (key) => (cacheDir ? join(cacheDir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`) : null);

  function cached(key) {
    let entry = memory.get(key);
    if (!entry && cacheDir) {
      try {
        entry = JSON.parse(readFileSync(file(key), "utf8"));
      } catch {
        entry = null;
      }
    }
    return entry && entry.expires > now() ? entry.value : undefined;
  }

  function store(key, value) {
    const entry = { expires: now() + CACHE_MS, value };
    memory.set(key, entry);
    if (memory.size > 2000) memory.delete(memory.keys().next().value);
    if (!cacheDir) return;
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(`${file(key)}.tmp`, JSON.stringify(entry));
      renameSync(`${file(key)}.tmp`, file(key));
    } catch {}
  }

  return async function getJson(url, { method = "GET", body = null, headers: extra = {} } = {}) {
    const key = `${method} ${url} ${body ? JSON.stringify(body) : ""} ${JSON.stringify(extra)}`;
    const hit = cached(key);
    if (hit !== undefined) return hit;
    const response = await fetch(url, {
      method,
      headers: { accept: "application/json", "user-agent": USER_AGENT, ...headers, ...extra, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) {
      store(key, null);
      return null;
    }
    if (response.status === 429) throw new YoloError("rate_limited", `${name} asked Yolo to slow down`);
    if (!response.ok) throw new YoloError("resolve_failed", `${name} answered ${response.status}`);
    const value = await response.json();
    store(key, value);
    return value;
  };
}

// Titles compared without case, punctuation, or spaces.
export const fold = (text) => String(text ?? "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

// How well `names` fit `own`: 1 for the same name, 0.75 for one inside the other.
export function nameScore(names, own) {
  let best = 0;
  for (const name of names.map(fold).filter((value) => value.length > 1)) {
    for (const other of own.map(fold).filter(Boolean)) {
      if (name === other) best = 1;
      else if (other.length > 2 && name.length > 2 && (other.includes(name) || name.includes(other))) best = Math.max(best, 0.75);
    }
  }
  return best;
}

// What the item says it is: the model's identity, else the parser's hints.
export function wanted(subject) {
  const identity = subject.identity;
  if (identity && identity.kind !== "other") {
    const show = identity.show ?? {};
    const names = identity.kind === "movie" ? [identity.originalTitle, identity.title] : [show.originalTitle, show.title];
    return {
      kind: identity.kind === "movie" ? "movie" : "episode",
      names: [...new Set([...names, ...(subject.hints?.titles ?? [])].filter(Boolean))],
      year: identity.kind === "movie" ? identity.year : show.year,
      season: identity.season,
      episode: identity.episode,
    };
  }
  const hints = subject.hints ?? { titles: [] };
  const kind = hints.kind === "movie" || (hints.season == null && hints.episode == null && hints.kind !== "episode") ? "movie" : "episode";
  return { kind, names: hints.titles, year: hints.year ?? null, season: hints.season ?? (hints.episode != null ? 1 : null), episode: hints.episode ?? null };
}

// Within `share` of the record's runtime, or null when either is unknown.
export const lengthFits = (seconds, minutes, share) => (seconds > 0 && minutes > 0 ? Math.abs(seconds - minutes * 60) <= minutes * 60 * share : null);
export const yearOf = (date) => (typeof date === "string" && /^\+?\d{4}/.test(date) ? Number(date.replace(/^\+/, "").slice(0, 4)) : null);
export const stripHtml = (html) => (typeof html === "string" ? html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").trim() || null : null);
export const round = (value) => Math.round(Math.min(Math.max(value, 0), 0.97) * 100) / 100;

// How sure a record is from its name: the same name is a match, a name that
// only contains the other (a sequel, an OAD, a spin-off) is a candidate
// for the owner to choose, never applied by itself.
export const nameConfidence = (score) => (score >= 1 ? 0.85 + 0.1 * Math.min(score, 1.05) : 0.7);
