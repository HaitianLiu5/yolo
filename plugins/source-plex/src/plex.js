import { YoloError } from "@useyolo/plugin-api";

// A small Plex Media Server client for the source's library calls. Ids are
// Plex's own (ratingKey, section key); Yolo adds the "plex:" prefix.

const TEXT_SUBTITLE_CODECS = new Set(["ass", "ssa", "srt", "subrip", "vtt", "webvtt"]);
const ARTWORK = { poster: { width: 390, height: 585 }, landscape: { width: 600, height: 338 } };
const PLEX_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export function plexKey(id) {
  const key = String(id ?? "");
  if (!PLEX_KEY.test(key)) throw new YoloError("invalid_request", `Not a Plex library id: ${id}`);
  return key;
}

// The image paths Plex reports for an item, best first. They must be read,
// not built from the item's id: an episode has no art of its own, and its
// `art` is the show's (/library/metadata/<show>/art), so a landscape episode
// card uses the episode still.
export function artworkPaths(item, variant) {
  const paths = variant === "landscape"
    ? (item.type === "episode" ? [item.thumb, item.art] : [item.art, item.thumb])
    : [item.thumb, item.parentThumb, item.grandparentThumb];
  return paths.filter((path) => typeof path === "string" && path.startsWith("/"));
}

const seconds = (ms) => (Number(ms) > 0 ? Math.round(Number(ms) / 1000) : null);

// A readable label for a Plex subtitle stream: Chinese variants by what the
// title says (简体, 繁体, bilingual), others by Plex's display title plus
// SDH / forced / signs flags.
export function subtitleLabel(sub) {
  const title = String(sub.title || "").trim();
  const display = String(sub.displayTitle || "");
  if (sub.languageCode === "zho" || sub.language === "中文" || display.includes("中文")) {
    const simplified = /chs|简体|简中|simplified/i.test(title);
    const traditional = /cht|繁体|繁中|traditional/i.test(title);
    const english = /eng|english|英/i.test(title);
    let label = "中文";
    if (simplified && english) label = "简英双语";
    else if (traditional && english) label = "繁英双语";
    else if (english) label = "中英双语";
    else if (simplified) label = "简体中文";
    else if (traditional) label = "繁体中文";
    if (/特效/.test(title)) label += "（特效）";
    if (/forced|强制/i.test(title) || display.includes("Forced")) label += "（强制）";
    return label;
  }
  let label = display || sub.language || title || "Unknown";
  const flags = [];
  if ((/sdh/i.test(title) || display.includes("SDH")) && !label.includes("SDH")) flags.push("SDH");
  if ((/forced/i.test(title) || display.includes("Forced")) && !label.includes("Forced") && !label.includes("强制")) flags.push("强制");
  if (/signs/i.test(title)) flags.push("标识");
  return flags.length ? `${label} (${flags.join(", ")})` : label;
}

export function itemFromMetadata(m) {
  const item = {
    id: String(m.ratingKey),
    kind: m.type,
    title: m.type === "episode" && m.grandparentTitle
      ? `${m.grandparentTitle} S${m.parentIndex}E${m.index} — ${m.title}`
      : m.title,
    year: m.year ?? null,
    duration: seconds(m.duration),
    artwork: m.type === "episode" ? "landscape" : "poster",
    resumeAt: seconds(m.viewOffset),
    watched: Number(m.viewCount) > 0,
  };
  if (m.type === "show" || m.type === "season") {
    item.episodes = m.leafCount ?? null;
    item.watchedEpisodes = m.viewedLeafCount ?? 0;
  }
  if (m.type === "episode") Object.assign(item, { season: m.parentIndex ?? null, episode: m.index ?? null, episodeTitle: m.title ?? null });
  return item;
}

const tags = (list) => (Array.isArray(list) ? list.map((entry) => entry?.tag).filter(Boolean) : []);
const MARKER_KINDS = Object.freeze({ intro: "intro", credits: "credits" });

