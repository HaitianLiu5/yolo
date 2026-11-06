import { LANGUAGE_COOKIE, languageFromTags } from "@useyolo/core";
import zhHans from "./locales/zh-Hans.js";
import { readCookie } from "./session.js";

// The language of the owner's pages (Agent Note 2026-10-26-player-language):
// English, or Simplified Chinese. These pages are often the first thing a
// phone opens after scanning a QR code, so they follow the browser's
// Accept-Language; a browser whose player has a language chosen says so in a
// cookie, which wins, as the choice does in the player.
//
// As in the player the English text is the key, a missing entry shows English,
// and a value goes in by name. The server answers many requests at once, so
// the language is never kept in the module: a request gets its own `t`, from
// `pageWords`, and passes it to the page.

const CATALOGS = { "zh-Hans": zhHans };

// An Accept-Language header's tags, most preferred first, without those it
// refuses (q=0). Tags of equal weight stay in the order they were written.
function acceptedTags(header) {
  return String(header ?? "").split(",").map((part) => {
    const [tag, ...parameters] = part.split(";");
    const weight = parameters.map((parameter) => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(parameter)?.[1]).find(Boolean);
    return { tag: tag.trim(), q: weight === undefined ? 1 : Number(weight) };
  }).filter(({ tag, q }) => tag && q > 0).sort((a, b) => b.q - a.q).map(({ tag }) => tag);
}

// A cookie this browser's player wrote, or anything else sent under its name.
function chosenLanguage(request) {
  let chosen = null;
  try {
    chosen = readCookie(request.headers.get("cookie"), LANGUAGE_COOKIE);
  } catch {
    // Not percent-encoded properly: no choice.
  }
  return chosen === "en" || Object.hasOwn(CATALOGS, String(chosen)) ? chosen : null;
}

/** The language a request's page shows: "en" or "zh-Hans". */
export function pageLanguage(request) {
  return chosenLanguage(request) ?? languageFromTags(acceptedTags(request.headers.get("accept-language")));
}

/** `t(text, values)` in `language`; `t.language` says which it is. */
export function wordsIn(language) {
  const catalog = CATALOGS[language];
  const t = (text, values = null) => {
    const found = catalog?.[text] ?? text;
    return values ? found.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole)) : found;
  };
  t.language = language;
  return t;
}

/** The words for the page that answers `request`. */
export const pageWords = (request) => wordsIn(pageLanguage(request));

/** A plugin's own text, plain or by language (`{ en, zh }`), in `language`. */
export function localizedText(value, language) {
  if (!value || typeof value !== "object") return value ?? "";
  return value[language.split("-")[0]] ?? value.en ?? Object.values(value)[0] ?? "";
}
