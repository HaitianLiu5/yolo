// What a video's title says about the work it is a copy of
// (Agent Note 2026-10-25-metadata-plugins, "Title hints"): the show or film's
// names, the season, the episode, the year, and the tags around them. It
// knows release-name and upload conventions, never providers. It is not the
// matcher: a model gets its reading as a hint, and without a model the
// metadata plugins search by it.

const CHINESE_DIGITS = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });

/** A number written in digits or in Chinese numerals up to 999, else null. */
export function chineseNumber(text) {
  const value = String(text ?? "").trim();
  if (/^\d+$/.test(value)) return Number(value);
  if (!/^[零〇一二两三四五六七八九十百]+$/.test(value)) return null;
  let total = 0;
  let digit = null;
  for (const char of value) {
    if (char === "百") {
      total += (digit ?? 1) * 100;
      digit = null;
    } else if (char === "十") {
      total += (digit ?? 1) * 10;
      digit = null;
    } else {
      digit = CHINESE_DIGITS[char];
    }
  }
  return total + (digit ?? 0);
}

const NUMERAL = "[0-9零〇一二两三四五六七八九十百]+";
// Where a release name's technical part begins: the title ends before it.
const RELEASE_TAG = /^(?:\d{3,4}[pi]|[248]k|uhd|hdr(?:10)?|dv|web(?:-?dl|-?rip)?|hdtv|bluray|blu-ray|bd(?:rip)?|dvd(?:rip)?|remux|x26[45]|h\.?26[45]|hevc|avc|aac(?:2\.0)?|ac3|dts|ddp?5\.1|flac|10bit|8bit|proper|repack|complete|nf|amzn|dsnp|hmax|atvp)$/i;
const EPISODE_KINDS = /^(?:美剧|日剧|韩剧|英剧|泰剧|国产剧|剧集|电视剧|番剧|动漫|新番|tv|series|anime)$/i;
const MOVIE_KINDS = /^(?:电影|movie|film)$/i;
const SEPARATORS = /\s*(?:\/|\||｜|\s[-–—－]\s|－|—)\s*/;

const clean = (text) => text.replace(/[_]+/g, " ").replace(/\s+/g, " ").replace(/^[\s\-–—－:：·.,，]+|[\s\-–—－:：·.,，]+$/g, "").trim();

function addTitle(list, value) {
  const title = clean(value);
  if (!title || /^\d{1,3}$/.test(title) || title.length > 120) return;
  if (!list.some((other) => other.toLowerCase() === title.toLowerCase())) list.push(title);
}

/**
 * The reading of one title: { titles, season, episode, part, year, kind,
 * agree, tags }. `titles` are the work's names it found, the release name's
 * first; `season`, `episode`, and `part` (a Bilibili part, `p08`) are numbers
 * or null; `agree` lists the markers that say the same season and episode;
 * `kind` is "episode", "movie", or null; `tags` are the bracketed and
 * technical tags, kept apart from the names.
 */