// Plex's intro and credits markers and the file's chapters (the plugin API's
// Chapter). Commercial markers are left out.
export function chaptersFromMetadata(m) {
  const markers = (m.Marker || [])
    .filter((marker) => MARKER_KINDS[marker.type])
    .map((marker) => ({ start: Number(marker.startTimeOffset) / 1000, end: Number(marker.endTimeOffset) / 1000, kind: MARKER_KINDS[marker.type] }));
  const chapters = (m.Chapter || []).map((chapter) => ({
    start: Number(chapter.startTimeOffset) / 1000,
    end: Number(chapter.endTimeOffset) / 1000 || null,
    title: chapter.tag || (chapter.index != null ? `Chapter ${chapter.index}` : null),
    kind: "chapter",
  }));
  return { chapters: [...chapters, ...markers], duration: seconds(m.duration) };
}

// What an agent reads about a library item (the plugin API's Details):
// Plex's summary, cast and crew, dates, genres, ratings, and its own watch
// record. An episode's cast comes from its show when the episode lists few.
export function detailsFromMetadata(m, show = null) {
  const cast = (list) => (Array.isArray(list) ? list : []).filter((role) => role?.tag).map((role) => ({ name: role.tag, role: "cast", character: role.role || null }));
  const castList = cast(m.Role);
  const showCast = castList.length < 3 && show ? cast(show.Role).filter((person) => !castList.some((own) => own.name === person.name)) : [];
  return {
    title: m.title,
    kind: m.type,
    description: [m.tagline, m.summary].filter(Boolean).join("\n\n") || null,
    date: m.originallyAvailableAt || null,
    year: m.year ?? null,
    duration: seconds(m.duration),
    people: [
      ...castList.slice(0, 10),
      ...tags(m.Director).map((name) => ({ name, role: "director" })),
      ...tags(m.Writer).map((name) => ({ name, role: "writer" })),
      ...showCast.slice(0, 10),
      ...tags(m.Producer).map((name) => ({ name, role: "producer" })),
    ],
    genres: tags(m.Genre).length ? tags(m.Genre) : tags(show?.Genre),
    tags: [...tags(m.Label), ...tags(m.Collection)],
    ratings: [
      { value: m.rating, max: 10, source: "critics" },
      { value: m.audienceRating, max: 10, source: "audience" },
      { value: m.userRating, max: 10, source: "you" },
    ].filter((rating) => Number(rating.value) > 0),
    contentRating: m.contentRating || show?.contentRating || null,
    series: m.type === "episode" ? { title: m.grandparentTitle, season: m.parentIndex, episode: m.index, episodeTitle: m.title } : null,
    studio: m.studio || show?.studio || null,
    progress: { position: seconds(m.viewOffset), watched: Number(m.viewCount) > 0 },
  };
}

// Track ids stay `plex:<streamId>`, as saved track choices refer to them.
export function tracksFromPart(part) {
  const streams = part?.Stream || [];
  const track = (stream, kind, format) => ({
    id: `plex:${stream.id}`,
    kind,
    language: stream.languageCode || stream.language || "",
    name: kind === "subtitle" ? subtitleLabel(stream) : stream.displayTitle || stream.title || stream.language || "Unknown",
    auto: false,
    format,
    default: Boolean(stream.selected || stream.default),
    ...(kind === "audio" ? { detail: [String(stream.codec || "").toUpperCase(), stream.channels ? `${stream.channels}ch` : ""].filter(Boolean).join(" ") } : {}),
  });
  return {
    subtitles: streams.filter((stream) => stream.streamType === 3).map((stream) => track(
      stream,
      "subtitle",
      TEXT_SUBTITLE_CODECS.has(String(stream.codec || stream.format || "").toLowerCase()) ? "text" : "image",
    )),
    audio: streams.filter((stream) => stream.streamType === 2).map((stream) => track(stream, "audio", "text")),
  };
}

