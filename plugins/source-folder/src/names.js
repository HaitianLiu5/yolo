import { basename, dirname, extname, relative, sep } from "node:path";
import { chineseNumber, parseReleaseTitle } from "@useyolo/plugin-api";

// What a file's path says it is (Agent Note 2026-10-26-folder-source): a
// movie, or an episode of a show, from its name and the folders around it.
// The file name is read with Yolo's release-title parser, which knows
// S01E02, 1x02, 第1季第2集, EP02, and a fansub's "- 02"; the folders give a
// show's name and season where the name alone does not:
//
//   Movies/Inception (2010)/Inception.2010.1080p.mkv     movie "Inception" (2010)
//   Shows/Nathan for You/Season 1/S01E08.mkv             episode 8 of season 1
//   Shows/庆余年/第一季/第08集.mp4                         episode 8 of season 1
//   Anime/[Sub] Frieren - 08 [1080p].mkv                 episode 8 of "Frieren"
//   Shows/Some Show/08.mkv                               episode 8 of "Some Show"

// A folder that holds one season: "Season 1", "S01", "第一季", "Specials".
const SEASON_FOLDER = /^(?:season|series|s)\s*0*(\d{1,3})$|^第\s*([0-9零〇一二两三四五六七八九十百]+)\s*季$|^(specials?|sp|特别篇)$/i;

export function seasonOfFolder(name) {
  const match = SEASON_FOLDER.exec(String(name).trim());
  if (!match) return null;
  if (match[3]) return 0;
  return match[1] ? Number(match[1]) : chineseNumber(match[2]);
}

// A folder name read as a title: its first name and its year.
function folderTitle(name) {
  const parsed = parseReleaseTitle(name);
  return { title: parsed.titles[0] ?? name.trim(), year: parsed.year };
}

/**
 * What `path`, under library root `root`, is: { kind: "movie", title, year }
 * or { kind: "episode", show, season, episode, year }.
 */
export function readPath(path, root) {
  const name = basename(path, extname(path));
  const folders = relative(root, dirname(path)).split(sep).filter((part) => part && part !== ".");
  const parsed = parseReleaseTitle(name);
  // A bare number is an episode of the folder's show.
  const bare = /^(?:e|ep)?\s*0*(\d{1,3})$/i.exec(name.trim());
  const episode = parsed.episode ?? (bare && folders.length ? Number(bare[1]) : null);
  if (episode == null) {
    // A file named only by tags ("movie.mkv", "1080p.mkv") takes its folder's name.
    const own = parsed.titles[0];
    const folder = folders.length ? folderTitle(folders.at(-1)) : null;
    const generic = !own || /^(?:movie|video|film|main|feature)$/i.test(own);
    return {
      kind: "movie",
      title: generic && folder ? folder.title : own ?? name,
      year: parsed.year ?? folder?.year ?? null,
    };
  }
  // The show: the folder above a season folder, else the file's own folder
  // when the file sits in one, else the name the file gives.
  let season = parsed.season;
  let show = null;
  let year = parsed.year;
  const last = folders.at(-1);
  const folderSeason = last != null ? seasonOfFolder(last) : null;
  if (folderSeason != null) {
    season ??= folderSeason;
    if (folders.length >= 2) show = folderTitle(folders.at(-2));
  } else if (last != null) {
    show = folderTitle(last);
    // A folder named for its season ("Nathan for You S01", "庆余年 第一季").
    season ??= parseReleaseTitle(last).season;
  }
  if (!show && parsed.titles[0]) show = { title: parsed.titles[0], year: null };
  year ??= show?.year ?? null;
  return { kind: "episode", show: show?.title ?? name, season: season ?? 1, episode, year };
}

/** A key that the same name gives however it is spelled: case, spaces, punctuation. */
export const nameKey = (text) => String(text ?? "").normalize("NFKC").toLowerCase().replace(/[\s._\-–—:：·,，'’"!！?？()（）[\]【】]+/g, "");
