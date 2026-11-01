import { basename, extname } from "node:path";

// Subtitle files beside a video (Agent Note 2026-10-26-folder-source): their
// text in whatever encoding they were saved in, and the language their name
// or their text says.

// Language tags a subtitle file's name carries ("Movie.chs.srt",
// "Movie.zh-Hans.ass", "Movie.简体.srt"), with the label a screen shows.
const NAMED = [
  [/^(?:chs|sc|gb|zh-?hans|zh-?cn|zh-?sg|简体|简中|简)$/i, "zh-Hans", "简体中文"],
  [/^(?:cht|tc|big5|zh-?hant|zh-?tw|zh-?hk|繁体|繁體|繁中|繁)$/i, "zh-Hant", "繁體中文"],
  [/^(?:chs&eng|chs\.eng|sc\.en|简英|简体&英文|中英|zh-en|chi_eng)$/i, "zh-Hans", "简英双语"],
  [/^(?:cht&eng|cht\.eng|tc\.en|繁英)$/i, "zh-Hant", "繁英双语"],
  [/^(?:zh|zho|chi|chinese|中文|中字)$/i, "zh", "中文"],
  [/^(?:en|eng|english|英文)$/i, "en", "English"],
  [/^(?:ja|jp|jpn|japanese|日文|日语)$/i, "ja", "日本語"],
  [/^(?:ko|kor|korean|韩文|韩语)$/i, "ko", "한국어"],
  [/^(?:fr|fre|fra|french)$/i, "fr", "Français"],
  [/^(?:de|ger|deu|german)$/i, "de", "Deutsch"],
  [/^(?:es|spa|spanish)$/i, "es", "Español"],
];

/** The language a subtitle file's name gives: { language, label } or null. */
export function languageOfName(name, video) {
  const base = basename(name, extname(name));
  const videoBase = basename(video, extname(video));
  const rest = base.toLowerCase().startsWith(videoBase.toLowerCase()) ? base.slice(videoBase.length) : base;
  const parts = rest.split(/[._\s\-[\]()]+/).filter(Boolean);
  // "chs&eng" and "chs.eng" are one tag.
  const joined = parts.join(".").toLowerCase();
  for (const candidate of [joined, ...parts.reverse()]) {
    const found = NAMED.find(([pattern]) => pattern.test(candidate));
    if (found) return { language: found[1], label: found[2] };
  }
  return null;
}

/** The language a subtitle's text is mostly in, when its name says none. */
export function languageOfText(text) {
  const sample = text.replace(/\{[^}]*\}|<[^>]*>|\d+:\d+:\d+[.,]\d+|-->|^\d+$/gm, "").slice(0, 20_000);
  const han = (sample.match(/\p{Script=Han}/gu) || []).length;
  const kana = (sample.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
  const hangul = (sample.match(/\p{Script=Hangul}/gu) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  if (kana > 20) return { language: "ja", label: "日本語" };
  if (hangul > 20) return { language: "ko", label: "한국어" };
  if (han > 20) return { language: "zh", label: latin > han ? "中英双语" : "中文" };
  if (latin > 50) return { language: "en", label: "English" };
  return null;
}

/**
 * A subtitle file's text: by its byte order mark, else UTF-8 when it reads
 * as UTF-8, else GB18030 or Big5, the encodings Chinese subtitles were most
 * often saved in, whichever reads with fewer unknown characters.
 */
export function decodeSubtitle(bytes, name = "") {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {}
  const traditional = /cht|big5|tc|繁/i.test(name);
  const candidates = (traditional ? ["big5", "gb18030"] : ["gb18030", "big5"]).map((encoding) => {
    const text = new TextDecoder(encoding).decode(bytes);
    // Unknown characters, and characters outside the common CJK block, count against an encoding.
    const bad = (text.match(/�/g) || []).length * 10 + (text.match(/[㐀-䶿-]/g) || []).length;
    return { text, bad };
  });
  candidates.sort((a, b) => a.bad - b.bad);
  return candidates[0].text;
}

/** The format ffmpeg reads a subtitle file as, by its extension. */
export const formatOf = (name) => ({ ".srt": "srt", ".ass": "ass", ".ssa": "ssa", ".vtt": "vtt" })[extname(name).toLowerCase()] ?? null;
