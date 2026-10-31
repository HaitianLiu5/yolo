import { createJsonClient, fold, lengthFits, nameConfidence, nameScore, round, wanted, yearOf } from "./fetch-json.js";

// Official metadata plugin: Bangumi (bgm.tv), with no key (Agent Note
// 2026-10-25-metadata-plugins). It knows anime and Japanese and Chinese
// shows and films better than the other databases, with Chinese titles and
// synopses: it confirms an episode against the subject's episode list and
// runtime, and describes it with its characters' pictures and voice actors.
// Bangumi keeps each season as its own subject, so season 2 is searched as
// "<name> 第二季". It writes in Chinese and Japanese, so it answers owners
// whose language is one of them (option `always` for everyone). An
// episode's synopsis is left to an episode database: Bangumi's own text for
// an episode is mostly its staff list.

const API = "https://api.bgm.tv";
// Subject types: anime and live action ("real").
const TYPES = Object.freeze([2, 6]);
const EPISODE_RUNTIME = 0.2;
const FILM_RUNTIME = 0.25;
const MAX_PEOPLE = 12;
const CHINESE_NUMERALS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const ATTRIBUTION_TEXT = "Anime and show data from Bangumi (bgm.tv).";

// The season a subject's name says, such as 第二季 or Season 2; 1 without one.
export function subjectSeason(names) {
  for (const name of names.filter(Boolean)) {
    const chinese = /第([一二三四五六七八九十]|\d+)[季期]/.exec(name);
    if (chinese) return /\d/.test(chinese[1]) ? Number(chinese[1]) : CHINESE_NUMERALS.indexOf(chinese[1]);
    const english = /(?:Season|S)\s*(\d+)|(\d+)(?:st|nd|rd|th) Season/i.exec(name);
    if (english) return Number(english[1] ?? english[2]);
  }
  return 1;
}

const speaks = (language) => /^(zh|ja)\b/i.test(String(language ?? ""));

