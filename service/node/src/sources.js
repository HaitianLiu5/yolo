import { isAbsolute } from "node:path";
import { isHttpUrl, normalizeChapters, normalizeComments, normalizeDetails, normalizeSource, sourceKey, toYoloError, YoloError } from "@useyolo/core";

// The node's source registry (Agent Note 2026-10-11-source-plugin-api). Source
// plugins register implementations here; the internal API asks the registry,
// never a source directly. The registry owns everything that must look the same
// whichever plugin answers:
// - URLs go to sources in registration order; the first that claims one wins.
// - Library ids are `<source id>:<local id>`, so routes reach the right source
//   and the control plane never sees provider names.
// - Artwork variants become control plane URLs.

const SOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const LIBRARY_ID = /^([a-z][a-z0-9-]{0,31}):(.+)$/s;
export const SOURCE_METHODS = Object.freeze([
  "health", "claim", "expand", "describe", "tracks", "libraries", "items", "children", "search", "artwork", "prepare",
  "subtitle", "chapters", "details", "storyboard", "comments", "warm", "sequence", "file",
]);

// How many items of a run the registry passes on after the one asked about:
// enough to go on through a season or a long multi-part video.
const SEQUENCE_AHEAD = 50;
// An item's place in its run ("S1 · E3", "P3") is a short label.
const SEQUENCE_LABEL_MAX = 24;

const artworkUrl = (itemId, variant) => (
  `/v1/library/items/${encodeURIComponent(itemId)}/artwork?variant=${encodeURIComponent(variant)}`
);

function thumbnailOf(itemId, value) {
  if (typeof value.artwork === "string" && value.artwork) return artworkUrl(itemId, value.artwork);
  return typeof value.thumbnail === "string" && value.thumbnail ? value.thumbnail : null;
}

// The library items an item belongs to, outermost first (an episode's
// show, then its season), as source keys: at most two, or none.
function parentsOf(sourceId, value) {
  if (!Array.isArray(value.parents)) return [];
  return value.parents.filter((id) => typeof id === "string" && id).slice(0, 2).map((id) => `${sourceId}:${id}`);
}

function presentItem(sourceId, item) {
  if (!item || typeof item !== "object" || item.id == null || item.id === "") {
    throw new YoloError("internal", `Source ${sourceId} returned a library item without an id`);
  }
  const { artwork: _artwork, parents: _parents, ...fields } = item;
  const id = `${sourceId}:${item.id}`;
  const parents = parentsOf(sourceId, item);
  return { ...fields, id, thumbnail: thumbnailOf(id, item), ...(parents.length ? { parents } : {}) };
}

const presentLibrary = (sourceId, library) => ({ ...library, id: `${sourceId}:${library.id}`, source: sourceId });

function toSource(sourceId, input) {
  if (!input || typeof input !== "object") throw new YoloError("internal", `Source ${sourceId} returned an invalid source`);
  return normalizeSource({ ...input, plugin: sourceId });
}

export function checkSourceImpl(id, impl) {
  if (!SOURCE_ID.test(String(id))) {
    throw new TypeError(`Source id "${id}" must be lowercase letters, digits and dashes, starting with a letter`);
  }
  if (!impl || typeof impl !== "object") throw new TypeError(`Source ${id} must be an object of methods`);
  for (const method of SOURCE_METHODS) {
    if (impl[method] !== undefined && typeof impl[method] !== "function") throw new TypeError(`Source ${id}: ${method} must be a function`);
  }
  return Object.keys(impl).filter((key) => !SOURCE_METHODS.includes(key));
}

