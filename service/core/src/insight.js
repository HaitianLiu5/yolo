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
    const photo = picture(person.photo);
    out.push({ name, role, ...(character ? { character } : {}), ...(photo ? { photo } : {}) });
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

// A picture (Agent Note 2026-10-25-metadata-plugins): an http(s) image, or
// a library item's artwork path, which screens load with their credential.
const ARTWORK = /^\/v1\/library\/items\/[^/?#\s]+\/artwork(\?variant=[a-z][a-z0-9-]{0,31})?$/;
function picture(value) {
  const raw = text(value, 2000);
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) || ARTWORK.test(raw) ? raw : null;
}

function show(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  const title = text(value.title, 200);
  if (title) out.title = title;
  const about = description(value.description);
  if (about) out.description = about;
  if (count(value.year) > 1800) out.year = count(value.year);
  const poster = picture(value.poster);
  if (poster) out.poster = poster;
  return out.title ? out : null;
}

function upload(value) {
  if (!value || typeof value !== "object") return null;
  const out = {
    title: text(value.title, 300),
    description: description(value.description),
    channel: text(value.channel, 100),
    date: date(value.date),
    url: url(value.url),
    stats: stats(value.stats),
  };
  const kept = Object.fromEntries(Object.entries(out).filter(([, field]) => field !== null));
  return Object.keys(kept).length ? kept : null;
}

// External ids by the plugins' own names, such as { db: "tv/1234" }.
function ids(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const [key, id] of Object.entries(value)) {
    const named = text(id, 100);
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(key) || !named) continue;
    out[key] = named;
    if (Object.keys(out).length >= 10) break;
  }
  return Object.keys(out).length ? out : null;
}

function candidate(value) {
  if (!value || typeof value !== "object") return null;
  const id = text(value.id, 200);
  const title = text(value.title, 200);
  if (!id || !title) return null;
  const confidence = finite(value.confidence);
  return {
    ...(text(value.plugin, 64) ? { plugin: text(value.plugin, 64) } : {}),
    id,
    kind: text(value.kind, 32) ?? "video",
    title,
    ...(count(value.year) > 1800 ? { year: count(value.year) } : {}),
    ...(count(value.season) !== null ? { season: count(value.season) } : {}),
    ...(count(value.episode) !== null ? { episode: count(value.episode) } : {}),
    ...(text(value.episodeTitle, 200) ? { episodeTitle: text(value.episodeTitle, 200) } : {}),
    confidence: confidence === null ? 0 : Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100,
  };
}

// How the item's details were matched to a work: which plugin and record,
// how sure, whether the owner chose it, and what is left to choose from.
function metadata(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  const plugin = text(value.plugin, 64);
  const id = text(value.id, 200);
  if (plugin) out.plugin = plugin;
  if (id) out.id = id;
  const confidence = finite(value.confidence);
  if (confidence !== null) out.confidence = Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
  if (value.origin === "auto" || value.origin === "owner") out.origin = value.origin;
  if (value.from === "model" || value.from === "records") out.from = value.from;
  if (Array.isArray(value.candidates)) {
    const list = value.candidates.map(candidate).filter(Boolean).slice(0, 8);
    if (list.length) out.candidates = list;
  }
  // Every source whose data the details show, with the notice its terms ask for.
  if (Array.isArray(value.attributions)) {
    const notices = [];
    for (const entry of value.attributions) {
      const notice = text(entry?.text, 300);
      const link = url(entry?.url);
      if (notice && !notices.some((other) => other.text === notice)) notices.push({ text: notice, ...(link ? { url: link } : {}) });
      if (notices.length >= 5) break;
    }
    if (notices.length) out.attributions = notices;
  }
  return Object.keys(out).length ? out : null;
}

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
    poster: picture(source.poster),
    backdrop: picture(source.backdrop),
    still: picture(source.still),
    show: show(source.show),
    upload: upload(source.upload),
    ids: ids(source.ids),
    metadata: metadata(source.metadata),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined));
}

