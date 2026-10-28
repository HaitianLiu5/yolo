import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parseNfo } from "./nfo.js";

// Official metadata plugin: what lies beside a file and inside it (Agent Note
// 2026-10-25-metadata-plugins). A Kodi-style NFO is the owner's own
// description, so it matches for certain and its ids reach the plugins after
// it; pictures beside the file (poster, fan art, an episode's thumb, cast
// pictures in .actors) are served by the node from here; tags embedded in the
// file (ffprobe) describe an episode without an NFO. It needs the item's file,
// so it serves library sources, not web videos. Nothing goes over the network.
//
// Options (yolo.config.json): ffprobe, the command, else FFPROBE_PATH, else
// ffprobe on PATH.

const IMAGE_TYPES = Object.freeze({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" });
const FFPROBE_TIMEOUT_MS = 10_000;

// A picture beside a file: the first of these names with an image extension.
function picture(dir, names) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const byName = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));
  for (const name of names) {
    for (const extension of Object.keys(IMAGE_TYPES)) {
      const found = byName.get(`${name}${extension}`.toLowerCase());
      if (found) return join(dir, found);
    }
  }
  return null;
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// What lies beside a file: its own NFO, the show's tvshow.nfo up to two
// folders above (Show/Season 1/episode.mkv), and their folders.
export function besideFile(path) {
  const dir = dirname(path);
  const base = basename(path, extname(path));
  const item = parseNfo(read(join(dir, `${base}.nfo`)) ?? read(join(dir, "movie.nfo")));
  let show = null;
  let showDir = null;
  for (const candidate of [dir, dirname(dir)]) {
    const parsed = parseNfo(read(join(candidate, "tvshow.nfo")));
    if (parsed) {
      show = parsed;
      showDir = candidate;
      break;
    }
  }
  return { dir, base, item, show, showDir: showDir ?? (item?.root === "episodedetails" ? dirname(dir) : null) };
}

// Where each picture ref is, for a file and what lies beside it.
function pictures({ dir, base, item, showDir }) {
  const found = {
    poster: picture(dir, [`${base}-poster`, "poster", "folder", "cover"]),
    fanart: picture(dir, [`${base}-fanart`, "fanart", "backdrop"]) ?? (showDir ? picture(showDir, ["fanart", "backdrop"]) : null),
    thumb: picture(dir, [`${base}-thumb`, `${base}`]),
    "show-poster": showDir ? picture(showDir, ["poster", "folder"]) : null,
  };
  // Cast pictures: .actors/First_Last.jpg beside the file or the show.
  for (const [index, actor] of (item?.actors ?? []).entries()) {
    const file = actor.name.replace(/\s+/g, "_");
    const path = picture(join(dir, ".actors"), [file]) ?? (showDir ? picture(join(showDir, ".actors"), [file]) : null);
    if (path) found[`actor-${index}`] = path;
  }
  return found;
}

/** Tags embedded in the file, lowercased, from ffprobe; {} without it. */
export function probeTags(path, { command = "ffprobe", run = execFile } = {}) {
  return new Promise((resolve) => {
    run(command, ["-v", "quiet", "-print_format", "json", "-show_format", path], { timeout: FFPROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve({});
      try {
        const tags = JSON.parse(stdout)?.format?.tags ?? {};
        resolve(Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), String(value)])));
      } catch {
        resolve({});
      }
    });
  });
}

