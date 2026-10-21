import { findActiveCues } from "./subtitle-cues.js";

// Track IDs (e.g. plex:80803) are identities, never valid language tags.
// Inspect each displayed line because a single ASS/VTT track can be bilingual.
export function subtitleLineLanguage(text, language = "") {
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[\uac00-\ud7af]/u.test(text)) return "ko";
  if (/\p{Script=Han}/u.test(text)) {
    if (/^(ja|jpn)$/i.test(language)) return "ja";
    if (/^(zh-(Hant|TW|HK)|yue)$/i.test(language)) return "zh-Hant";
    return "zh-Hans";
  }
  if (/\p{Script=Latin}/u.test(text)) return "en";
  return /^(en|zh(?:-(?:Hans|Hant|CN|TW|HK))?|ja|ko)$/i.test(language) ? language : "und";
}

const CJK_PUNCTUATION = /[\u3000-\u303f\uff00-\uffef]/u;
const CJK_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const DIALOGUE_DASH = /^[-\u2010\u2013\u2014]/u;

// Joins two lines in one language. No space where Chinese or Japanese
// characters meet each other or other punctuation, or where full-width
// punctuation meets anything; one space where such a character meets a
// letter of another script or a digit, before a speaker's dash, and
// everywhere else.
function joinSubtitleLine(left, right) {
  const last = Array.from(left).at(-1);
  const first = Array.from(right)[0];
  if (DIALOGUE_DASH.test(right)) return `${left} ${right}`;
  if (CJK_PUNCTUATION.test(last) || CJK_PUNCTUATION.test(first)) return left + right;
  if (CJK_LETTER.test(last) || CJK_LETTER.test(first)) {
    const other = CJK_LETTER.test(last) ? first : last;
    return /[\p{L}\p{N}]/u.test(other) && !CJK_LETTER.test(other) ? `${left} ${right}` : left + right;
  }
  return `${left} ${right}`;
}

/**
 * A cue's text as the lines the overlay shows (Agent Note
 * 2026-07-13-in-car-design-principles). A bilingual cue, with lines in two
 * or more languages told apart by script, shows one line per language: its
 * consecutive lines in one language join. A cue in one language keeps its
 * author's lines, which may be two speakers, or two languages that share a
 * script. A line without letters (a music note, an ellipsis) stays alone.
 */
export function subtitleDisplayLines(text, language = "") {
  const lines = String(text).split("\n").map((line) => line.trim()).filter(Boolean)
    .map((line) => ({ line, script: /\p{L}/u.test(line) ? subtitleLineLanguage(line, language) : null }));
  if (new Set(lines.map((entry) => entry.script).filter(Boolean)).size < 2) return lines.map((entry) => entry.line);
  const shown = [];
  let previous = null;
  for (const entry of lines) {
    if (previous?.script && previous.script === entry.script) {
      previous.line = joinSubtitleLine(previous.line, entry.line);
    } else {
      previous = { ...entry };
      shown.push(previous);
    }
  }
  return shown.map((entry) => entry.line);
}

// The smallest size a line shrinks to before it wraps, of the overlay's.
const SUBTITLE_FIT_FLOOR = 0.75;
// How full a wrapped row is assumed to be, since rows break between words.
const WRAPPED_ROW_FILL = 0.9;

/**
 * How one line fits the overlay: `width` is its width on one row at the
 * overlay's size, `available` the overlay's width. A line that fits keeps
 * its size; a wider one shrinks to fit on one row, down to
 * SUBTITLE_FIT_FLOOR; one wider still wraps (`wrap`) into the fewest rows
 * it fills at the floor, at the largest size that fills them.
 * Returns { scale, wrap }, the scale of the overlay's font size.
 */
export function subtitleLineFit(width, available) {
  if (!(width > 0) || !(available > 0) || width <= available) return { scale: 1, wrap: false };
  if (width * SUBTITLE_FIT_FLOOR <= available) return { scale: available / width, wrap: false };
  const rows = Math.max(2, Math.ceil((width * SUBTITLE_FIT_FLOOR) / (available * WRAPPED_ROW_FILL)));
  const scale = (rows * available * WRAPPED_ROW_FILL) / width;
  return { scale: Math.min(1, Math.max(SUBTITLE_FIT_FLOOR, scale)), wrap: true };
}

export function subtitlePictureBounds(width, height, videoWidth, videoHeight) {
  const scale = videoWidth > 0 && videoHeight > 0
    ? Math.min(width / videoWidth, height / videoHeight) : 1;
  const pictureWidth = videoWidth > 0 && videoHeight > 0 ? videoWidth * scale : width;
  const pictureHeight = videoWidth > 0 && videoHeight > 0 ? videoHeight * scale : height;
  return { width: pictureWidth, height: pictureHeight,
    bottom: (height - pictureHeight) / 2,
  };
}

export function activeSubtitleGroups(tracks, time) {
  const groups = [];
  for (const track of tracks) {
    const lines = [];
    const activeCues = findActiveCues(track, time);
    for (const cue of activeCues) {
      lines.push(...subtitleDisplayLines(cue.text, track.lang));
    }
    if (lines.length) groups.push({ lang: track.lang, lines });
  }
  return groups;
}
