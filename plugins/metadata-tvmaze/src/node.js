import { createJsonClient, lengthFits, nameConfidence, nameScore, round, stripHtml, wanted, yearOf } from "./fetch-json.js";

// Official metadata plugin: TVmaze, with no key (Agent Note
// 2026-10-25-metadata-plugins). It confirms an episode the model or the
// title parser named, checking that the season has it and that its runtime
// fits the item, and describes it: the episode's title, synopsis, and still,
// the show's poster, and the cast with photos. It knows TV, not films, and
// writes in English. TVmaze's data is CC BY-SA, so its details carry the
// notice.

const API = "https://api.tvmaze.com";
const EPISODE_RUNTIME = 0.15;
const MAX_CAST = 12;
const ATTRIBUTION_TEXT = "TV data from TVmaze under CC BY-SA 4.0.";

export function createTvmazeMetadata({ fetch, cacheDir = null } = {}) {
  const getJson = createJsonClient({ name: "TVmaze", fetch, cacheDir });
  const episodeOf = (show, season, episode) => getJson(`${API}/shows/${show}/episodebynumber?${new URLSearchParams({ season: String(season), number: String(episode) })}`);

  // The show an external id names: TVmaze's own, or IMDb's or TheTVDB's.
  async function knownShow(ids) {
    if (/^\d+$/.test(ids.tvmaze ?? "")) return getJson(`${API}/shows/${ids.tvmaze}`);
    if (/^tt\d+$/.test(ids.imdb ?? "")) return getJson(`${API}/lookup/shows?imdb=${ids.imdb}`);
    if (/^\d+$/.test(ids.tvdb ?? "")) return getJson(`${API}/lookup/shows?thetvdb=${ids.tvdb}`);
    return null;
  }

  const candidate = (show, want, episode, confidence) => ({
    id: String(show.id), kind: "episode", title: show.name, ...(yearOf(show.premiered) ? { year: yearOf(show.premiered) } : {}),
    season: want.season, episode: want.episode, ...(episode?.name ? { episodeTitle: episode.name } : {}),
    confidence, ids: { tvmaze: String(show.id), ...(show.externals?.imdb ? { imdb: show.externals.imdb } : {}) },
  });

  async function identify(subject) {
    const want = wanted(subject);
    if (want.kind !== "episode" || want.season == null || want.episode == null) return [];
    const known = await knownShow(subject.ids ?? {});
    if (known) {
      const episode = await episodeOf(known.id, want.season, want.episode);
      // The id is certain; an episode it does not have, or a copy far off its runtime, is not.
      const fits = episode ? lengthFits(subject.duration, episode.runtime, EPISODE_RUNTIME) : false;
      return [candidate(known, want, episode, !episode ? 0.3 : fits === false ? 0.6 : 1)];
    }
    if (!want.names.length) return [];
    const shows = new Map();
    for (const name of want.names.slice(0, 3)) {
      for (const { show } of (await getJson(`${API}/search/shows?q=${encodeURIComponent(name)}`)) ?? []) {
        if (!shows.has(show.id)) shows.set(show.id, show);
      }
    }
    const scored = [...shows.values()].map((show) => {
      let score = nameScore(want.names, [show.name]);
      const year = yearOf(show.premiered);
      if (want.year && year) score += year === want.year ? 0.05 : -0.25;
      return { show, score };
    }).filter(({ score }) => score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 3);
    const candidates = [];
    for (const { show, score } of scored) {
      const episode = await episodeOf(show.id, want.season, want.episode);
      const fits = episode ? lengthFits(subject.duration, episode.runtime, EPISODE_RUNTIME) : false;
      candidates.push(candidate(show, want, episode, round(!episode ? 0.3 : fits === false ? Math.min(score, 0.6) : nameConfidence(score))));
    }
    return candidates.sort((a, b) => b.confidence - a.confidence);
  }

  async function lookup(found) {
    const show = await getJson(`${API}/shows/${encodeURIComponent(found.id)}?embed=cast`);
    if (!show) return {};
    const people = (show._embedded?.cast ?? []).slice(0, MAX_CAST).map(({ person, character }) => ({
      name: person.name, role: "cast", character: character?.name, photo: person.image?.medium ?? null,
    }));
    const about = {
      show: { title: show.name, description: stripHtml(show.summary), year: yearOf(show.premiered), poster: show.image?.medium ?? null },
      people,
      genres: show.genres ?? [],
      ratings: show.rating?.average ? [{ value: show.rating.average, max: 10, source: "audience" }] : [],
      poster: show.image?.medium ?? null,
      ids: { tvmaze: String(show.id), ...(show.externals?.imdb ? { imdb: show.externals.imdb } : {}), ...(show.externals?.thetvdb ? { tvdb: String(show.externals.thetvdb) } : {}) },
      attribution: { text: ATTRIBUTION_TEXT, url: show.url ?? "https://www.tvmaze.com/" },
    };
    const episode = found.season != null && found.episode != null ? await episodeOf(show.id, found.season, found.episode) : null;
    if (!episode) return { kind: "episode", series: { title: show.name, season: found.season, episode: found.episode }, ...about };
    return {
      kind: "episode",
      title: episode.name,
      description: stripHtml(episode.summary) ?? stripHtml(show.summary),
      date: episode.airdate,
      year: yearOf(episode.airdate),
      series: { title: show.name, season: found.season, episode: found.episode, episodeTitle: episode.name },
      still: episode.image?.medium ?? null,
      ...about,
    };
  }

  async function search(query, { kind = null, limit = 10 }) {
    if (kind === "movie") return [];
    const found = (await getJson(`${API}/search/shows?q=${encodeURIComponent(query)}`)) ?? [];
    return found.slice(0, limit).map(({ show, score }) => ({
      id: String(show.id), kind: "show", title: show.name, ...(yearOf(show.premiered) ? { year: yearOf(show.premiered) } : {}), confidence: round(Math.min(1, Number(score) || 0)),
    }));
  }

  return { identify, lookup, search };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function tvmazeMetadata(yolo) {
  yolo.registerMetadata("tvmaze", createTvmazeMetadata({ fetch: yolo.fetch, cacheDir: yolo.cacheDir }));
}
