import { createJsonClient, lengthFits, nameConfidence, nameScore, round, wanted, yearOf } from "./fetch-json.js";

// Official metadata plugin: Wikidata and Wikipedia, with no key (Agent Note
// 2026-10-25-metadata-plugins). Wikidata knows films and shows by their
// names in every language (救援高手 is Nathan for You) and holds the ids
// other databases use, which it passes on to the metadata plugins after it;
// Wikipedia gives the synopsis and a picture in the owner's language. It
// describes a whole film, and only the show around an episode: the episode
// itself is for an episode database, such as TVmaze.
//
// Options (yolo.config.json): language, such as "zh-CN"; else
// YOLO_METADATA_LANGUAGE, else English.

const WIKIDATA = "https://www.wikidata.org/w/api.php";
const FILMS = new Set(["Q11424", "Q24862", "Q506240", "Q202866", "Q1261214", "Q17123180", "Q229390", "Q93204", "Q130232"]);
const SHOWS = new Set(["Q5398426", "Q581714", "Q63952888", "Q1259759", "Q526877", "Q15416", "Q117467246", "Q21191270", "Q1366112", "Q7725310"]);
// Properties: instance of, publication date, start time, duration, cast,
// director, genre, image, and the ids of other databases.
const P = Object.freeze({
  instance: "P31", published: "P577", started: "P580", duration: "P2047", cast: "P161", director: "P57", genre: "P136", image: "P18",
  imdb: "P345", tmdbMovie: "P4947", tmdbShow: "P4983", tvmaze: "P8600", bangumi: "P5732", douban: "P4529",
});
const MAX_PEOPLE = 12;
const FILM_RUNTIME = 0.25;

// "zh-CN" → { wiki: "zh", variant: "zh-cn", labels: ["zh-cn", "zh-hans", "zh", "en"] };
// "en" → { wiki: "en", variant: null, labels: ["en"] }. Labels are tried in order.
export function languageOf(tag) {
  const [base, region] = String(tag || "en").split("-");
  const wiki = base.toLowerCase();
  const traditional = /^(TW|HK|MO|Hant)$/i.test(region ?? "");
  const variant = wiki === "zh" ? (traditional ? "zh-tw" : "zh-cn") : null;
  const labels = wiki === "zh" ? [variant, traditional ? "zh-hant" : "zh-hans", "zh", "en"] : [...new Set([wiki, "en"])];
  return { wiki, variant, labels };
}

