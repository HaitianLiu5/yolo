// Kodi-style NFO files (movie.nfo, tvshow.nfo, <name>.nfo): the owner's own
// description of a file, read as plain XML. Only the elements Yolo shows are
// read; anything else, and any markup inside them, is ignored.

const ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" });

const decode = (text) => text
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  })
  .replace(/<[^>]*>/g, "")
  .trim();

// Every <name …>text</name> directly in `xml`'s text, decoded.
function all(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi"))].map((match) => ({ attributes: match[1] ?? "", text: match[2] }));
}

const first = (xml, name) => {
  const [element] = all(xml, name);
  const value = element ? decode(element.text) : "";
  return value || null;
};
const number = (xml, name) => {
  const value = Number(first(xml, name));
  return Number.isFinite(value) && value >= 0 ? value : null;
};
const attribute = (attributes, name) => new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(attributes)?.[1] ?? null;

/**
 * An NFO's root element and what it says: { root, title, originalTitle,
 * showTitle, season, episode, year, date, plot, genres, studio,
 * contentRating, rating, ids, actors: [{ name, role, thumb, order }],
 * directors, writers }, or null when it is not one.
 */
export function parseNfo(text) {
  const xml = String(text ?? "");
  const root = /<(movie|tvshow|episodedetails|musicvideo)[\s>]/i.exec(xml)?.[1]?.toLowerCase();
  if (!root) return null;
  const ids = {};
  for (const { attributes, text: value } of all(xml, "uniqueid")) {
    const type = attribute(attributes, "type")?.toLowerCase();
    const id = decode(value);
    if (type && /^(tmdb|imdb|tvdb)$/.test(type) && id) ids[type] = id;
  }
  const legacy = first(xml, "imdbid") ?? first(xml, "id");
  if (!ids.imdb && legacy && /^tt\d+$/.test(legacy)) ids.imdb = legacy;
  const actors = all(xml, "actor").map(({ text: inner }, index) => ({
    name: first(inner, "name"),
    role: first(inner, "role"),
    thumb: first(inner, "thumb"),
    order: number(inner, "order") ?? index,
  })).filter((actor) => actor.name).sort((a, b) => a.order - b.order);
  const date = first(xml, "premiered") ?? first(xml, "aired") ?? first(xml, "releasedate");
  return {
    root,
    title: first(xml, "title"),
    originalTitle: first(xml, "originaltitle"),
    showTitle: first(xml, "showtitle"),
    season: number(xml, "season"),
    episode: number(xml, "episode"),
    year: number(xml, "year") ?? (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null),
    date,
    plot: first(xml, "plot") ?? first(xml, "outline"),
    genres: all(xml, "genre").map(({ text: value }) => decode(value)).filter(Boolean),
    studio: first(xml, "studio"),
    contentRating: first(xml, "mpaa"),
    rating: number(xml, "rating"),
    ids,
    actors,
    directors: all(xml, "director").map(({ text: value }) => decode(value)).filter(Boolean),
    writers: all(xml, "credits").map(({ text: value }) => decode(value)).filter(Boolean),
  };
}