export function createPlex({ url, token, fetchImpl = (...args) => fetch(...args), timeoutMs = 10_000 }) {
  const configured = Boolean(url && token);

  // Any request to the server, with the token as a header. Returns the
  // Response whatever its status; callers check it.
  async function raw(path, { method = "GET", accept = "application/json", headers = {}, timeout = timeoutMs, signal } = {}) {
    if (!configured) throw new YoloError("not_found", "The Plex library is not configured on this node (PLEX_URL, PLEX_TOKEN)");
    const deadline = AbortSignal.timeout(timeout);
    try {
      return await fetchImpl(new URL(path, url), {
        method,
        headers: { accept, "x-plex-token": token, ...headers },
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch (error) {
      throw new YoloError("resolve_failed", "The Plex library did not respond", { cause: error });
    }
  }

  async function request(path, { accept = "application/json" } = {}) {
    const response = await raw(path, { accept });
    if (response.status === 404) throw new YoloError("not_found", "Library item not found");
    if (!response.ok) throw new YoloError("resolve_failed", `The Plex library answered ${response.status}`);
    return response;
  }

  const json = async (path) => (await request(path)).json();

  // `include` asks for more of the item, such as { includeMarkers: 1 }.
  async function metadata(ratingKey, include = null) {
    const query = include ? `?${new URLSearchParams(include)}` : "";
    const data = await json(`/library/metadata/${encodeURIComponent(plexKey(ratingKey))}${query}`);
    const item = data?.MediaContainer?.Metadata?.[0];
    if (!item) throw new YoloError("not_found", "Library item not found");
    return item;
  }

  return {
    configured,
    url,
    token,
    raw,
    metadata,

    async health() {
      if (!configured) return { configured: false };
      try {
        await json("/identity");
        return { configured: true, online: true };
      } catch {
        return { configured: true, online: false };
      }
    },

    async libraries() {
      const data = await json("/library/sections");
      return (data.MediaContainer?.Directory || []).map((d) => ({ id: String(d.key), title: d.title, type: d.type }));
    },

    async libraryItems(sectionKey, { offset = 0, limit = 50 } = {}) {
      const params = new URLSearchParams({
        sort: "addedAt:desc",
        "X-Plex-Container-Start": String(offset),
        "X-Plex-Container-Size": String(limit),
      });
      const data = await json(`/library/sections/${encodeURIComponent(plexKey(sectionKey))}/all?${params}`);
      return {
        total: data.MediaContainer?.totalSize ?? null,
        offset,
        items: (data.MediaContainer?.Metadata || []).map(itemFromMetadata),
      };
    },

    // A show lists all its episodes (what agents want); anything else lists
    // its direct children.
    async children(ratingKey) {
      const parent = await metadata(ratingKey);
      const path = parent.type === "show" ? "allLeaves" : "children";
      const data = await json(`/library/metadata/${encodeURIComponent(plexKey(ratingKey))}/${path}`);
      return { parent: itemFromMetadata(parent), items: (data.MediaContainer?.Metadata || []).map(itemFromMetadata) };
    },

    async search(query, { type = null, limit = 20 } = {}) {
      const params = new URLSearchParams({ query, limit: String(limit) });
      const data = await json(`/hubs/search?${params}`);
      const results = [];
      for (const hub of data.MediaContainer?.Hub || []) {
        for (const m of hub.Metadata || []) {
          if (["movie", "show", "season", "episode"].includes(m.type) && (!type || m.type === type)) {
            results.push(itemFromMetadata(m));
          }
        }
      }
      return results;
    },

    async describe(ratingKey) {
      const { title, artwork, duration, resumeAt } = itemFromMetadata(await metadata(ratingKey));
      return { title, artwork, duration, isLive: false, resumeAt };
    },

    async chapters(ratingKey) {
      return chaptersFromMetadata(await metadata(ratingKey, { includeMarkers: "1", includeChapters: "1" }));
    },

    async details(ratingKey) {
      const item = await metadata(ratingKey);
      const show = item.type === "episode" && item.grandparentRatingKey && (item.Role || []).length < 3
        ? await metadata(item.grandparentRatingKey).catch(() => null)
        : null;
      return detailsFromMetadata(item, show);
    },

    async tracks(ratingKey) {
      const item = await metadata(ratingKey);
      return tracksFromPart(item.Media?.[0]?.Part?.[0]);
    },

    async artwork(ratingKey, variant = "poster") {
      const kind = Object.hasOwn(ARTWORK, variant) ? variant : "poster";
      const preset = ARTWORK[kind];
      const [path] = artworkPaths(await metadata(ratingKey), kind);
      if (!path) throw new YoloError("not_found", "This library item has no artwork");
      const params = new URLSearchParams({
        width: String(preset.width),
        height: String(preset.height),
        minSize: "1",
        upscale: "0",
        url: path,
      });
      return request(`/photo/:/transcode?${params}`, { accept: "image/*" });
    },
  };
}