export function parseReleaseTitle(input) {
  let text = String(input ?? "").replace(/\s+/g, " ").trim();
  const tags = [];
  let kind = null;
  let year = null;
  const weak = [];

  // Bracketed tags: kept apart; a year or a bare number reads as one.
  text = text.replace(/【([^】]*)】|\[([^\]]*)\]/g, (whole, a, b) => {
    const inner = clean(a ?? b ?? "");
    if (/^(19|20)\d{2}$/.test(inner)) year ??= Number(inner);
    else if (/^\d{1,3}$/.test(inner)) weak.push({ episode: Number(inner), marker: whole });
    else if (inner) {
      tags.push(inner);
      if (EPISODE_KINDS.test(inner)) kind ??= "episode";
      if (MOVIE_KINDS.test(inner)) kind ??= "movie";
    }
    return " ";
  }).replace(/\s+/g, " ").trim();

  let season = null;
  let episode = null;
  const agree = [];
  const note = (marker, values) => {
    if (values.season != null && season == null) season = values.season;
    if (values.episode != null && episode == null) episode = values.episode;
    agree.push(marker);
  };
  const strongAt = [];

  // S01E08, s1e8, S01 E08, S01E08-E09 (the first), 1x08.
  for (const match of text.matchAll(/(^|[^A-Za-z0-9])(S(\d{1,2}) ?E(\d{1,3})(?:-?E\d{1,3})?)(?=$|[^A-Za-z0-9])/gi)) {
    note(match[2], { season: Number(match[3]), episode: Number(match[4]) });
    strongAt.push(match.index + match[1].length);
  }
  for (const match of text.matchAll(/(^|[^A-Za-z0-9])((\d{1,2})x(\d{2,3}))(?=$|[^A-Za-z0-9])/g)) {
    note(match[2], { season: Number(match[3]), episode: Number(match[4]) });
    strongAt.push(match.index + match[1].length);
  }
  // Season 1, S01 alone, 第一季.
  for (const match of text.matchAll(/(^|[^A-Za-z0-9])((?:Season|Series) ?(\d{1,2}))(?=$|[^A-Za-z0-9])/gi)) {
    note(match[2], { season: Number(match[3]) });
    strongAt.push(match.index + match[1].length);
  }
  for (const match of text.matchAll(/(^|[^A-Za-z0-9])(S(\d{1,2}))(?=$|[^A-Za-z0-9E])/g)) {
    note(match[2], { season: Number(match[3]) });
    strongAt.push(match.index + match[1].length);
  }
  for (const match of text.matchAll(new RegExp(`第(${NUMERAL})季`, "g"))) {
    note(match[0], { season: chineseNumber(match[1]) });
    strongAt.push(match.index);
  }
  // 第8集, 第八话, 第8話, EP08, E08, Episode 8.
  for (const match of text.matchAll(new RegExp(`第(${NUMERAL})[集话話回]`, "g"))) {
    note(match[0], { episode: chineseNumber(match[1]) });
    strongAt.push(match.index);
  }
  for (const match of text.matchAll(/(^|[^A-Za-z0-9])((?:EP|E|Episode ?)(\d{1,3}))(?=$|[^A-Za-z0-9])/gi)) {
    if (/^S\d/i.test(text.slice(Math.max(0, match.index - 3), match.index + 1))) continue;
    note(match[2], { episode: Number(match[3]) });
    strongAt.push(match.index + match[1].length);
  }

  // Weak episode markers: a Bilibili part, a fansub number.
  let part = null;
  for (const match of text.matchAll(/(^|[\s_\-])([pP](\d{1,3}))(?=$|[\s_\-.])/g)) {
    part ??= Number(match[3]);
    weak.unshift({ episode: Number(match[3]), marker: match[2] });
  }
  for (const match of text.matchAll(/\S( \- (\d{2,3}))(?=$|\s)/g)) {
    weak.push({ episode: Number(match[2]), marker: `- ${match[2]}` });
    strongAt.push(match.index + 1);
  }
  for (const { episode: number, marker } of weak) {
    if (episode == null && !agree.some((entry) => /[Ee]\d|集|话|話|回/.test(entry))) {
      episode = number;
      agree.push(marker);
    } else if (number === episode) {
      agree.push(marker);
    }
  }

  // The year: (2013), .2013., or alone, when it is not the title itself;
  // one in parentheses first, else the last (a film may be named 2012).
  const years = [...text.matchAll(/(?:^|[\s.(])((?:19|20)\d{2})(?=$|[\s.)])/g)];
  const yearMatch = years.find((match) => text[match.index] === "(") ?? (years.length > 1 || years[0]?.index > 0 ? years.at(-1) : null);
  if (yearMatch && year == null) year = Number(yearMatch[1]);

  // Names: a dotted release name's words before its markers, the text
  // before the first strong marker, split where a name meets its translation.
  const titles = [];
  for (const match of text.matchAll(/(?:^|\s)([^\s]+?)\.(?:S\d{1,2}(?:E\d{1,3})?|(?:19|20)\d{2})(?=[.\s]|$)/gi)) {
    const words = match[1].split(".");
    if (words.length > 1 || /^[A-Za-z]/.test(words[0])) {
      // A dotted name may follow a translation glued on without a space.
      const latin = words.filter((word) => /^[A-Za-z0-9'&!,+-]+$/.test(word));
      if (latin.length) addTitle(titles, latin.join(" "));
      const rest = words.filter((word) => !/^[A-Za-z0-9'&!,+-]+$/.test(word)).join(" ");
      if (rest) addTitle(titles, rest);
    }
  }
  const head = strongAt.length ? text.slice(0, Math.min(...strongAt)) : text;
  let plain = head.replace(/(^|\s)[pP]\d{1,3}(?=$|\s)/g, " ");
  const words = plain.split(/[\s.]+/);
  const technical = words.findIndex((word) => RELEASE_TAG.test(word));
  if (technical > 0) plain = words.slice(0, technical).join(" ");
  if (year != null) plain = plain.replace(new RegExp(`\\(?\\b${year}\\b\\)?`), "");
  plain = plain.replace(/\([^)]*\)/g, " ");
  for (const name of plain.split(SEPARATORS)) addTitle(titles, name.includes(".") && !/\s/.test(name) ? name.replace(/\./g, " ") : name);
  // Markers first, the name after them: what is left once they are gone.
  if (!titles.length) {
    let rest = text;
    for (const marker of agree) rest = rest.replace(marker, " ");
    for (const name of rest.split(SEPARATORS)) addTitle(titles, name);
  }
  // Release tags after the names.
  for (const word of text.split(/[\s.\-]+/)) if (RELEASE_TAG.test(word) && !tags.includes(word)) tags.push(word);

  // The release name's words first: they spell the original title.
  titles.sort((a, b) => Number(/^[\x20-\x7e]+$/.test(b)) - Number(/^[\x20-\x7e]+$/.test(a)));
  if (season != null || episode != null) kind ??= "episode";
  return { titles, season, episode, part, year, kind, agree, tags };
}
