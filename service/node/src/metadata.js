import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { mergeDetails, normalizeDetails, parseReleaseTitle, sourceKey, WORK_KINDS, workTitle, YoloError } from "@useyolo/core";

// The node's metadata (Agent Note 2026-10-25-metadata-plugins). Metadata
// plugins say what an item is and describe that work; this module asks them.
// It identifies an item a model first: with `yolo.models` available, the
// model reads the item and says which work it is, once per item or per run of
// parts, and the plugins confirm that against their records. Without a model,
// the title parser's hints take its place. A match applies only when the
// model and a plugin's record agree; the item's details are then the source's
// merged with the work's (mergeDetails in the core). Identification never
// stands between a play and its first frame: describe() merges only what the
// caches hold and queues the rest in the background, one item at a time.

const METADATA_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const METADATA_METHODS = Object.freeze(["identify", "lookup", "search", "image", "health"]);
// A picture only the node can read: "local:<ref>" in a plugin's answer
// becomes the item's artwork variant m-<plugin>-<ref>.
const LOCAL_PICTURE = /^local:([a-z0-9][a-z0-9-]*)$/;
const VARIANT = /^m-([a-z][a-z0-9-]*)$/;
const PICTURE_FIELDS = Object.freeze(["poster", "backdrop", "still"]);

// When a match applies (step 5): the model sure enough, the plugin's record
// sure enough, and clear of the next record.
export const MODEL_CONFIDENCE = 0.8;
export const RECORD_CONFIDENCE = 0.85;
export const MARGIN = 0.15;

const DAY = 86_400_000;
const MATCHED_MS = 30 * DAY;
const UNMATCHED_MS = 3 * DAY;
const LOOKUP_MS = 7 * DAY;
// /details waits this long, inside the control plane's 20 seconds, then
// answers with the source's details while identification goes on.
const DETAILS_WAIT_MS = 17_000;
const MAX_QUEUE = 200;
const MAX_PARTS = 30;
const DESCRIPTION_CHARS = 500;

export function checkMetadataImpl(id, impl) {
  if (!METADATA_ID.test(String(id))) {
    throw new TypeError(`Metadata id "${id}" must be lowercase letters, digits and dashes, starting with a letter`);
  }
  if (!impl || typeof impl !== "object") throw new TypeError(`Metadata ${id} must be an object of methods`);
  for (const method of METADATA_METHODS) {
    if (impl[method] !== undefined && typeof impl[method] !== "function") throw new TypeError(`Metadata ${id}: ${method} must be a function`);
  }
  return Object.keys(impl).filter((key) => !METADATA_METHODS.includes(key));
}

export function createMetadataRegistry() {
  const entries = new Map(); // id → { id, plugin, impl }, in registration order
  return {
    add(id, impl, plugin) {
      if (entries.has(id)) throw new Error(`Metadata id "${id}" is already registered`);
      entries.set(id, { id, plugin, impl });
    },
    remove(id) {
      entries.delete(id);
    },

    // In the plugins' config order, each plugin's in registration order.
    reorder(rank) {
      const sorted = [...entries.values()].sort((left, right) => rank(left.plugin) - rank(right.plugin));
      entries.clear();
      for (const entry of sorted) entries.set(entry.id, entry);
    },
    has: (id) => entries.has(id),
    ids: () => [...entries.keys()],
    get: (id) => entries.get(id) ?? null,
    list: () => [...entries.values()],
  };
}

// The answer the model gives (Agent Note 2026-10-25-metadata-plugins,
// "Matching an item"), as a strict schema: every property required.
const nullable = (type) => ({ type: [type, "null"] });
export const IDENTITY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["kind", "showTitle", "originalTitle", "year", "title", "season", "episode", "episodeTitle", "confidence", "reason", "parts"],
  properties: {
    kind: { type: "string", enum: ["episode", "movie", "show", "other"] },
    showTitle: nullable("string"),
    originalTitle: nullable("string"),
    year: nullable("integer"),
    title: nullable("string"),
    season: nullable("integer"),
    episode: nullable("integer"),
    episodeTitle: nullable("string"),
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
    parts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "season", "episode", "episodeTitle"],
        properties: { index: { type: "integer" }, season: nullable("integer"), episode: nullable("integer"), episodeTitle: nullable("string") },
      },
    },
  },
});