const whole = (value) => {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

export function createLocalMetadata({ cacheDir = null, ffprobe = "ffprobe", run } = {}) {
  // A candidate's id stands for its file, which never leaves the node.
  const index = join(cacheDir ?? "", "files.json");
  const files = new Map(Object.entries((cacheDir && JSON.parse(read(index) ?? "{}")) || {}));
  const idFor = (path) => {
    const id = `f-${createHash("sha256").update(path).digest("hex").slice(0, 20)}`;
    if (files.get(id) !== path) {
      files.set(id, path);
      if (cacheDir) {
        try {
          mkdirSync(cacheDir, { recursive: true });
          writeFileSync(index, JSON.stringify(Object.fromEntries(files)));
        } catch {}
      }
    }
    return id;
  };
  const probe = (path) => probeTags(path, { command: ffprobe, ...(run ? { run } : {}) });

  async function identify(subject) {
    const path = subject.file?.path;
    if (!path || !existsSync(path)) return [];
    const beside = besideFile(path);
    const { item, show } = beside;
    const id = idFor(path);
    if (item) {
      const episode = item.root === "episodedetails";
      return [{
        id,
        kind: episode ? "episode" : item.root === "movie" ? "movie" : "video",
        title: episode ? item.showTitle ?? show?.title ?? item.title : item.title,
        ...(item.year ? { year: item.year } : {}),
        ...(episode && item.season != null ? { season: item.season } : {}),
        ...(episode && item.episode != null ? { episode: item.episode } : {}),
        confidence: 1,
        ids: Object.keys(item.ids).length ? item.ids : show?.ids ?? {},
      }];
    }
    const tags = await probe(path);
    if (tags.show && whole(tags.season_number) !== null && whole(tags.episode_sort ?? tags.episode_id) !== null) {
      return [{ id, kind: "episode", title: tags.show, season: whole(tags.season_number), episode: whole(tags.episode_sort ?? tags.episode_id), confidence: 0.9 }];
    }
    // Pictures alone say nothing of the work: they only fill what is missing.
    const found = pictures(beside);
    if (found.poster || found.fanart || found.thumb) return [{ id, kind: subject.kind ?? "video", title: subject.title ?? basename(path), confidence: 0.9 }];
    return [];
  }

  async function lookup(candidate) {
    const path = files.get(candidate.id);
    if (!path || !existsSync(path)) return {};
    const beside = besideFile(path);
    const { item, show } = beside;
    const found = pictures(beside);
    const local = (ref) => (found[ref] ? `local:${ref}` : undefined);
    const art = { poster: local("poster") ?? local("show-poster"), backdrop: local("fanart"), still: local("thumb") };
    if (item) {
      const episode = item.root === "episodedetails";
      const people = [
        ...item.actors.map((actor, at) => ({
          name: actor.name,
          role: "cast",
          character: actor.role,
          photo: local(`actor-${at}`) ?? (/^https?:\/\//.test(actor.thumb ?? "") ? actor.thumb : undefined),
        })),
        ...item.directors.map((name) => ({ name, role: "director" })),
        ...item.writers.map((name) => ({ name, role: "writer" })),
      ];
      return {
        kind: episode ? "episode" : "movie",
        title: item.title,
        description: item.plot ?? (episode ? show?.plot : null),
        date: item.date,
        year: item.year,
        people,
        genres: item.genres.length ? item.genres : show?.genres ?? [],
        studio: item.studio ?? show?.studio,
        contentRating: item.contentRating ?? show?.contentRating,
        ratings: item.rating ? [{ value: item.rating, max: 10, source: "audience" }] : [],
        ...(episode ? {
          series: { title: item.showTitle ?? show?.title, season: item.season, episode: item.episode, episodeTitle: item.title },
          ...(show ? { show: { title: show.title, description: show.plot, year: show.year, poster: local("show-poster") } } : {}),
        } : {}),
        ids: item.ids,
        ...art,
      };
    }
    const tags = await probe(path);
    if (tags.show) {
      return {
        kind: "episode",
        title: tags.title,
        description: tags.description ?? tags.synopsis,
        date: tags.date,
        series: { title: tags.show, season: whole(tags.season_number), episode: whole(tags.episode_sort ?? tags.episode_id), episodeTitle: tags.title },
        genres: tags.genre ? [tags.genre] : [],
        ...art,
      };
    }
    return art;
  }

  async function image(ref, { file }) {
    if (!file?.path) return new Response(null, { status: 404 });
    const path = pictures(besideFile(file.path))[ref];
    const type = path ? IMAGE_TYPES[extname(path).toLowerCase()] : null;
    if (!type) return new Response(null, { status: 404 });
    return new Response(readFileSync(path), { headers: { "content-type": type } });
  }

  return { identify, lookup, image };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function localMetadata(yolo) {
  yolo.registerMetadata("local", createLocalMetadata({
    cacheDir: yolo.cacheDir,
    ffprobe: yolo.options.ffprobe ?? yolo.env.FFPROBE_PATH ?? "ffprobe",
  }));
}
