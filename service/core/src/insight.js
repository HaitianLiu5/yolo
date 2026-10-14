import { YoloError } from "./errors.js";
import { formatTimestamp } from "./timestamp.js";

// What a source tells an agent about an item beyond playing it: chapters and
// markers, and details (Agent Note 2026-10-07-remote-mcp-server). Plugins
// fill these in their own terms; these functions give every source the same
// compact shape, so agents pay for few tokens and the core knows no provider.

// "chapter" is a named part of the item; "intro" and "credits" are markers a
// player may skip.
export const CHAPTER_KINDS = Object.freeze(["chapter", "intro", "credits"]);
const KIND_ORDER = Object.freeze({ chapter: 0, intro: 1, credits: 2 });
const MAX_CHAPTERS = 300;
// A chapter whose title names the opening counts as the intro when the source
// has no intro marker.
const OPENING_TITLE = /^\s*(intro(duction)?|opening( (credits|titles))?|op|片头|オープニング)\s*$/i;

const tenths = (value) => Math.round(value * 10) / 10;
const finite = (value) => (value === null || value === undefined || value === "" ? null : (Number.isFinite(Number(value)) ? Number(value) : null));

function text(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const trimmed = String(value).replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * A source's chapters and markers as [{ start, end, kind, title? }] in
 * seconds, sorted by start. An entry without a usable start, with an end at or
 * before its start, or with a kind Yolo does not know is dropped. A chapter
 * without an end runs to the next chapter, or to `duration`.
 */
export function normalizeChapters(list, { duration = null } = {}) {
  const total = finite(duration) > 0 ? Number(duration) : null;
  const seen = new Set();
  const entries = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== "object") continue;
    const kind = entry.kind == null ? "chapter" : String(entry.kind);
    if (!CHAPTER_KINDS.includes(kind)) continue;
    const start = finite(entry.start);
    if (start === null || start < 0 || (total !== null && start >= total)) continue;
    let end = finite(entry.end);
    if (end !== null && end <= start) continue;
    if (end !== null && total !== null) end = Math.min(end, total);
    const title = text(entry.title, 120);
    const key = `${tenths(start)}\n${kind}\n${title ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ start: tenths(start), end: end === null ? null : tenths(end), kind, ...(title ? { title } : {}) });
  }
  entries.sort((a, b) => a.start - b.start || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const chapters = entries.filter((entry) => entry.kind === "chapter");
  for (const entry of chapters) {
    if (entry.end !== null) continue;
    const next = chapters.find((other) => other.start > entry.start);
    entry.end = next ? next.start : (total !== null ? tenths(total) : null);
  }
  return entries.slice(0, MAX_CHAPTERS);
}

const span = (entry) => `${formatTimestamp(entry.start)}–${entry.end === null ? "?" : formatTimestamp(entry.end)}`;

/**
 * Where a skip goes from `position`: `to` is "intro" (past the intro the
 * position is in), "next_chapter", or "previous_chapter" (the start of this
 * chapter, or of the one before within its first 3 seconds). Returns
 * { position, chapter }; throws not_found when there is nowhere to go.
 */
export function skipTarget(chapters, position, to) {
  const at = Math.max(0, Number(position) || 0);
  const list = Array.isArray(chapters) ? chapters : [];
  if (to === "intro") {
    const markers = list.filter((entry) => entry.kind === "intro" && entry.end !== null);
    const intros = markers.length ? markers : list.filter((entry) => entry.kind === "chapter" && entry.end !== null && OPENING_TITLE.test(entry.title || ""));
    if (!intros.length) throw new YoloError("not_found", "This item has no intro marker or opening chapter");
    const current = intros.find((entry) => entry.start - 2 <= at && at < entry.end);
    if (current) return { position: current.end, chapter: current };
    throw new YoloError("not_found", `Playback is not in the intro now (at ${formatTimestamp(at)}); the intro runs ${intros.slice(0, 3).map(span).join(", ")}`);
  }
  if (to !== "next_chapter" && to !== "previous_chapter") throw new YoloError("invalid_request", "to must be intro, next_chapter, or previous_chapter");
  const parts = list.filter((entry) => entry.kind === "chapter");
  if (!parts.length) throw new YoloError("not_found", "This item has no chapters");
  if (to === "next_chapter") {
    const next = parts.find((entry) => entry.start > at + 1);
    if (!next) throw new YoloError("not_found", "This is the last chapter");
    return { position: next.start, chapter: next };
  }
  let index = -1;
  parts.forEach((entry, i) => {
    if (entry.start <= at + 0.5) index = i;
  });
  const current = parts[index] ?? null;
  if (current && at - current.start > 3) return { position: current.start, chapter: current };
  const previous = parts[index - 1] ?? null;
  return previous ? { position: previous.start, chapter: previous } : { position: 0, chapter: current ?? parts[0] };
}

const MAX_DESCRIPTION = 1500;
const MAX_PEOPLE = 20;

function description(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return null;
  if (cleaned.length <= MAX_DESCRIPTION) return cleaned;
  const cut = cleaned.slice(0, MAX_DESCRIPTION);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_DESCRIPTION * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function words(value, max, length = 50) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const word = text(entry, length);
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(word);
    if (out.length >= max) break;
  }
  return out.length ? out : null;
}

function date(value) {
  const raw = text(value, 40);
  if (!raw) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const iso = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(raw);
  if (!iso) return null;
  return [iso[1], iso[2], iso[3]].filter(Boolean).join("-");
}

function people(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const out = [];
  for (const person of value) {
    const name = text(person?.name, 100);
    if (!name) continue;
    const role = (text(person.role, 32) || "cast").toLowerCase();
    if (seen.has(`${name}\n${role}`)) continue;
    seen.add(`${name}\n${role}`);
    const character = text(person.character, 100);
    out.push({ name, role, ...(character ? { character } : {}) });
    if (out.length >= MAX_PEOPLE) break;
  }
  return out.length ? out : null;
}

function ratings(value) {
  if (!Array.isArray(value)) return null;
  const out = value.map((rating) => {
    const score = finite(rating?.value);
    if (score === null) return null;
    const max = finite(rating.max);
    const source = text(rating.source, 40);
    return { value: tenths(score), ...(max > 0 ? { max } : {}), ...(source ? { source } : {}) };
  }).filter(Boolean).slice(0, 4);
  return out.length ? out : null;
}

const count = (value) => (finite(value) !== null && Number(value) >= 0 ? Math.floor(Number(value)) : null);

function series(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  const title = text(value.title, 200);
  const episodeTitle = text(value.episodeTitle, 200);
  if (title) out.title = title;
  if (count(value.season) !== null) out.season = count(value.season);
  if (count(value.episode) !== null) out.episode = count(value.episode);
  if (episodeTitle) out.episodeTitle = episodeTitle;
  return Object.keys(out).length ? out : null;
}

function stats(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const [key, number] of Object.entries(value)) {
    if (!/^[a-z]{1,20}$/.test(key) || count(number) === null) continue;
    out[key] = count(number);
    if (Object.keys(out).length >= 6) break;
  }
  return Object.keys(out).length ? out : null;
}

function progress(value) {
  if (!value || typeof value !== "object") return null;
  const position = finite(value.position);
  const out = {};
  if (position !== null && position > 0) out.position = Math.round(position);
  if (typeof value.watched === "boolean") out.watched = value.watched;
  return Object.keys(out).length ? out : null;
}

const url = (value) => {
  const raw = text(value, 2000);
  return raw && /^https?:\/\//i.test(raw) ? raw : null;
};

/**
 * A source's details as one compact object, with only the fields that have a
 * value: { title, kind, description, date, year, duration, people, genres,
 * tags, ratings, contentRating, series, studio, language, url, stats,
 * progress }. `fallback` ({ title, duration } from describe()) fills a source
 * that offers no details, or leaves them out.
 */
export function normalizeDetails(raw, fallback = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const when = date(source.date);
  const year = count(source.year) || (when ? Number(when.slice(0, 4)) : null);
  const duration = finite(source.duration) > 0 ? Math.round(Number(source.duration)) : (finite(fallback?.duration) > 0 ? Math.round(Number(fallback.duration)) : null);
  const fields = {
    title: text(source.title, 300) ?? text(fallback?.title, 300),
    kind: text(source.kind, 32),
    description: description(source.description),
    date: when,
    year,
    duration,
    people: people(source.people),
    genres: words(source.genres, 10),
    tags: words(source.tags, 15),
    ratings: ratings(source.ratings),
    contentRating: text(source.contentRating, 20),
    series: series(source.series),
    studio: text(source.studio, 100),
    language: text(source.language, 20),
    url: url(source.url),
    stats: stats(source.stats),
    progress: progress(source.progress),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined));
}
