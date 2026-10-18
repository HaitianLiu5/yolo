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
// optional `duration` (seconds) and `thumbnail` (an http(s) image). These
// optional fields show what agents can read about an item:
//   `description`  text, for details()
//   `chapters`     [{ start, end?, title?, kind? }] in seconds, for chapters()
//   `subtitles`    [{ language, name?, url }] of WebVTT files, for tracks(),
//                  playback, and transcripts (subtitle())
//   `comments`     [{ t, text, mode?, color?, size?, weight? }], timed comments that
//                  screens draw over the picture (danmaku), for comments()
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
    const subtitles = Array.isArray(item.subtitles) ? item.subtitles : [];
    subtitles.forEach((subtitle, n) => {
      if (!isHttpUrl(subtitle?.url)) throw new Error(`${where}.subtitles[${n}].url must be an http(s) URL`);
    });
    return {
      id: item.id,
      title: String(item.title || item.id),
      url: item.url,
      duration: Number.isFinite(item.duration) ? item.duration : null,
      thumbnail: isHttpUrl(item.thumbnail) ? item.thumbnail : null,
      description: typeof item.description === "string" ? item.description : null,
      chapters: Array.isArray(item.chapters) ? item.chapters : [],
      comments: Array.isArray(item.comments) ? item.comments : null,
      // Track ids must stay the same for the same item: saved choices use them.
      subtitles: subtitles.map((subtitle, n) => ({
        id: `sub_${n}`, kind: "subtitle", language: String(subtitle.language || ""), name: String(subtitle.name || subtitle.language || `Subtitle ${n + 1}`),
        format: "text", url: subtitle.url,
      })),
    };
  });
}

// A track as Yolo lists it: everything but the file's URL.
const listed = ({ url: _url, ...track }) => track;

export function createExampleSource(items, { title = "Links", fetchImpl = (...args) => fetch(...args) } = {}) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const find = (id) => {
    const item = byId.get(String(id));
    if (!item) throw new YoloError("not_found", `No item ${id} in ${title}`);
    return item;
  };
  const entry = (item) => ({ id: item.id, kind: "movie", title: item.title, thumbnail: item.thumbnail, duration: item.duration });
  // WebVTT text of one of an item's subtitles.
  async function vtt(item, trackId) {
    const track = (item.subtitles ?? []).find((candidate) => candidate.id === trackId);
    if (!track) throw new YoloError("not_found", `No subtitle ${trackId}`);
    const response = await fetchImpl(track.url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new YoloError("resolve_failed", `The subtitle answered ${response.status}`);
    return response.text();
  }

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
    async tracks(source) {
      return { subtitles: (find(source.id).subtitles ?? []).map(listed), audio: [] };
    },
    // Play: return an Input; the node's media pipeline proxies, caches, and
    // serves it to the device, and serves each "vtt" subtitle from
    // subtitle(trackId). chooseTracks applies the user's choice.
    async prepare(source, { startTime, chooseTracks }) {
      const item = find(source.id);
      const input = /\.m3u8(\?|$)/i.test(item.url) ? { type: "hls", url: item.url } : { type: "file", url: item.url };
      const subtitles = (item.subtitles ?? []).map((track) => ({ ...listed(track), delivery: "vtt" }));
      const selected = chooseTracks ? chooseTracks({ subtitles, audio: [] }) : { subtitles: [], audio: null };
      return {
        title: item.title,
        duration: item.duration,
        thumbnail: item.thumbnail,
        startTime: startTime ?? 0,
        input,
        tracks: { subtitles, audio: [], selected: { subtitles: selected.subtitles, audio: null } },
        subtitle: (trackId) => vtt(item, trackId),
      };
    },
    // What agents read about an item, each optional: details(), chapters(),
    // and subtitle text while it is not playing (transcripts).
    async details(source) {
      const item = find(source.id);
      return { title: item.title, kind: "movie", description: item.description, duration: item.duration };
    },
    async chapters(source) {
      const item = find(source.id);
      return { chapters: item.chapters ?? [], duration: item.duration };
    },
    subtitle: async (source, trackId) => vtt(find(source.id), trackId),
    // Timed comments (danmaku): null for an item without any. A source that
    // reads them in parts answers the part holding `start` and says which
    // span it covers; this one has them all at once (start 0, end null).
    async comments(source) {
      const item = find(source.id);
      return item.comments ? { comments: item.comments, start: 0, end: null } : null;
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