const IDENTIFY_SYSTEM = [
  "You identify which film or TV episode a video is a copy of, from what its site or file says about it, the way a person reading it would.",
  "kind is \"episode\" for an episode of a show, \"movie\" for a film, \"show\" for a whole show, and \"other\" for anything that is not a full copy of one work: a clip, a trailer, a compilation, a reaction, a review, a vlog.",
  "showTitle is the show's title as it is best known in English, originalTitle its title in its original language; for a film, title and originalTitle. season and episode are numbers, and episodeTitle the episode's own title only when you are sure of it.",
  "hints is what a title parser read; it may be wrong. When parts lists the other parts of the same upload, give each part's season, episode, and episodeTitle by its index, in the same order; otherwise parts is [].",
  "confidence is how sure you are of the work and the episode, from 0 to 1; below 0.8 when unsure. reason is one short sentence.",
].join("\n");

// Title hints a record can confirm without the model: a name with a season
// and an episode, or a name with a year for a film.
export function readsClearly(hints) {
  if (!hints?.titles?.length) return false;
  if (hints.season != null && hints.episode != null) return true;
  return hints.kind !== "episode" && hints.year != null;
}

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const message = (error) => error?.message || String(error);
const finite = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null);

// One cache of JSON values on disk under `dir`, with lifetimes; the node may
// delete it at any time and it is rebuilt on the next request.
function createCache(dir, now) {
  const memory = new Map();
  const path = (name, key) => join(dir, name, `${hash(key)}.json`);
  return {
    get(name, key) {
      const id = `${name}\n${key}`;
      let entry = memory.get(id);
      if (!entry && dir) {
        try {
          entry = JSON.parse(readFileSync(path(name, key), "utf8"));
          memory.set(id, entry);
        } catch {
          entry = null;
        }
      }
      if (!entry || entry.expires <= now()) return null;
      return entry.value;
    },
    set(name, key, value, ttl) {
      const entry = { expires: now() + ttl, value };
      memory.set(`${name}\n${key}`, entry);
      if (memory.size > 5000) memory.delete(memory.keys().next().value);
      if (!dir) return;
      try {
        const file = path(name, key);
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify(entry));
        renameSync(`${file}.tmp`, file);
      } catch {}
    },
  };
}

// A plugin's Candidate, checked, with the plugin's id.
function candidate(plugin, value) {
  if (!value || typeof value !== "object" || value.id == null || !value.title) return null;
  const confidence = Math.min(1, Math.max(0, finite(value.confidence) ?? 0));
  const ids = value.ids && typeof value.ids === "object" ? Object.fromEntries(Object.entries(value.ids).filter(([key, id]) => METADATA_ID.test(key) && typeof id === "string").slice(0, 10)) : {};
  return {
    plugin,
    id: String(value.id).slice(0, 200),
    kind: typeof value.kind === "string" ? value.kind : "video",
    title: String(value.title).slice(0, 200),
    ...(finite(value.year) ? { year: finite(value.year) } : {}),
    ...(finite(value.season) !== null ? { season: finite(value.season) } : {}),
    ...(finite(value.episode) !== null ? { episode: finite(value.episode) } : {}),
    ...(typeof value.episodeTitle === "string" ? { episodeTitle: value.episodeTitle.slice(0, 200) } : {}),
    confidence,
    ...(Object.keys(ids).length ? { ids } : {}),
  };
}

// The model's answer in the note's shape, or null when it is unusable.
function identityFrom(answer) {
  if (!answer || typeof answer !== "object") return null;
  const show = answer.kind === "episode" || answer.kind === "show"
    ? { title: answer.showTitle ?? answer.title ?? null, originalTitle: answer.originalTitle ?? null, year: answer.year ?? null }
    : null;
  return {
    kind: answer.kind,
    ...(show?.title ? { show } : {}),
    title: answer.kind === "movie" ? answer.title ?? answer.originalTitle : answer.title ?? null,
    ...(answer.kind === "movie" ? { originalTitle: answer.originalTitle ?? null, year: answer.year ?? null } : {}),
    season: answer.season ?? null,
    episode: answer.episode ?? null,
    episodeTitle: answer.episodeTitle ?? null,
    confidence: Math.min(1, Math.max(0, Number(answer.confidence) || 0)),
    reason: typeof answer.reason === "string" ? answer.reason.slice(0, 300) : "",
  };
}