const values = (entity, property) => (entity?.claims?.[property] ?? []).map((claim) => claim.mainsnak?.datavalue?.value).filter((value) => value !== undefined);
const firstString = (entity, property) => values(entity, property).find((value) => typeof value === "string") ?? null;
const ids = (entity) => values(entity, P.instance).map((value) => value.id);
const label = (entity, languages) => {
  for (const code of languages.labels) if (entity?.labels?.[code]?.value) return entity.labels[code].value;
  return null;
};
const commons = (file, width) => (file ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}` : null);

// The ids other databases know a work by, under the names their plugins use.
export function externalIds(entity, kind) {
  const out = { wikidata: entity.id };
  const imdb = firstString(entity, P.imdb);
  if (imdb) out.imdb = imdb;
  const tmdb = firstString(entity, kind === "movie" ? P.tmdbMovie : P.tmdbShow);
  if (tmdb) out.tmdb = `${kind === "movie" ? "movie" : "tv"}/${tmdb}`;
  for (const name of ["tvmaze", "bangumi", "douban"]) {
    const value = firstString(entity, P[name]);
    if (value) out[name] = value;
  }
  return out;
}

export function createWikimediaMetadata({ fetch, cacheDir = null, language: preferred = null } = {}) {
  const getJson = createJsonClient({ name: "Wikimedia", fetch, cacheDir });
  const lang = (language) => languageOf(preferred || language);
  const wikidata = (params) => getJson(`${WIKIDATA}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`);

  async function entities(list, languages) {
    const out = {};
    for (let at = 0; at < list.length; at += 50) {
      const found = await wikidata({ action: "wbgetentities", ids: list.slice(at, at + 50).join("|"), props: "labels|aliases|claims|sitelinks", languages: languages.labels.join("|") });
      Object.assign(out, found?.entities ?? {});
    }
    return out;
  }

  // The work an external id names, through Wikidata's statement search.
  async function byExternalId(known) {
    if (known.wikidata) return known.wikidata;
    const statements = [
      known.imdb ? `${P.imdb}=${known.imdb}` : null,
      known.tvmaze ? `${P.tvmaze}=${known.tvmaze}` : null,
      known.tmdb?.startsWith("movie/") ? `${P.tmdbMovie}=${known.tmdb.slice(6)}` : null,
      known.tmdb?.startsWith("tv/") ? `${P.tmdbShow}=${known.tmdb.slice(3)}` : null,
    ].filter(Boolean);
    for (const statement of statements) {
      const found = await wikidata({ action: "query", list: "search", srsearch: `haswbstatement:${statement}`, srlimit: "1" });
      const title = found?.query?.search?.[0]?.title;
      if (title) return title;
    }
    return null;
  }

  async function identify(subject, { language }) {
    const languages = lang(language);
    const { wiki } = languages;
    const want = wanted(subject);
    const known = await byExternalId(subject.ids ?? {});
    if (known) {
      const entity = (await entities([known], languages))[known];
      if (!entity) return [];
      const kind = ids(entity).some((id) => FILMS.has(id)) ? "movie" : "episode";
      return [{
        id: entity.id, kind, title: label(entity, languages), year: yearOf(values(entity, P.published)[0]?.time ?? values(entity, P.started)[0]?.time),
        ...(kind === "episode" && want.season != null ? { season: want.season, episode: want.episode } : {}),
        confidence: 1, ids: externalIds(entity, kind),
      }];
    }
    if (!want.names.length || (want.kind === "episode" && (want.season == null || want.episode == null))) return [];
    const found = new Set();
    for (const name of want.names.slice(0, 3)) {
      for (const searchLanguage of [...new Set([wiki, "en"])]) {
        const result = await wikidata({ action: "wbsearchentities", search: name, language: searchLanguage, uselang: searchLanguage, type: "item", limit: "5" });
        for (const entry of result?.search ?? []) found.add(entry.id);
      }
    }
    if (!found.size) return [];
    const all = await entities([...found], languages);
    const classes = want.kind === "movie" ? FILMS : SHOWS;
    const candidates = [];
    for (const entity of Object.values(all)) {
      if (!ids(entity).some((id) => classes.has(id))) continue;
      const names = [
        ...Object.values(entity.labels ?? {}).map((entry) => entry.value),
        ...Object.values(entity.aliases ?? {}).flat().map((entry) => entry.value),
      ];
      let score = nameScore(want.names, names);
      if (score < 0.75) continue;
      const year = yearOf(values(entity, P.published)[0]?.time ?? values(entity, P.started)[0]?.time);
      if (want.year && year) score += year === want.year ? 0.05 : -0.25;
      if (want.kind === "movie") {
        const minutes = Number(values(entity, P.duration)[0]?.amount);
        if (lengthFits(subject.duration, minutes, FILM_RUNTIME) === false) score = Math.min(score, 0.5);
      }
      candidates.push({
        id: entity.id, kind: want.kind, title: label(entity, languages), ...(year ? { year } : {}),
        ...(want.kind === "episode" ? { season: want.season, episode: want.episode } : {}),
        confidence: round(nameConfidence(score)), ids: externalIds(entity, want.kind),
      });
    }
    return candidates.sort((a, b) => b.confidence - a.confidence);
  }

  // The Wikipedia article's summary in the owner's language, else English.
  async function summary(entity, { wiki, variant }) {
    for (const site of [...new Set([wiki, "en"])]) {
      const title = entity.sitelinks?.[`${site}wiki`]?.title;
      if (!title) continue;
      const page = await getJson(`https://${site}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, {
        headers: site === wiki && variant ? { "accept-language": variant } : {},
      });
      if (page?.extract) return { text: page.extract, picture: page.thumbnail?.source ?? null, url: page.content_urls?.desktop?.page ?? null };
    }
    return null;
  }

  async function lookup(candidate, { language }) {
    const languages = lang(language);
    const entity = (await entities([candidate.id], languages))[candidate.id];
    if (!entity) return {};
    const kind = candidate.kind === "movie" ? "movie" : "episode";
    const title = label(entity, languages);
    const about = await summary(entity, languages);
    const date = (values(entity, P.published)[0] ?? values(entity, P.started)[0])?.time?.replace(/^\+/, "").slice(0, 10) ?? null;
    const castIds = values(entity, P.cast).map((value) => value.id).slice(0, MAX_PEOPLE);
    const directorIds = values(entity, P.director).map((value) => value.id).slice(0, 3);
    const genreIds = values(entity, P.genre).map((value) => value.id).slice(0, 5);
    const named = await entities([...castIds, ...directorIds, ...genreIds], languages);
    const person = (id, role) => (named[id] ? { name: label(named[id], languages), role, photo: commons(firstString(named[id], P.image), 185) } : null);
    const genres = genreIds.map((id) => label(named[id], languages)).filter(Boolean);
    const poster = about?.picture ?? commons(firstString(entity, P.image), 342);
    const attribution = {
      text: "Descriptions from Wikipedia under CC BY-SA 4.0; data from Wikidata.",
      ...(about?.url ? { url: about.url } : { url: `https://www.wikidata.org/wiki/${entity.id}` }),
    };
    if (kind === "movie") {
      return {
        kind, title, description: about?.text, date, year: yearOf(date),
        people: [...castIds.map((id) => person(id, "cast")), ...directorIds.map((id) => person(id, "director"))].filter(Boolean),
        genres, poster, ids: externalIds(entity, kind), attribution,
      };
    }
    // An episode: the show around it, and nothing of the episode's own.
    return {
      kind,
      series: { title, season: candidate.season, episode: candidate.episode },
      show: { title, description: about?.text, year: yearOf(date), poster },
      genres,
      poster,
      ids: externalIds(entity, "show"),
      attribution,
    };
  }

  async function search(query, { kind = null, language, limit = 10 }) {
    const languages = lang(language);
    const { wiki } = languages;
    const result = await wikidata({ action: "wbsearchentities", search: query, language: wiki, uselang: wiki, type: "item", limit: String(Math.min(limit * 2, 20)) });
    const all = await entities((result?.search ?? []).map((entry) => entry.id), languages);
    const out = [];
    for (const entity of Object.values(all)) {
      const film = ids(entity).some((id) => FILMS.has(id));
      const show = ids(entity).some((id) => SHOWS.has(id));
      if (!(film || show) || (kind === "movie" && !film) || (kind === "show" && !show)) continue;
      out.push({ id: entity.id, kind: film ? "movie" : "show", title: label(entity, languages), year: yearOf(values(entity, P.published)[0]?.time ?? values(entity, P.started)[0]?.time), confidence: 0.5 });
    }
    return out.slice(0, limit);
  }

  return { identify, lookup, search };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function wikimediaMetadata(yolo) {
  yolo.registerMetadata("wikimedia", createWikimediaMetadata({ fetch: yolo.fetch, language: yolo.options.language ?? null, cacheDir: yolo.cacheDir }));
}
