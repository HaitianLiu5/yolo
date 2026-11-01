import { ATTRIBUTION, createTmdbClient, image, tmdbLanguage } from "./tmdb.js";

// Official metadata plugin: The Movie Database (Agent Note
// 2026-10-25-metadata-plugins). It confirms the work a model or the title
// parser named against TMDB's records, checking what a model may misremember
// (whether the season has the episode, the runtime against the item's
// length), and describes it: titles, synopsis, cast with photos, pictures,
// genres, and ratings. TMDB's terms give each developer their own licence,
// so every owner registers a free key; without one the plugin does nothing.
//
// Options (yolo.config.json), each falling back to the environment:
//   apiKey    TMDB_API_KEY: a v3 API key or a v4 read access token
//   language  the language of titles and synopses, such as "zh-CN"; else
//             YOLO_METADATA_LANGUAGE, else English

// How far an item's length may be from the record's runtime: an episode's
// copy is the episode, a film's may be another cut.
const EPISODE_RUNTIME = 0.15;
const FILM_RUNTIME = 0.25;
const MAX_CAST = 12;
const SEARCH_RESULTS = 5;

// Titles compared without case, punctuation, or spaces.
const fold = (text) => String(text ?? "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const yearOf = (date) => (typeof date === "string" && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);

// How well a record's names fit the names the item gave: 1 for the same
// name, less for one inside the other, 0 for neither.
function nameScore(names, record) {
  const own = [record.name, record.original_name, record.title, record.original_title].filter(Boolean).map(fold);
  let best = 0;
  for (const name of names.map(fold).filter(Boolean)) {
    for (const other of own) {
      if (name === other) best = Math.max(best, 1);
      else if (other.length > 2 && name.length > 2 && (other.includes(name) || name.includes(other))) best = Math.max(best, 0.75);
    }
  }
  return best;
}

// Within `share` of `expected` seconds, or null when either is unknown.
const lengthFits = (seconds, minutes, share) => (seconds > 0 && minutes > 0 ? Math.abs(seconds - minutes * 60) <= minutes * 60 * share : null);

// What the item says it is: from the model's identity, else the parser's hints.
export function wanted(subject) {
  const identity = subject.identity;
  if (identity && identity.kind !== "other") {
    const show = identity.show ?? {};
    const names = identity.kind === "movie"
      ? [identity.originalTitle, identity.title]
      : [show.originalTitle, show.title];
    return {
      kind: identity.kind === "movie" ? "movie" : "episode",
      names: [...new Set([...names, ...subject.hints.titles].filter(Boolean))],
      year: identity.kind === "movie" ? identity.year : show.year,
      season: identity.season,
      episode: identity.episode,
    };
  }
  const { hints } = subject;
  const kind = hints.kind === "movie" || (hints.season == null && hints.episode == null && hints.kind !== "episode") ? "movie" : "episode";
  return { kind, names: hints.titles, year: hints.year, season: hints.season ?? (hints.episode != null ? 1 : null), episode: hints.episode };
}

const round = (value) => Math.round(Math.min(value, 0.97) * 100) / 100;

export function createTmdbMetadata({ key, fetch, cacheDir = null, language: preferred = null } = {}) {
  const tmdb = createTmdbClient({ key, fetch, cacheDir });
  const lang = (language) => tmdbLanguage(preferred || language);

  // An external id the item already carries, as TMDB's find takes it.
  async function byExternalId(ids, language) {
    if (ids.tmdb && /^(movie|tv)\/\d+$/.test(ids.tmdb)) {
      const [kind, id] = ids.tmdb.split("/");
      return [{ id: ids.tmdb, kind: kind === "movie" ? "movie" : "show", title: id, confidence: 1 }];
    }
    for (const [source, value] of [["imdb_id", ids.imdb], ["tvdb_id", ids.tvdb]]) {
      if (!value) continue;
      const found = await tmdb.get(`/find/${encodeURIComponent(value)}`, { external_source: source, language: lang(language) });
      const episode = found?.tv_episode_results?.[0];
      if (episode) return [{ id: `tv/${episode.show_id}`, kind: "episode", title: episode.name, season: episode.season_number, episode: episode.episode_number, confidence: 1, ids: { tmdb: `tv/${episode.show_id}` } }];
      const movie = found?.movie_results?.[0];
      if (movie) return [{ id: `movie/${movie.id}`, kind: "movie", title: movie.title, year: yearOf(movie.release_date), confidence: 1, ids: { tmdb: `movie/${movie.id}` } }];
      const show = found?.tv_results?.[0];
      if (show) return [{ id: `tv/${show.id}`, kind: "show", title: show.name, year: yearOf(show.first_air_date), confidence: 1, ids: { tmdb: `tv/${show.id}` } }];
    }
    return null;
  }

  async function search(kind, names, year, language) {
    const seen = new Map();
    for (const name of names.slice(0, 3)) {
      const found = await tmdb.get(`/search/${kind === "movie" ? "movie" : "tv"}`, { query: name, language: lang(language), include_adult: "false" });
      for (const record of (found?.results ?? []).slice(0, SEARCH_RESULTS)) if (!seen.has(record.id)) seen.set(record.id, record);
    }
    return [...seen.values()].map((record) => {
      const recordYear = yearOf(record.first_air_date ?? record.release_date);
      let score = nameScore(names, record);
      if (year && recordYear) score += recordYear === year ? 0.05 : -0.25;
      return { record, score, year: recordYear };
    }).filter((entry) => entry.score >= 0.5).sort((a, b) => b.score - a.score);
  }

  async function identify(subject, { language }) {
    if (!tmdb.configured) return [];
    const known = await byExternalId(subject.ids ?? {}, language);
    if (known) return known;
    const want = wanted(subject);
    if (!want.names.length) return [];
    if (want.kind === "movie") {
      const results = await search("movie", want.names, want.year, language);
      const candidates = [];
      for (const { record, score, year } of results.slice(0, 3)) {
        const movie = await tmdb.get(`/movie/${record.id}`, { language: lang(language) });
        const fits = lengthFits(subject.duration, movie?.runtime, FILM_RUNTIME);
        candidates.push({ id: `movie/${record.id}`, kind: "movie", title: record.title, year, confidence: round(fits === false ? Math.min(score, 0.5) : 0.85 + 0.1 * score), ids: { tmdb: `movie/${record.id}` } });
      }
      return candidates.sort((a, b) => b.confidence - a.confidence);
    }
    if (want.season == null || want.episode == null) return [];
    const results = await search("tv", want.names, want.year, language);
    const candidates = [];
    for (const { record, score, year } of results.slice(0, 3)) {
      const season = await tmdb.get(`/tv/${record.id}/season/${want.season}`, { language: lang(language) });
      const episode = season?.episodes?.find((entry) => entry.episode_number === want.episode);
      // No such episode: the record contradicts what the item says.
      const fits = episode ? lengthFits(subject.duration, episode.runtime, EPISODE_RUNTIME) : false;
      const confidence = !episode ? 0.3 : fits === false ? Math.min(score, 0.6) : 0.85 + 0.1 * score;
      candidates.push({
        id: `tv/${record.id}`, kind: "episode", title: record.name, year, season: want.season, episode: want.episode,
        ...(episode?.name ? { episodeTitle: episode.name } : {}),
        confidence: round(confidence), ids: { tmdb: `tv/${record.id}` },
      });
    }
    return candidates.sort((a, b) => b.confidence - a.confidence);
  }

  const people = (credits, aggregate = false) => {
    const cast = (credits?.cast ?? []).slice(0, MAX_CAST).map((person) => ({
      name: person.name,
      role: "cast",
      character: aggregate ? person.roles?.[0]?.character : person.character,
      photo: image(person.profile_path, "w185"),
    }));
    const crew = (credits?.crew ?? []).filter((person) => ["Director", "Creator", "Writer"].includes(person.job ?? person.jobs?.[0]?.job))
      .slice(0, 4).map((person) => ({ name: person.name, role: (person.job ?? person.jobs?.[0]?.job).toLowerCase(), photo: image(person.profile_path, "w185") }));
    return [...cast, ...crew];
  };
  const rating = (value) => (Number(value) > 0 ? [{ value: Number(value), max: 10, source: "audience" }] : []);

  async function lookup(candidate, { language }) {
    const [kind, id] = String(candidate.id).split("/");
    const query = { language: lang(language) };
    if (kind === "movie") {
      const movie = await tmdb.get(`/movie/${id}`, { ...query, append_to_response: "credits,external_ids" });
      if (!movie) return {};
      return {
        kind: "movie", title: movie.title, description: movie.overview, date: movie.release_date, year: yearOf(movie.release_date),
        people: people(movie.credits), genres: (movie.genres ?? []).map((genre) => genre.name), ratings: rating(movie.vote_average),
        poster: image(movie.poster_path, "w342"), backdrop: image(movie.backdrop_path, "w780"),
        ids: { tmdb: `movie/${id}`, ...(movie.imdb_id ? { imdb: movie.imdb_id } : {}) }, attribution: ATTRIBUTION,
      };
    }
    const show = await tmdb.get(`/tv/${id}`, { ...query, append_to_response: "aggregate_credits,external_ids" });
    if (!show) return {};
    const about = {
      show: { title: show.name, description: show.overview, year: yearOf(show.first_air_date), poster: image(show.poster_path, "w342") },
      genres: (show.genres ?? []).map((genre) => genre.name),
      poster: image(show.poster_path, "w342"),
      backdrop: image(show.backdrop_path, "w780"),
      ids: { tmdb: `tv/${id}`, ...(show.external_ids?.imdb_id ? { imdb: show.external_ids.imdb_id } : {}) },
      attribution: ATTRIBUTION,
    };
    if (candidate.season == null || candidate.episode == null) {
      return { kind: "show", title: show.name, description: show.overview, date: show.first_air_date, year: yearOf(show.first_air_date), people: people(show.aggregate_credits, true), ratings: rating(show.vote_average), ...about };
    }
    const episode = await tmdb.get(`/tv/${id}/season/${candidate.season}/episode/${candidate.episode}`, { ...query, append_to_response: "credits" });
    if (!episode) return { kind: "episode", series: { title: show.name, season: candidate.season, episode: candidate.episode }, ...about };
    const guests = (episode.credits?.guest_stars ?? []).slice(0, 4).map((person) => ({ name: person.name, role: "guest", character: person.character, photo: image(person.profile_path, "w185") }));
    return {
      kind: "episode",
      title: episode.name,
      description: episode.overview || show.overview,
      date: episode.air_date,
      year: yearOf(episode.air_date),
      series: { title: show.name, season: candidate.season, episode: candidate.episode, episodeTitle: episode.name },
      people: [...people(show.aggregate_credits, true), ...guests],
      ratings: rating(episode.vote_average),
      still: image(episode.still_path, "w300"),
      ...about,
    };
  }

  return {
    identify,
    lookup,
    async search(query, { kind = null, year = null, language, limit = 10 }) {
      if (!tmdb.configured) return [];
      const kinds = kind === "movie" ? ["movie"] : kind === "show" ? ["tv"] : ["tv", "movie"];
      const out = [];
      for (const type of kinds) {
        const found = await tmdb.get(`/search/${type}`, { query, language: lang(language), ...(year ? { [type === "movie" ? "year" : "first_air_date_year"]: year } : {}) });
        for (const record of (found?.results ?? []).slice(0, limit)) {
          out.push({ id: `${type}/${record.id}`, kind: type === "movie" ? "movie" : "show", title: record.title ?? record.name, year: yearOf(record.release_date ?? record.first_air_date), confidence: round(0.5 + 0.4 * nameScore([query], record)) });
        }
      }
      return out.slice(0, limit);
    },
    health: () => (tmdb.configured
      ? { configured: true }
      : { configured: false, reason: "No TMDB key: register a free one at https://www.themoviedb.org/settings/api and set TMDB_API_KEY" }),
  };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function tmdbMetadata(yolo) {
  yolo.registerMetadata("tmdb", createTmdbMetadata({
    key: yolo.options.apiKey ?? yolo.env.TMDB_API_KEY ?? null,
    fetch: yolo.fetch,
    language: yolo.options.language ?? null,
    cacheDir: yolo.cacheDir,
  }));
}
