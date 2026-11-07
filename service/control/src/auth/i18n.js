import { LANGUAGE_COOKIE, languageFromTags } from "@useyolo/core";
import { readAccountLanguage } from "../store/language-settings.js";
import { getOwner } from "../store/users.js";
import zhHans from "./locales/zh-Hans.js";
import { readCookie } from "./session.js";

// The language of the owner's pages (Agent Note 2026-10-26-player-language):
// English, or Simplified Chinese, in the player's order. A browser whose
// player has a language chosen says so in a cookie; then comes the account's
// language (Agent Note 2026-11-06-account-language), and then the browser's
// Accept-Language, since these pages are often the first thing a phone opens
// after scanning a QR code.
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

// A language these pages show, or null for any other value.
const shown = (value) => (value === "en" || Object.hasOwn(CATALOGS, String(value)) ? value : null);

// A cookie this browser's player wrote, or anything else sent under its name.
function chosenLanguage(request) {
  try {
    return shown(readCookie(request.headers.get("cookie"), LANGUAGE_COOKIE));
  } catch {
    return null; // Not percent-encoded properly: no choice.
  }
}

// The owner's, since most of these pages come before any sign-in. A page
// never fails for it: a read that fails is no language.
async function accountLanguage(db) {
  try {
    const owner = await getOwner(db);
    return owner ? shown(await readAccountLanguage(db, owner.id)) : null;
  } catch {
    return null;
  }
}

/** The language a request's page shows: "en" or "zh-Hans". */
export async function pageLanguage(request, db) {
  return chosenLanguage(request) ?? await accountLanguage(db) ?? languageFromTags(acceptedTags(request.headers.get("accept-language")));
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
export const pageWords = async (request, db) => wordsIn(await pageLanguage(request, db));

/** A plugin's own text, plain or by language (`{ en, zh }`), in `language`. */
export function localizedText(value, language) {
  if (!value || typeof value !== "object") return value ?? "";
  return value[language.split("-")[0]] ?? value.en ?? Object.values(value)[0] ?? "";
}
