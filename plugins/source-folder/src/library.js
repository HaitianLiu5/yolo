import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { nameKey, readPath } from "./names.js";

// The folders' library (Agent Note 2026-10-26-folder-source): every video
// file under each root, read as a movie or an episode, with the subtitle
// files beside it, and episodes gathered into shows. Item ids are hashes of a file's path below its root and of a
// show's name, behind a short key of the root's own path, so they stay the
// same across scans and restarts and name no path:
//
//   f-<root key>-<hash of the path below the root>    a movie or an episode
//   s-<root key>-<hash of the show's name>            a show, which lists its episodes

export const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".m4v", ".mov", ".avi", ".webm", ".ts", ".m2ts", ".mts", ".wmv", ".flv", ".mpg", ".mpeg"]);
export const SUBTITLE_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".vtt"]);
// Folders a NAS or an operating system keeps for itself.
const SKIPPED = /^(?:\.|@eaDir$|#recycle$|#snapshot$|\$RECYCLE\.BIN$|System Volume Information$|lost\+found$|extras?$|featurettes?$|behind the scenes$|trailers?$)/i;
const SAMPLE = /(?:^|[\s._\-[(])sample(?:$|[\s._\-\])])/i;
const SAMPLE_BYTES = 300 * 1024 * 1024;
const MAX_DEPTH = 8;

const hash = (text, length) => createHash("sha256").update(text).digest("hex").slice(0, length);
export const rootKey = (root) => hash(root, 8);

/** Roots from the plugin's options or FOLDER_ROOTS: absolute, normalized, once each. */
export function readRoots(value, delimiter = process.platform === "win32" ? ";" : ":") {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(delimiter) : [];
  const roots = [];
  for (const entry of list) {
    const path = typeof entry === "string" ? entry.trim() : typeof entry?.path === "string" ? entry.path.trim() : "";
    if (!path || !isAbsolute(path)) continue;
    const absolute = normalize(path).replace(/(.)[\\/]+$/, "$1");
    if (roots.some((root) => root.path === absolute)) continue;
    roots.push({ key: rootKey(absolute), path: absolute });
  }
  return roots;
}

/** A file's item id: its path below its root, hashed. */
export const idOfFile = (root, path) => `f-${root.key}-${hash(relative(root.path, path).split(sep).join("/"), 24)}`;
/** A show's item id: its name, hashed. */
export const idOfShow = (root, name) => `s-${root.key}-${hash(name, 16)}`;

// Every video file under `dir`, with the subtitle files in its folder.
async function walk(dir, depth, found) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subtitles = entries.filter((entry) => entry.isFile() && SUBTITLE_EXTENSIONS.has(extname(entry.name).toLowerCase())).map((entry) => entry.name);
  // Subtitles a release keeps in a Subs folder beside the video.
  for (const entry of entries) {
    if (entry.isDirectory() && /^(?:subs?|subtitles?|字幕)$/i.test(entry.name)) {
      const inner = await readdir(join(dir, entry.name)).catch(() => []);
      subtitles.push(...inner.filter((name) => SUBTITLE_EXTENSIONS.has(extname(name).toLowerCase())).map((name) => join(entry.name, name)));
    }
  }
  const videos = [];
  for (const entry of entries) {
    if (!entry.isFile() || !VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const path = join(dir, entry.name);
    const info = await stat(path).catch(() => null);
    if (info && !(SAMPLE.test(entry.name) && info.size < SAMPLE_BYTES)) videos.push({ name: entry.name, path, info });
  }
  for (const { name, path, info } of videos) {
    found.push({ path, size: info.size, mtime: Math.floor(info.mtimeMs), subtitles: sidecars(name, subtitles, videos.length) });
  }
  if (depth >= MAX_DEPTH) return;
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIPPED.test(entry.name) && !/^(?:subs?|subtitles?|字幕)$/i.test(entry.name)) await walk(join(dir, entry.name), depth + 1, found);
  }
}

// A video's subtitle files: those named after it ("Movie.zh.srt"), or every
// one in the folder when the video is alone there.
export function sidecars(video, names, videosInFolder = 1) {
  const base = basename(video, extname(video)).toLowerCase();
  return names.filter((name) => {
    const own = basename(name).toLowerCase();
    return own.startsWith(`${base}.`) || own.startsWith(`${base}_`) || own.startsWith(`${base} `) || videosInFolder === 1;
  }).sort();
}

/** Scan every root: { files, shows } with movies and episodes read from their paths. */
export async function scanRoots(roots) {
  const files = new Map(); // id → file
  const shows = new Map(); // id → show
  for (const root of roots) {
    const found = [];
    await walk(root.path, 0, found);
    for (const file of found) {
      const read = readPath(file.path, root.path);
      const id = idOfFile(root, file.path);
      const entry = { ...file, ...read, id, root: root.key };
      if (read.kind === "episode") {
        const showId = idOfShow(root, nameKey(read.show) || nameKey(basename(dirname(file.path))));
        entry.showId = showId;
        const show = shows.get(showId) ?? { id: showId, root: root.key, title: read.show, year: read.year, episodes: [], mtime: 0, dir: null };
        show.episodes.push(id);
        show.mtime = Math.max(show.mtime, file.mtime);
        // The show's folder: the one its episodes share.
        const folder = dirname(file.path);
        const showDir = /^(?:season|series|s)\s*\d+$|^第.+季$|^specials?$/i.test(basename(folder)) ? dirname(folder) : folder;
        show.dir = show.dir === null || show.dir === showDir ? showDir : root.path;
        shows.set(showId, show);
      }
      files.set(id, entry);
    }
  }
  for (const show of shows.values()) {
    show.episodes.sort((a, b) => {
      const x = files.get(a);
      const y = files.get(b);
      return x.season - y.season || x.episode - y.episode || x.path.localeCompare(y.path);
    });
  }
  return { files, shows };
}