// The work's details from the plugins that matched, earliest first: for each
// field, the earliest plugin that has it wins; a later plugin still gives the
// photos of people the earlier one named without one.
function byLoadOrder(list) {
  const out = {};
  for (const details of list) {
    for (const [key, value] of Object.entries(details)) {
      if (out[key] === undefined) out[key] = value;
      else if (key === "series" || key === "ids" || key === "show") out[key] = { ...value, ...out[key] };
      else if (key === "people") {
        const photos = new Map(value.filter((person) => person.photo).map((person) => [person.name.toLowerCase(), person.photo]));
        out.people = out.people.map((person) => (person.photo || !photos.has(person.name.toLowerCase()) ? person : { ...person, photo: photos.get(person.name.toLowerCase()) }));
      }
    }
  }
  return out;
}

const artworkUrl = (itemId, variant) => `/v1/library/items/${encodeURIComponent(itemId)}/artwork?variant=${encodeURIComponent(variant)}`;

/**
 * `registry` is the metadata registry; `sources` the source registry;
 * `models` the node's model client for metadata (a ModelClient), or null.
 */
export function createMetadata({
  registry, sources, models = null, cacheDir = null, logger = console, language = "en", now = Date.now,
}) {
  const cache = createCache(cacheDir, now);
  const running = new Map(); // source key → Promise of an identification
  const queue = [];
  let draining = false;

  // A plugin's Metadata in Yolo's details shape, its local pictures as the
  // item's artwork variants.
  function present(plugin, itemKey, raw) {
    if (!raw || typeof raw !== "object") return { details: {}, attribution: null };
    const local = (value) => {
      const match = typeof value === "string" ? LOCAL_PICTURE.exec(value) : null;
      if (!match) return value;
      const variant = `m-${plugin}-${match[1]}`;
      return variant.length <= 32 ? artworkUrl(itemKey, variant) : null;
    };
    const copy = { ...raw };
    for (const field of PICTURE_FIELDS) if (copy[field] !== undefined) copy[field] = local(copy[field]);
    if (copy.show && typeof copy.show === "object") copy.show = { ...copy.show, poster: local(copy.show.poster) };
    if (Array.isArray(copy.people)) copy.people = copy.people.map((person) => (person && typeof person === "object" ? { ...person, photo: local(person.photo) } : person));
    const attribution = raw.attribution && typeof raw.attribution === "object" ? raw.attribution : null;
    return { details: normalizeDetails(copy), attribution };
  }

  async function lookup(plugin, found, itemKey) {
    const entry = registry.get(plugin);
    if (!entry?.impl.lookup) return { details: {}, attribution: null };
    const key = `${plugin}\n${found.id}\n${found.season ?? ""}\n${found.episode ?? ""}\n${language}`;
    let raw = cache.get("lookup", key);
    if (!raw) {
      raw = (await entry.impl.lookup(found, { language })) ?? {};
      cache.set("lookup", key, raw, LOOKUP_MS);
    }
    return present(plugin, itemKey, raw);
  }

  // What the node knows about an item before any metadata plugin speaks.
  async function subjectOf(source, own) {
    const title = own.upload?.title ?? own.title ?? null;
    let file = null;
    try {
      file = await sources.file(source);
    } catch {}
    return {
      sourceKey: sourceKey(source),
      kind: own.kind ?? null,
      title,
      duration: own.duration ?? null,
      date: own.date ?? null,
      year: own.year ?? null,
      description: own.description ?? null,
      channel: (own.people ?? []).find((person) => person.role === "channel")?.name ?? null,
      series: own.series ?? null,
      url: own.url ?? null,
      ids: { ...(own.ids ?? {}) },
      file,
      hints: parseReleaseTitle(title ?? (file ? basename(file.path) : "")),
      identity: null,
    };
  }

  const subjectHash = (subject) => hash([subject.title, subject.duration, subject.description?.slice(0, DESCRIPTION_CHARS), subject.ids, subject.file?.path ?? null]);

  // The model's identity of an item, asked once per item or once for the
  // run of parts it belongs to.
  async function identifyWithModel(source, subject) {
    const key = subject.sourceKey;
    const cached = cache.get("identity", key);
    if (cached) return cached;
    if (!models || !(await models.available())) return null;
    let parts = [];
    try {
      const run = await sources.sequence(source);
      if (run?.items?.length > 1) parts = run.items.slice(0, MAX_PARTS).map((item, index) => ({ index, key: sourceKey(item.source), title: item.title ?? null }));
    } catch {}
    const facts = {
      title: subject.title,
      description: subject.description?.slice(0, DESCRIPTION_CHARS) ?? null,
      uploader: subject.channel,
      site: subject.url ? new URL(subject.url).hostname : null,
      duration: subject.duration,
      date: subject.date,
      file: subject.file ? basename(subject.file.path) : null,
      hints: subject.hints,
      parts: parts.map(({ index, title }) => ({ index, title })),
    };
    const answer = await models.complete({
      purpose: "identify",
      system: IDENTIFY_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(facts) }],
      schema: IDENTITY_SCHEMA,
      maxTokens: 400 + 40 * parts.length,
    });
    const identity = identityFrom(answer.json);
    if (!identity) return null;
    // The run's other parts share the show; each keeps its own episode.
    for (const part of answer.json.parts ?? []) {
      const other = parts[part.index];
      if (!other || other.key === key) continue;
      cache.set("identity", other.key, { ...identity, season: part.season, episode: part.episode, episodeTitle: part.episodeTitle }, MATCHED_MS);
    }
    const own = parts.find((part) => part.key === key);
    const mine = own ? (answer.json.parts ?? []).find((part) => part.index === own.index) : null;
    const result = mine ? { ...identity, season: mine.season ?? identity.season, episode: mine.episode ?? identity.episode, episodeTitle: mine.episodeTitle ?? identity.episodeTitle } : identity;
    cache.set("identity", key, result, MATCHED_MS);
    return result;
  }

  // Step 4 and 5 of "Matching an item": each plugin in load order confirms
  // what the subject says, and a match that applies passes its ids on.
  async function confirm(subject) {
    const applied = [];
    const candidates = [];
    const modelAgrees = !subject.identity || subject.identity.confidence >= MODEL_CONFIDENCE;
    for (const { id, impl } of registry.list()) {
      if (!impl.identify) continue;
      let found = [];
      try {
        found = ((await impl.identify(structuredClone(subject), { language })) ?? []).map((value) => candidate(id, value)).filter(Boolean);
      } catch (error) {
        logger.warn?.(`[metadata] ${id} could not identify ${subject.sourceKey}: ${message(error)}`);
        continue;
      }
      found.sort((a, b) => b.confidence - a.confidence);
      const [best, next] = found;
      if (!best) continue;
      const byId = best.confidence >= 1;
      const clear = !next || best.confidence - next.confidence >= MARGIN;
      if (byId || (modelAgrees && best.confidence >= RECORD_CONFIDENCE && clear)) {
        applied.push(best);
        subject.ids = { ...subject.ids, ...(best.ids ?? {}) };
      } else {
        candidates.push(...found);
      }
    }
    return { applied, candidates: applied.length ? [] : candidates.slice(0, 8) };
  }

  // Steps 2 to 7 of "Matching an item": what the item is, as a cache entry.
  // A file whose name reads clearly, as a library's files mostly do, tries
  // the title hints first and asks the model only when no record confirms
  // them, so a library of a thousand files costs few model calls.
  async function identify(source, own) {
    const subject = await subjectOf(source, own);
    const entry = { hash: subjectHash(subject), identity: null, applied: [], candidates: [] };
    const known = Object.keys(subject.ids).length > 0;
    if (!known && subject.file && readsClearly(subject.hints)) {
      const byHints = await confirm(structuredClone(subject));
      if (byHints.applied.length) return { ...entry, ...byHints };
    }
    if (!known) {
      try {
        subject.identity = await identifyWithModel(source, subject);
      } catch (error) {
        logger.warn?.(`[metadata] ${subject.sourceKey}: the model could not identify it: ${message(error)}`);
      }
      entry.identity = subject.identity;
      if (subject.identity?.kind === "other" && subject.identity.confidence >= MODEL_CONFIDENCE) return entry;
    }
    return { ...entry, ...(await confirm(subject)) };
  }

  // An item's metadata from its cache entry: { details, from, match } or null.
  async function build(entry, itemKey, { cachedOnly = false } = {}) {
    if (!entry) return null;
    if (entry.applied.length) {
      const looked = [];
      for (const found of entry.applied) {
        if (cachedOnly) {
          const raw = cache.get("lookup", `${found.plugin}\n${found.id}\n${found.season ?? ""}\n${found.episode ?? ""}\n${language}`);
          if (!raw) return null;
          looked.push(present(found.plugin, itemKey, raw));
        } else {
          // One database that fails or is slow costs only its own fields.
          try {
            looked.push(await lookup(found.plugin, found, itemKey));
          } catch (error) {
            logger.warn?.(`[metadata] ${found.plugin} could not describe ${itemKey}: ${message(error)}`);
          }
        }
      }
      if (!looked.length) return null;
      const [first] = entry.applied;
      const attributions = looked.map((one) => one.attribution).filter(Boolean);
      return {
        details: byLoadOrder(looked.map((one) => one.details)),
        from: "records",
        match: { plugin: first.plugin, id: first.id, confidence: first.confidence, origin: entry.origin ?? "auto", from: "records", ...(attributions.length ? { attributions } : {}) },
      };
    }
    const identity = entry.identity;
    if (!entry.candidates.length && identity && identity.confidence >= MODEL_CONFIDENCE && (identity.kind === "episode" || identity.kind === "movie")) {
      const details = identity.kind === "episode"
        ? { kind: "episode", series: { title: identity.show?.title, season: identity.season, episode: identity.episode, episodeTitle: identity.episodeTitle } }
        : { kind: "movie", title: identity.title, ...(identity.year ? { year: identity.year } : {}) };
      return { details: normalizeDetails(details), from: "model", match: { confidence: identity.confidence, origin: "auto", from: "model" } };
    }
    if (entry.candidates.length) return { details: {}, from: null, match: { origin: "auto", candidates: entry.candidates } };
    return null;
  }

  // The cache entry of an item, identifying it once at a time per item.
  function resolve(source, own) {
    const key = sourceKey(source);
    if (running.has(key)) return running.get(key);
    const work = (async () => {
      const subject = await subjectOf(source, own);
      const cached = cache.get("match", key);
      if (cached && cached.hash === subjectHash(subject)) return cached;
      const entry = await identify(source, own);
      const matched = entry.applied.length > 0 || (entry.identity && entry.identity.kind !== "other" && entry.identity.confidence >= MODEL_CONFIDENCE);
      cache.set("match", key, entry, matched ? MATCHED_MS : UNMATCHED_MS);
      return entry;
    })().finally(() => running.delete(key));
    running.set(key, work);
    return work;
  }

  // The owner's pinned match, or refusal, as the control plane passes it.
  async function pinned(source, choice) {
    const key = sourceKey(source);
    if (choice.none) return { details: {}, from: null, match: { origin: "owner" } };
    const found = candidate(choice.plugin, choice.candidate);
    if (!found || !registry.has(found.plugin)) return null;
    const { details, attribution } = await lookup(found.plugin, found, key);
    return { details, from: "records", match: { plugin: found.plugin, id: found.id, confidence: 1, origin: "owner", from: "records", ...(attribution ? { attributions: [attribution] } : {}) } };
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const { source, own } = queue.shift();
        try {
          const entry = await resolve(source, typeof own === "function" ? await own() : own);
          await build(entry, sourceKey(source));
        } catch (error) {
          logger.warn?.(`[metadata] ${sourceKey(source)}: ${message(error)}`);
        }
      }
    } finally {
      draining = false;
    }
  }

  function enqueue(source, own) {
    const key = sourceKey(source);
    if (running.has(key) || queue.some((item) => sourceKey(item.source) === key) || queue.length >= MAX_QUEUE) return;
    queue.push({ source, own });
    setTimeout(drain, 0).unref?.();
  }

  const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve(timeout.expired), ms).unref?.());
  timeout.expired = Symbol("expired");

  return {
    available: () => registry.list().length > 0,

    /**
     * An item's details, its source's merged with the work it was matched
     * to. `match` is the owner's choice for the item: { plugin, candidate }
     * or { none: true }. Waits for an identification up to 17 seconds.
     */
    async details(source, own, { match = null, waitMs = DETAILS_WAIT_MS } = {}) {
      if (!registry.list().length) return own;
      let metadata = null;
      try {
        if (match) metadata = await pinned(source, match);
        else {
          const work = resolve(source, own).then((entry) => build(entry, sourceKey(source)));
          const result = await Promise.race([work, timeout(waitMs)]);
          if (result === timeout.expired) work.catch(() => {});
          else metadata = result;
        }
      } catch (error) {
        logger.warn?.(`[metadata] ${sourceKey(source)}: ${message(error)}`);
      }
      const merged = metadata ? mergeDetails(own, metadata) : own;
      return own.partial ? { ...merged, partial: true } : merged;
    },

    /**
     * What a play shows: the described title, with the work's display title,
     * series, and poster when the caches already hold a match. Otherwise the
     * item's identification is queued.
     */
    async describe(source, described, ownDetails) {
      if (!registry.list().length) return described;
      const key = sourceKey(source);
      const entry = cache.get("match", key);
      if (!entry) {
        enqueue(source, ownDetails);
        return described;
      }
      const metadata = await build(entry, key, { cachedOnly: true });
      if (!metadata || metadata.from === null) return described;
      const details = metadata.details;
      const title = workTitle(details);
      return {
        ...described,
        ...(title ? { title } : {}),
        ...(details.series ? { series: { title: details.series.title, season: details.series.season, episode: details.series.episode } } : {}),
        ...(details.poster || details.show?.poster ? { poster: details.poster ?? details.show.poster } : {}),
      };
    },

    /**
     * Library items as a listing shows them: an item whose source does not
     * know the work, such as a file in a folder, takes the work's display
     * title, kind, series, poster, and picture when the caches hold a match;
     * the work's picture replaces the source's own, such as a frame of the
     * file, which an unmatched item keeps. The rest are queued, one at a
     * time, never waited for. Items whose source knows the work are left as
     * they are.
     */
    async listing(items, sourceOf) {
      if (!registry.list().length || !Array.isArray(items)) return items;
      return Promise.all(items.map(async (item) => {
        if (!item?.id || WORK_KINDS.includes(item.kind)) return item;
        let source;
        try {
          source = sourceOf(item.id);
        } catch {
          return item;
        }
        const key = sourceKey(source);
        const entry = cache.get("match", key);
        if (!entry) {
          enqueue(source, () => sources.details(source));
          return item;
        }
        const metadata = await build(entry, key, { cachedOnly: true }).catch(() => null);
        if (!metadata?.from) return item;
        const details = metadata.details;
        const picture = details.still ?? details.backdrop ?? details.poster ?? details.show?.poster ?? null;
        return {
          ...item,
          title: workTitle(details) ?? item.title,
          ...(details.kind ? { kind: details.kind } : {}),
          ...(details.series ? { series: { title: details.series.title, season: details.series.season, episode: details.series.episode } } : {}),
          ...(details.poster || details.show?.poster ? { poster: details.poster ?? details.show.poster } : {}),
          ...(picture ? { thumbnail: picture } : {}),
        };
      }));
    },

    /** Works by name across the plugins, for an agent correcting a match. */
    async search({ query, kind = null, year = null, limit = 10 }) {
      const text = String(query ?? "").trim();
      if (!text) throw new YoloError("invalid_request", "query is required");
      const max = Math.min(Math.max(Number(limit) || 10, 1), 25);
      const results = [];
      for (const { id, impl } of registry.list()) {
        if (!impl.search) continue;
        try {
          const found = (await impl.search(text, { kind, year: finite(year), language, limit: max })) ?? [];
          results.push(...found.map((value) => candidate(id, value)).filter(Boolean));
        } catch (error) {
          logger.warn?.(`[metadata] ${id} could not search: ${message(error)}`);
        }
      }
      return { results: results.slice(0, max) };
    },

    /** A picture only a metadata plugin can read: variant m-<plugin>-<ref>. */
    isVariant: (variant) => VARIANT.test(String(variant ?? "")),
    async image(source, variant) {
      const match = VARIANT.exec(String(variant ?? ""));
      const entry = match ? registry.list().find(({ id }) => match[1].startsWith(`${id}-`)) : null;
      if (!entry?.impl.image) throw new YoloError("not_found", "No such picture");
      let file = null;
      try {
        file = await sources.file(source);
      } catch {}
      const response = await entry.impl.image(match[1].slice(entry.id.length + 1), { file });
      if (!(response instanceof Response) || !response.ok) throw new YoloError("not_found", "No such picture");
      return response;
    },

    async status() {
      const plugins = [];
      for (const { id, plugin, impl } of registry.list()) {
        let health = null;
        try {
          health = impl.health ? await impl.health() : null;
        } catch (error) {
          health = { error: message(error) };
        }
        plugins.push({ id, plugin, ...(health ? { health } : {}) });
      }
      return { plugins, queued: queue.length, model: Boolean(models) };
    },
  };
}