// Kinds whose source describes the work itself, such as a library's film.
export const WORK_KINDS = Object.freeze(["movie", "show", "season", "episode"]);
// What describes the copy the owner plays, never the work: always the source's.
const COPY_FIELDS = Object.freeze(["duration", "url", "stats", "progress"]);
// What a matched upload takes from the work.
const WORK_FIELDS = Object.freeze([
  "description", "date", "year", "people", "genres", "ratings", "contentRating", "series", "studio", "language",
  "poster", "backdrop", "still", "show", "ids",
]);
const PICTURES = Object.freeze(["poster", "backdrop", "still"]);

/** How Yolo titles an episode, as a library source titles one: "Show S1E8 — Title". */
export function workTitle(details) {
  const series = details?.series;
  if ((details?.kind === "episode" || series?.episode != null) && series?.title && series.season != null && series.episode != null) {
    return `${series.title} S${series.season}E${series.episode}${series.episodeTitle ? ` — ${series.episodeTitle}` : ""}`;
  }
  return details?.title ?? null;
}

const has = (value) => value !== null && value !== undefined && !(Array.isArray(value) && !value.length);

// People of the source with the photos metadata has for the same names.
function withPhotos(people, from) {
  if (!Array.isArray(people) || !Array.isArray(from)) return people;
  const photos = new Map(from.filter((person) => person.photo).map((person) => [person.name.toLowerCase(), person.photo]));
  return people.map((person) => (person.photo || !photos.has(person.name.toLowerCase()) ? person : { ...person, photo: photos.get(person.name.toLowerCase()) }));
}

/**
 * The source's details with the metadata of the work an item was matched to
 * (Agent Note 2026-10-25-metadata-plugins, "Merging with the source"), both
 * as normalizeDetails() gives them. `metadata` is { details, from, match }:
 * the work's details as the metadata plugins gave them, merged in load
 * order; "records" when a plugin described the work, "model" when only the
 * model identified it; and how it was matched. A source that describes the
 * work keeps every field it has and gains the rest; an upload takes the
 * work's fields and keeps its own under `upload`; an identity alone changes
 * only the names. The copy's own fields (duration, url, stats, progress) are
 * always the source's.
 */
export function mergeDetails(source, metadata) {
  const own = source && typeof source === "object" ? source : {};
  if (!metadata || typeof metadata !== "object") return own;
  const work = metadata.details && typeof metadata.details === "object" ? metadata.details : {};
  const match = metadata.match ?? null;
  const merged = { ...own };
  if (WORK_KINDS.includes(own.kind)) {
    for (const [key, value] of Object.entries(work)) {
      if (COPY_FIELDS.includes(key) || key === "title" || key === "kind" || !has(value)) continue;
      if (!has(merged[key])) merged[key] = value;
      else if (key === "series") merged.series = { ...value, ...merged.series };
      else if (key === "ids") merged.ids = { ...value, ...merged.ids };
    }
    merged.people = withPhotos(merged.people, work.people);
    if (!has(merged.people)) delete merged.people;
  } else if (work.kind === "episode" || work.kind === "movie") {
    const channel = (own.people ?? []).find((person) => person.role === "channel")?.name;
    const kept = { title: own.title, description: own.description, channel, date: own.date, url: own.url, stats: own.stats };
    const copy = Object.fromEntries(Object.entries(kept).filter(([, value]) => has(value)));
    if (metadata.from === "model") {
      merged.kind = work.kind;
      if (work.series) merged.series = work.series;
      merged.title = workTitle(work) ?? own.title;
      if (Object.keys(copy).length) merged.upload = { title: own.title };
    } else {
      for (const key of [...WORK_FIELDS, ...PICTURES]) {
        if (has(work[key])) merged[key] = work[key];
        else if (key !== "people") delete merged[key];
      }
      if (!has(work.people)) delete merged.people;
      if (!has(work.description)) delete merged.description;
      merged.kind = work.kind;
      merged.title = workTitle(work) ?? own.title;
      if (Object.keys(copy).length) merged.upload = copy;
      delete merged.tags;
    }
  }
  if (match) merged.metadata = match;
  return normalizeDetails(merged);
}