export function createBangumiMetadata({ fetch, cacheDir = null, language: preferred = null, always = false } = {}) {
  const getJson = createJsonClient({ name: "Bangumi", fetch, cacheDir });
  const subject = (id) => getJson(`${API}/v0/subjects/${encodeURIComponent(id)}`);
  const episodes = async (id) => (await getJson(`${API}/v0/episodes?subject_id=${encodeURIComponent(id)}&type=0&limit=200`))?.data ?? [];
  const episodeOf = async (id, number) => (await episodes(id)).find((entry) => (entry.ep ?? entry.sort) === number) ?? null;

  async function searchSubjects(keyword) {
    const found = await getJson(`${API}/v0/search/subjects?limit=10`, { method: "POST", body: { keyword, filter: { type: TYPES } } });
    return found?.data ?? [];
  }

  async function identify(subjectOf, { language } = {}) {
    if (!always && !speaks(preferred || language)) return [];
    const want = wanted(subjectOf);
    if (/^\d+$/.test(subjectOf.ids?.bangumi ?? "")) {
      const known = await subject(subjectOf.ids.bangumi);
      if (known) return [{ id: String(known.id), kind: want.kind, title: known.name_cn || known.name, ...(want.kind === "episode" ? { season: want.season, episode: want.episode } : {}), confidence: 1, ids: { bangumi: String(known.id) } }];
    }
    if (!want.names.length || (want.kind === "episode" && want.episode == null)) return [];
    const season = want.season ?? 1;
    const found = new Map();
    for (const name of want.names.slice(0, 3)) {
      const keywords = season > 1 ? [`${name} 第${CHINESE_NUMERALS[season] ?? season}季`, `${name} Season ${season}`] : [name];
      for (const keyword of keywords) for (const entry of await searchSubjects(keyword)) if (!found.has(entry.id)) found.set(entry.id, entry);
    }
    const candidates = [];
    for (const entry of found.values()) {
      const names = [entry.name, entry.name_cn];
      // The season's own subject: "Name 第二季" matches "Name" for season 2.
      const bare = names.map((name) => String(name ?? "").replace(/\s*(第[一二三四五六七八九十\d]+[季期]|Season\s*\d+|\d+(st|nd|rd|th) Season)\s*/gi, "").trim());
      let score = nameScore(want.names, [...names, ...bare]);
      if (score < 0.75 || subjectSeason(names) !== season) continue;
      const year = yearOf(entry.date);
      if (want.year && year) score += year === want.year ? 0.05 : -0.25;
      let confidence;
      let episode = null;
      if (want.kind === "episode") {
        episode = await episodeOf(entry.id, want.episode);
        const fits = episode ? lengthFits(subjectOf.duration, (episode.duration_seconds ?? 0) / 60, EPISODE_RUNTIME) : false;
        confidence = !episode ? 0.3 : fits === false ? Math.min(score, 0.6) : nameConfidence(score);
      } else {
        const minutes = (await episodes(entry.id))[0]?.duration_seconds / 60;
        confidence = lengthFits(subjectOf.duration, minutes, FILM_RUNTIME) === false ? Math.min(score, 0.5) : nameConfidence(score);
      }
      candidates.push({
        id: String(entry.id), kind: want.kind, title: entry.name_cn || entry.name, ...(year ? { year } : {}),
        ...(want.kind === "episode" ? { season: want.season ?? 1, episode: want.episode } : {}),
        ...(episode ? { episodeTitle: episode.name_cn || episode.name } : {}),
        confidence: round(confidence), ids: { bangumi: String(entry.id) },
      });
    }
    // Names that only contain each other match many subjects; keep the closest.
    return candidates.sort((a, b) => b.confidence - a.confidence || fold(a.title).length - fold(b.title).length).slice(0, 5);
  }

  async function lookup(found) {
    const entry = await subject(found.id);
    if (!entry) return {};
    const characters = (await getJson(`${API}/v0/subjects/${encodeURIComponent(found.id)}/characters`)) ?? [];
    const people = characters.filter((character) => character.relation === "主角" || character.relation === "配角").slice(0, MAX_PEOPLE).map((character) => ({
      name: character.actors?.[0]?.name ?? character.name,
      role: "cast",
      character: character.name,
      photo: character.actors?.[0]?.images?.medium ?? character.images?.medium ?? null,
    }));
    const title = entry.name_cn || entry.name;
    const about = {
      genres: (entry.tags ?? []).slice(0, 5).map((tag) => tag.name),
      ratings: entry.rating?.score ? [{ value: entry.rating.score, max: 10, source: "audience" }] : [],
      poster: entry.images?.common ?? entry.images?.large ?? null,
      people,
      ids: { bangumi: String(entry.id) },
      attribution: { text: ATTRIBUTION_TEXT, url: `https://bgm.tv/subject/${entry.id}` },
    };
    if (found.kind === "movie") return { kind: "movie", title, description: entry.summary, date: entry.date, year: yearOf(entry.date), ...about };
    const episode = found.episode != null ? await episodeOf(found.id, found.episode) : null;
    const show = { title, description: entry.summary, year: yearOf(entry.date), poster: about.poster };
    if (!episode) return { kind: "episode", series: { title, season: found.season, episode: found.episode }, show, ...about };
    const episodeTitle = episode.name_cn || episode.name || null;
    return {
      kind: "episode",
      title: episodeTitle,
      date: episode.airdate,
      year: yearOf(episode.airdate),
      series: { title, season: found.season, episode: found.episode, episodeTitle },
      show,
      ...about,
    };
  }

  async function search(query, { limit = 10 }) {
    return (await searchSubjects(query)).slice(0, limit).map((entry) => ({
      id: String(entry.id), kind: "show", title: entry.name_cn || entry.name, ...(yearOf(entry.date) ? { year: yearOf(entry.date) } : {}), confidence: 0.5,
    }));
  }

  return { identify, lookup, search };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function bangumiMetadata(yolo) {
  yolo.registerMetadata("bangumi", createBangumiMetadata({ fetch: yolo.fetch, cacheDir: yolo.cacheDir, language: yolo.options.language ?? null, always: yolo.options.always === true }));
}
