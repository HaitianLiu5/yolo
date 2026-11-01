import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { YoloError } from "@useyolo/plugin-api";
import { readRoots, scanRoots } from "./library.js";
import { createMedia } from "./media.js";
import { nameKey } from "./names.js";
import { decodeSubtitle, formatOf, languageOfName, languageOfText } from "./subtitles.js";

// Official source plugin: movies and shows from folders on the node's machine
// (Agent Note 2026-10-26-folder-source), a disk or a NAS share mounted there.
// The video files under the root folders are read as movies or episodes from
// their names and folders, and episodes are gathered into shows; the movies
// form one library and the shows another. A file plays as a `local` Input: the node serves it as it is where
// the screen plays it so, and otherwise remuxes or transcodes it with ffmpeg.
// Subtitle files beside a video, and text subtitles inside it, reach the
// screen as WebVTT. `file()` names the file, so the metadata plugins read the
// NFO files and pictures beside it.
//
// Options (yolo.config.json): `roots`, the folders' paths; else FOLDER_ROOTS, paths separated by ":" (";" on
// Windows). `rescanMinutes` (default 30); `ffprobe`, else FFPROBE_PATH, else
// ffprobe; `ffmpeg`, else FFMPEG_PATH, else ffmpeg.
//
// Sources: { plugin: "folder", id: "f-<root key>-<hash of the path below the root>" }.

export const SOURCE_ID = "folder";
const DEFAULT_RESCAN_MINUTES = 30;
const PROBE_CONCURRENCY = 2;
// An unknown id scans again at most this often.
const RESCAN_ON_MISS_MS = 60_000;
const POSTER_NAMES = ["poster", "folder", "cover", "movie"];