export function createSourceRegistry() {
  const sources = new Map(); // id → { id, plugin, impl }, in registration order

  function forId(id) {
    const entry = sources.get(id);
    if (!entry) throw new YoloError("not_found", `No source plugin "${id}" is loaded on this media node`);
    return entry;
  }

  const forSource = (source) => forId(normalizeSource(source).plugin);

  function method(entry, name) {
    const fn = entry.impl[name];
    if (!fn) throw new YoloError("not_found", `Source ${entry.id} does not support ${name}`);
    return fn.bind(entry.impl);
  }

  function parseLibraryId(value) {
    const match = LIBRARY_ID.exec(String(value ?? ""));
    if (!match) throw new YoloError("invalid_request", `Not a library id: ${value}`);
    return { entry: forId(match[1]), localId: match[2] };
  }

  // Ask every source that implements `name`; fail only if all of them fail.
  async function fanOut(name, call) {
    const providers = [...sources.values()].filter((entry) => entry.impl[name]);
    if (!providers.length) throw new YoloError("not_found", "No library source is enabled on this media node");
    const settled = await Promise.allSettled(providers.map((entry) => call(entry, method(entry, name))));
    if (settled.every((result) => result.status === "rejected")) throw toYoloError(settled[0].reason);
    const values = [];
    const unavailable = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") values.push(...result.value);
      else unavailable.push({ source: providers[index].id, error: toYoloError(result.reason).message });
    });
    return { values, unavailable };
  }

  return {
    has: (id) => sources.has(id),
    ids: () => [...sources.keys()],

    // Called by the plugin loader once a plugin's factory has succeeded.
    add(id, impl, plugin) {
      checkSourceImpl(id, impl);
      if (sources.has(id)) throw new TypeError(`Source id "${id}" is already registered by ${sources.get(id).plugin}`);
      sources.set(id, { id, plugin, impl });
    },

    remove(id) {
      sources.delete(id);
    },

    // In the plugins' config order, each plugin's in registration order.
    reorder(rank) {
      const sorted = [...sources.values()].sort((left, right) => rank(left.plugin) - rank(right.plugin));
      sources.clear();
      for (const entry of sorted) sources.set(entry.id, entry);
    },

    // Throws not_found unless the source's plugin is loaded.
    require(source) {
      forSource(source);
      return normalizeSource(source);
    },

    async health() {
      return Promise.all([...sources.values()].map(async (entry) => {
        try {
          const status = entry.impl.health ? await entry.impl.health() : {};
          return { id: entry.id, plugin: entry.plugin, ...(status && typeof status === "object" ? status : {}) };
        } catch (error) {
          return { id: entry.id, plugin: entry.plugin, online: false, error: toYoloError(error).message };
        }
      }));
    },

    async claim(url) {
      if (!isHttpUrl(url)) throw new YoloError("invalid_request", "A valid http(s) URL is required");
      for (const entry of sources.values()) {
        if (!entry.impl.claim) continue;
        const claimed = await entry.impl.claim(url.trim());
        if (claimed != null) return toSource(entry.id, claimed);
      }
      throw new YoloError("not_found", "No source plugin on the media node handles this URL");
    },

    async expand(url) {
      if (!isHttpUrl(url)) throw new YoloError("invalid_request", "url must be an http(s) playlist URL");
      const target = url.trim();
      for (const entry of sources.values()) {
        if (!entry.impl.expand) continue;
        const collection = await entry.impl.expand(target);
        if (collection == null) continue;
        const items = (Array.isArray(collection.items) ? collection.items : []).map((item) => {
          const source = toSource(entry.id, item.source);
          return {
            source,
            title: item.title ?? null,
            thumbnail: thumbnailOf(sourceKey(source), item),
            duration: item.duration ?? null,
          };
        });
        return { title: collection.title ?? null, url: target, items };
      }
      throw new YoloError("not_found", "No source plugin on the media node can expand this playlist URL");
    },

    // The run an item belongs to (a show's episodes, a multi-part video's
    // parts, a playlist), from the item itself on, in order; null when it
    // belongs to none or its source cannot say (Agent Note 2026-10-23-up-next).
    async sequence(source) {
      const entry = forSource(source);
      if (!entry.impl.sequence) return null;
      const result = await entry.impl.sequence(normalizeSource(source));
      if (!result || !Array.isArray(result.items)) return null;
      const index = Number(result.index);
      if (!Number.isInteger(index) || index < 0 || index >= result.items.length) return null;
      const items = result.items.slice(index, index + 1 + SEQUENCE_AHEAD).map((item) => {
        const itemSource = toSource(entry.id, item.source);
        const label = typeof item.label === "string" ? item.label.trim().slice(0, SEQUENCE_LABEL_MAX) : "";
        return {
          source: itemSource,
          title: item.title ?? null,
          ...(label ? { label } : {}),
          thumbnail: thumbnailOf(sourceKey(itemSource), item),
          duration: item.duration ?? null,
        };
      });
      return { title: result.title ?? null, items };
    },

    async describe(source) {
      const entry = forSource(source);
      const result = (await method(entry, "describe")(normalizeSource(source))) ?? {};
      return {
        title: result.title ?? null,
        thumbnail: thumbnailOf(sourceKey(source), result),
        duration: result.duration ?? null,
        isLive: Boolean(result.isLive),
        // Where the source itself would resume (its own watch position), in seconds.
        resumeAt: Number(result.resumeAt) > 0 ? Number(result.resumeAt) : null,
      };
    },

    // A stream descriptor for the media pipeline
    // (Agent Note 2026-10-11-node-media-pipeline, "Playing"). The pipeline
    // validates its Input.
    async prepare(source, context) {
      const entry = forSource(source);
      if (!entry.impl.prepare) throw new YoloError("resolve_failed", `Source ${entry.id} cannot play its items on this node`);
      const result = await entry.impl.prepare(normalizeSource(source), context);
      if (!result || typeof result !== "object" || !result.input) {
        throw new YoloError("resolve_failed", `Source ${entry.id} returned no stream to play`);
      }
      const key = sourceKey(source);
      return {
        ...result,
        parents: parentsOf(entry.id, result),
        title: result.title ?? null,
        thumbnail: thumbnailOf(key, result),
        duration: Number(result.duration) > 0 ? Number(result.duration) : null,
        isLive: Boolean(result.isLive),
      };
    },

    // Whether `source`'s plugin resolves ahead, and resolving ahead for a
    // device that may play it soon (Agent Note 2026-10-11-source-plugin-api,
    // "warm"); the context is prepare()'s, without a session.
    canWarm(source) {
      try {
        return Boolean(forSource(source).impl.warm);
      } catch {
        return false;
      }
    },
    async warm(source, context) {
      const entry = forSource(source);
      if (entry.impl.warm) await entry.impl.warm(normalizeSource(source), context);
    },

    async tracks(source) {
      const entry = forSource(source);
      if (!entry.impl.tracks) return { subtitles: [], audio: [] };
      const result = (await entry.impl.tracks(normalizeSource(source))) ?? {};
      return { subtitles: result.subtitles ?? [], audio: result.audio ?? [] };
    },

    // The optional capabilities agents read an item with
    // (Agent Note 2026-10-07-remote-mcp-server). Each has a fallback when a
    // source does not implement it.

    // WebVTT text of a text subtitle track outside a playing session, or
    // { pending, retryAfter } while the source prepares it.
    async subtitle(source, trackId) {
      const entry = forSource(source);
      if (!entry.impl.subtitle) throw new YoloError("not_found", `Source ${entry.id} offers subtitle text only while its item plays`);
      return entry.impl.subtitle(normalizeSource(source), String(trackId));
    },

    // Chapters and intro and credits markers; none when the source has no
    // chapters() (`supported: false`).
    async chapters(source) {
      const entry = forSource(source);
      if (!entry.impl.chapters) return { chapters: [], supported: false };
      const result = await entry.impl.chapters(normalizeSource(source));
      const list = Array.isArray(result) ? result : result?.chapters;
      return { chapters: normalizeChapters(list, { duration: result?.duration ?? null }), supported: true };
    },

    // Details in Yolo's one shape; a source without details() gives what
    // describe() knows (`partial: true`).
    async details(source) {
      const entry = forSource(source);
      const normalized = normalizeSource(source);
      if (entry.impl.details) return normalizeDetails(await entry.impl.details(normalized));
      if (!entry.impl.describe) return { partial: true };
      const described = (await entry.impl.describe(normalized)) ?? {};
      return { ...normalizeDetails(null, described), partial: true };
    },

    // The file the node can read for an item, { path, size }, or null: what
    // metadata plugins read beside it (Agent Note 2026-10-25-metadata-plugins).
    // It never leaves the node.
    async file(source) {
      const entry = forSource(source);
      if (!entry.impl.file) return null;
      const result = await entry.impl.file(normalizeSource(source));
      if (!result || typeof result.path !== "string" || !isAbsolute(result.path)) return null;
      return { path: result.path, size: Number(result.size) > 0 ? Number(result.size) : null };
    },

    // The source's own storyboard images, or null when it has none; then
    // the node reads frames of the video instead
    // (Agent Note 2026-10-13-video-frames, which checks the sheets).
    async storyboard(source) {
      const entry = forSource(source);
      if (!entry.impl.storyboard) return null;
      return (await entry.impl.storyboard(normalizeSource(source))) ?? null;
    },

    // Whether the source can have timed comments at all (it implements
    // `comments`); an item may still have none.
    hasComments(source) {
      return Boolean(sources.get(normalizeSource(source).plugin)?.impl.comments);
    },

    // Timed comments of one item from `start` (Agent Note 2026-10-13-danmaku):
    // null when the item has none, else the comments the source gave and the
    // span they cover completely (comments.js keeps them).
    async comments(source, { start = 0, end = start } = {}) {
      const entry = forSource(source);
      if (!entry.impl.comments) return null;
      const result = await entry.impl.comments(normalizeSource(source), { start, end });
      if (result == null) return null;
      if (typeof result !== "object" || !Array.isArray(result.comments)) {
        throw new YoloError("internal", `Source ${entry.id} returned comments in the wrong shape`);
      }
      const from = Number.isFinite(Number(result.start)) ? Math.max(0, Number(result.start)) : start;
      const to = result.end === null ? null : Number.isFinite(Number(result.end)) ? Number(result.end) : end;
      return { comments: normalizeComments(result.comments), start: from, end: to };
    },

    async libraries() {
      const { values, unavailable } = await fanOut("libraries", async (entry, libraries) => (
        ((await libraries()) ?? []).map((library) => presentLibrary(entry.id, library))
      ));
      return { libraries: values, ...(unavailable.length ? { unavailable } : {}) };
    },

    async items(libraryId, { offset = 0, limit = 50 } = {}) {
      const { entry, localId } = parseLibraryId(libraryId);
      const page = {
        offset: Math.max(0, Math.floor(Number(offset) || 0)),
        limit: Math.min(200, Math.max(1, Math.floor(Number(limit) || 50))),
      };
      const result = (await method(entry, "items")(localId, page)) ?? {};
      return {
        total: result.total ?? null,
        offset: result.offset ?? page.offset,
        items: (result.items ?? []).map((item) => presentItem(entry.id, item)),
      };
    },

    async children(itemId) {
      const { entry, localId } = parseLibraryId(itemId);
      const result = (await method(entry, "children")(localId)) ?? {};
      return {
        ...(result.parent ? { parent: presentItem(entry.id, result.parent) } : {}),
        items: (result.items ?? []).map((item) => presentItem(entry.id, item)),
      };
    },

    async search(query, { type = null, limit = 20 } = {}) {
      const text = String(query ?? "").trim();
      if (!text) throw new YoloError("invalid_request", "q is required");
      const max = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
      const { values, unavailable } = await fanOut("search", async (entry, search) => (
        ((await search(text, { type: type || null, limit: max })) ?? []).map((item) => presentItem(entry.id, item))
      ));
      return { results: values.slice(0, max), ...(unavailable.length ? { unavailable } : {}) };
    },

    async artwork(itemId, variant) {
      const { entry, localId } = parseLibraryId(itemId);
      return method(entry, "artwork")(localId, variant || "poster");
    },
  };
}
