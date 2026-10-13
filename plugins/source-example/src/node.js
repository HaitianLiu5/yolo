import { isHttpUrl, YoloError } from "@useyolo/plugin-api";

// Example source plugin (Agent Note 2026-10-11-source-plugin-api): one library
// of videos that the owner lists in the plugin config. Copy this directory to
// start a new source; skills/yolo-add-source-plugin walks through it.
//
//   { "source": "./plugins/source-example", "options": {
//       "title": "Links",
//       "items": [{ "id": "trailer", "title": "A trailer", "url": "https://…/trailer.mp4" }] } }
//
// Each item: `id` (stable: history and resume are keyed by it), `title`,
// `url` (a progressive file such as MP4, or an HLS .m3u8 playlist), and
// optional `duration` (seconds) and `thumbnail` (an http(s) image).
//
// Sources: { plugin: "example", id: <item id> }.

export const SOURCE_ID = "example";
const LIBRARY_ID = "links";

function readItems(options) {
  const items = Array.isArray(options.items) ? options.items : [];
  return items.map((item, index) => {
    const where = `options.items[${index}]`;
    if (!item || typeof item.id !== "string" || !item.id) throw new Error(`${where}.id must be a non-empty string`);
    if (!isHttpUrl(item.url)) throw new Error(`${where}.url must be an http(s) URL`);
    return {
      id: item.id,
      title: String(item.title || item.id),
      url: item.url,
      duration: Number.isFinite(item.duration) ? item.duration : null,
      thumbnail: isHttpUrl(item.thumbnail) ? item.thumbnail : null,
    };
  });
}

export function createExampleSource(items, { title = "Links" } = {}) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const find = (id) => {
    const item = byId.get(String(id));
    if (!item) throw new YoloError("not_found", `No item ${id} in ${title}`);
    return item;
  };
  const entry = (item) => ({ id: item.id, kind: "movie", title: item.title, thumbnail: item.thumbnail, duration: item.duration });

  return {
    // Claims only the URLs it lists, so a listed link gets this source's id.
    // claim() must be fast and offline.
    claim(url) {
      const item = items.find((candidate) => candidate.url === url);
      return item ? { id: item.id } : undefined;
    },
    async libraries() {
      return [{ id: LIBRARY_ID, title, type: "movie" }];
    },
    async items(libraryId, { offset = 0, limit = 50 } = {}) {
      if (libraryId !== LIBRARY_ID) throw new YoloError("not_found", `No library ${libraryId}`);
      const start = Math.max(0, Number(offset) || 0);
      const page = items.slice(start, start + (Number(limit) || 50));
      return { total: items.length, offset: start, items: page.map(entry) };
    },
    async search(query, { limit = 20 } = {}) {
      const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      return items.filter((item) => words.every((word) => item.title.toLowerCase().includes(word))).slice(0, Number(limit) || 20).map(entry);
    },
    async describe(source) {
      const item = find(source.id);
      return { title: item.title, thumbnail: item.thumbnail, duration: item.duration, isLive: false };
    },
    // Play: return an Input; the node's media pipeline proxies, caches, and
    // serves it to the device. This source has no tracks of its own.
    async prepare(source, { startTime }) {
      const item = find(source.id);
      const input = /\.m3u8(\?|$)/i.test(item.url) ? { type: "hls", url: item.url } : { type: "file", url: item.url };
      return {
        title: item.title,
        duration: item.duration,
        thumbnail: item.thumbnail,
        startTime: startTime ?? 0,
        input,
        tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
      };
    },
    async health() {
      return { online: true, items: items.length };
    },
  };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function (yolo) {
  // The factory only registers; a plugin that starts processes or timers does
  // so in yolo.on("start") and stops them in yolo.on("shutdown").
  const items = readItems(yolo.options);
  yolo.registerSource(SOURCE_ID, createExampleSource(items, { title: yolo.options.title }));
  yolo.log.info(`${items.length} item(s)`);
}