const IMAGE_TYPES = Object.freeze({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" });

// A picture beside a file or in a folder: the first of `names` with an image extension.
function picture(dir, names) {
  for (const name of names) {
    for (const extension of Object.keys(IMAGE_TYPES)) {
      const path = join(dir, `${name}${extension}`);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

const imageResponse = (bytes, type) => new Response(bytes, { headers: { "content-type": type, "cache-control": "private, max-age=86400" } });

// A track's name from what ffprobe read of it.
function streamName(stream, fallback) {
  return [stream.title, stream.language && stream.language !== "und" ? stream.language : null].filter(Boolean).join(" · ") || fallback;
}

export function createFolderSource({ roots, media, log = null }) {
  let library = { files: new Map(), shows: new Map() };
  let scanned = null;
  let scannedAt = 0;
  let scanning = null;
  let lastError = null;

  function rescan() {
    scanning ??= (async () => {
      const started = Date.now();
      try {
        library = await scanRoots(roots);
        scanned = new Date().toISOString();
        scannedAt = Date.now();
        lastError = null;
        log?.info?.(`Found ${library.files.size} videos and ${library.shows.size} shows in ${roots.length} folders in ${Date.now() - started} ms`);
        void probeAll();
      } catch (error) {
        lastError = error.message;
        log?.warn?.(`Could not scan the folders: ${error.message}`);
      } finally {
        scanning = null;
      }
      return library;
    })();
    return scanning;
  }

  // Durations for the listings, probed in the background a few at a time.
  async function probeAll() {
    const queue = [...library.files.values()].filter((file) => !media.known(file));
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) await media.probe(file).catch(() => null);
    };
    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
  }

  const ready = async () => (scanned ? library : scanning ?? rescan());

  // A file by its item id. An id the last scan does not know scans again, at
  // most once a minute, so a file added since plays before the next
  // scheduled scan.
  async function fileFor(id) {
    await ready();
    if (!library.files.has(id) && /^f-/.test(id) && Date.now() - scannedAt > RESCAN_ON_MISS_MS) await rescan();
    return library.files.get(id) ?? null;
  }

  async function fileOf(source) {
    const file = await fileFor(String(source.id));
    if (!file) throw new YoloError("not_found", "This file is no longer in the library's folders");
    return file;
  }

  // A file's title is its reading in a release name's form ("Show S01E08",
  // "Film (2010)"), which carries what its folders said and which the node's
  // title parser reads clearly, so the metadata plugins confirm it against
  // their records without asking a model (Agent Note 2026-10-25-metadata-plugins).
  const pad = (number) => String(number).padStart(2, "0");
  const titleOf = (file) => (file.kind === "episode"
    ? `${file.show} S${pad(file.season)}E${pad(file.episode)}`
    : file.year ? `${file.title} (${file.year})` : file.title);

  function itemOfFile(file) {
    const probed = media.known(file);
    return {
      id: file.id,
      // A file is a copy whose work the metadata plugins name: a listing
      // shows it as the work once they have matched it.
      kind: "video",
      title: titleOf(file),
      year: file.year ?? null,
      duration: probed?.duration ?? null,
      // A frame or a poster beside the file until a listing shows it as a
      // matched work, with the work's picture in its place.
      artwork: file.kind === "episode" ? "landscape" : "poster",
      ...(file.kind === "episode" ? { season: file.season, episode: file.episode, show: file.show } : {}),
    };
  }

  function itemOfShow(show) {
    const seasons = new Set(show.episodes.map((id) => library.files.get(id)?.season));
    return { id: show.id, kind: "show", title: show.title, year: show.year ?? null, artwork: "poster", episodes: show.episodes.length, seasons: seasons.size };
  }

  // A library's entries, newest first: every folder's movies, or every folder's shows.
  function entriesOf(libraryId) {
    const entries = libraryId === "movies"
      ? [...library.files.values()].filter((file) => file.kind === "movie").map((file) => ({ at: file.mtime, item: () => itemOfFile(file) }))
      : libraryId === "shows" ? [...library.shows.values()].map((show) => ({ at: show.mtime, item: () => itemOfShow(show) })) : null;
    if (!entries) throw new YoloError("not_found", "No such library");
    return entries.sort((a, b) => b.at - a.at);
  }

  // The subtitles of a file: the files beside it, then the text streams inside it.
  function subtitleTracks(file, probed) {
    const beside = (file.subtitles ?? []).filter((name) => formatOf(name)).map((name) => {
      const named = languageOfName(name, basename(file.path));
      return { id: `file:${name}`, kind: "subtitle", language: named?.language ?? "", name: named?.label ?? basename(name), format: "text", file: name };
    });
    const inside = (probed?.subtitles ?? []).filter((stream) => stream.text).map((stream) => ({
      id: `stream:${stream.index}`, kind: "subtitle", language: stream.language && stream.language !== "und" ? stream.language : "", name: streamName(stream, `Subtitle ${stream.index}`),
      format: "text", default: stream.default, stream: stream.index,
    }));
    return [...beside, ...inside];
  }

  function audioTracks(probed) {
    const audio = probed?.audio ?? [];
    if (audio.length < 2) return [];
    return audio.map((stream, at) => ({
      id: `stream:${stream.index}`, kind: "audio", language: stream.language && stream.language !== "und" ? stream.language : "",
      name: streamName(stream, `${stream.codec}${stream.channels ? ` ${stream.channels}ch` : ""}`) || `Audio ${at + 1}`, default: stream.default, stream: stream.index,
    }));
  }

  const listed = ({ file: _file, stream: _stream, ...track }) => track;

  // WebVTT of one of the file's subtitle tracks.
  async function subtitleText(file, probed, trackId) {
    const track = subtitleTracks(file, probed).find((one) => one.id === trackId);
    if (!track) throw new YoloError("not_found", "No such subtitle");
    if (track.stream != null) return media.embedded(file, track.stream);
    const path = join(dirname(file.path), track.file);
    const text = decodeSubtitle(readFileSync(path), track.file);
    return media.toVtt(text, formatOf(track.file));
  }

  // Name a sidecar subtitle whose file name says no language by its text.
  function refineLanguages(file, tracks) {
    for (const track of tracks) {
      if (track.file && !track.language) {
        try {
          const found = languageOfText(decodeSubtitle(readFileSync(join(dirname(file.path), track.file)), track.file));
          if (found) Object.assign(track, { language: found.language, name: found.label });
        } catch {}
      }
    }
    return tracks;
  }

  const source = {
    roots: () => roots.map((root) => root.path),

    async health() {
      return {
        configured: roots.length > 0,
        ...(roots.length ? {} : { reason: "No folders: set FOLDER_ROOTS or the plugin's roots option" }),
        folders: roots.map((root) => ({ path: root.path, reachable: existsSync(root.path) })),
        videos: library.files.size,
        shows: library.shows.size,
        scanned,
        scanning: Boolean(scanning),
        ...(lastError ? { error: lastError } : {}),
      };
    },

    // One library of movies and one of shows across the folders: the home
    // screen shows a movie library and show libraries.
    async libraries() {
      return roots.length ? [{ id: "movies", title: "Movies", type: "movie" }, { id: "shows", title: "Shows", type: "show" }] : [];
    },

    async items(libraryId, { offset = 0, limit = 50 } = {}) {
      await ready();
      const entries = entriesOf(String(libraryId));
      return { total: entries.length, offset, items: entries.slice(offset, offset + limit).map((entry) => entry.item()) };
    },

    async children(itemId) {
      await ready();
      const show = library.shows.get(String(itemId));
      if (!show) throw new YoloError("not_found", "No such show");
      return { parent: itemOfShow(show), items: show.episodes.map((id) => itemOfFile(library.files.get(id))) };
    },

    async search(query, { type = null, limit = 20 } = {}) {
      await ready();
      const wanted = nameKey(query);
      if (!wanted) return [];
      const results = [];
      const shows = new Set();
      for (const show of library.shows.values()) {
        if ((!type || type === "show") && nameKey(show.title).includes(wanted)) {
          results.push(itemOfShow(show));
          shows.add(show.id);
        }
      }
      for (const file of library.files.values()) {
        // A show found by its name stands for its episodes.
        if ((type && type !== file.kind) || shows.has(file.showId)) continue;
        const names = file.kind === "movie" ? [file.title] : type === "episode" ? [file.show] : [];
        if ([...names, basename(file.path, extname(file.path))].some((name) => nameKey(name).includes(wanted))) results.push(itemOfFile(file));
      }
      return results.slice(0, limit);
    },

    async describe(item) {
      const file = await fileOf(item);
      const probed = await media.probe(file).catch(() => null);
      return { title: titleOf(file), artwork: file.kind === "episode" ? "landscape" : "poster", duration: probed?.duration ?? null, isLive: false };
    },

    async details(item) {
      const file = await fileOf(item);
      const probed = await media.probe(file).catch(() => null);
      return {
        title: titleOf(file),
        kind: "video",
        ...(file.year ? { year: file.year } : {}),
        duration: probed?.duration ?? null,
        ...(file.kind === "episode" ? { series: { title: file.show, season: file.season, episode: file.episode } } : {}),
      };
    },

    async file(item) {
      const file = await fileFor(String(item.id));
      return file ? { path: file.path, size: file.size } : null;
    },

    async tracks(item) {
      const file = await fileOf(item);
      const probed = await media.probe(file).catch(() => null);
      return { subtitles: refineLanguages(file, subtitleTracks(file, probed)).map(listed), audio: audioTracks(probed).map(listed) };
    },

    async subtitle(item, trackId) {
      const file = await fileOf(item);
      return subtitleText(file, await media.probe(file).catch(() => null), trackId);
    },

    async sequence(item) {
      await ready();
      const file = library.files.get(String(item.id));
      const show = file?.showId && library.shows.get(file.showId);
      if (!show) return null;
      const index = show.episodes.indexOf(file.id);
      return {
        title: show.title,
        index,
        items: show.episodes.map((id) => {
          const episode = library.files.get(id);
          return { source: { id }, title: titleOf(episode), artwork: "landscape", duration: media.known(episode)?.duration ?? null, label: `S${episode.season} · E${episode.episode}` };
        }),
      };
    },

    async artwork(itemId, variant) {
      const id = String(itemId);
      const show = library.shows.get(id);
      const file = show ? library.files.get(show.episodes[0]) : await fileFor(id);
      if (!file) throw new YoloError("not_found", "No such item");
      const dir = dirname(file.path);
      const base = basename(file.path, extname(file.path));
      const rootPath = roots.find((root) => root.key === file.root)?.path;
      const showDir = show?.dir && show.dir !== rootPath ? show.dir : null;
      const found = show
        ? (showDir ? picture(showDir, POSTER_NAMES) : null)
        : variant === "landscape"
          ? picture(dir, [`${base}-thumb`, `${base}`, `${base}-fanart`])
          // A folder of its own holds the movie's poster; a shared folder only its file's.
          : picture(dir, [`${base}-poster`, `${base}`, ...((file.kind === "movie" && dir !== rootPath) ? POSTER_NAMES : [])]);
      if (found) return imageResponse(readFileSync(found), IMAGE_TYPES[extname(found).toLowerCase()]);
      const probed = await media.probe(file).catch(() => null);
      const at = probed?.duration ? Math.min(probed.duration * 0.1, 300) : 10;
      return imageResponse(await media.frame(file, at), "image/jpeg");
    },

    async prepare(item, { startTime = null, chooseTracks, reason }) {
      const file = await fileOf(item);
      let probed;
      try {
        probed = await media.probe(file);
      } catch (error) {
        throw new YoloError("resolve_failed", `ffprobe could not read this file: ${error.message}`);
      }
      const subtitles = refineLanguages(file, subtitleTracks(file, probed));
      const audio = audioTracks(probed);
      const selected = reason === "frame" ? { subtitles: [], audio: null } : chooseTracks({ subtitles: subtitles.map(listed), audio: audio.map(listed) });
      const audioStream = audio.find((track) => track.id === selected.audio)?.stream ?? null;
      return {
        title: titleOf(file),
        artwork: file.kind === "episode" ? "landscape" : "poster",
        duration: probed.duration,
        startTime: startTime ?? 0,
        input: { type: "local", path: file.path, audio: audioStream },
        profile: probed.video ? { width: probed.video.width, height: probed.video.height, fps: probed.video.fps, videoKbps: probed.kbps } : null,
        tracks: {
          subtitles: subtitles.map((track) => ({ ...listed(track), delivery: "vtt" })),
          audio: audio.map(listed),
          selected,
        },
        subtitle: (trackId) => subtitleText(file, probed, trackId),
      };
    },
  };

  return { source, rescan, library: () => library };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function folderSource(yolo) {
  const roots = readRoots(yolo.options.roots ?? yolo.env.FOLDER_ROOTS);
  const media = createMedia({
    cacheDir: yolo.cacheDir,
    ffprobe: yolo.options.ffprobe ?? yolo.env.FFPROBE_PATH ?? "ffprobe",
    ffmpeg: yolo.options.ffmpeg ?? yolo.env.FFMPEG_PATH ?? "ffmpeg",
    log: yolo.log,
  });
  const folders = createFolderSource({ roots, media, log: yolo.log });
  yolo.registerSource(SOURCE_ID, folders.source);
  if (!roots.length) return;
  let timer = null;
  yolo.on("start", () => {
    // The first scan runs in the background; listings wait for it.
    void folders.rescan();
    const minutes = Number(yolo.options.rescanMinutes) > 0 ? Number(yolo.options.rescanMinutes) : DEFAULT_RESCAN_MINUTES;
    timer = setInterval(() => void folders.rescan(), minutes * 60_000);
    timer.unref?.();
  });
  yolo.on("shutdown", () => {
    clearInterval(timer);
    timer = null;
  });
}
