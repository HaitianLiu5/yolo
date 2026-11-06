import { LANGUAGE_COOKIE, languageFromTags } from "@useyolo/core";
import zhHans from "./locales/zh-Hans.js";

// The player's language (Agent Note 2026-10-26-player-language): English, or
// Simplified Chinese. Each screen keeps its own choice, as with the agent it
// asks; without one it follows the browser's languages, and any Chinese
// there is Simplified Chinese. The choice also goes with what the screen
// says to Yolo: the words of a voice request are heard in it, and the agent
// answers in it.
//
// The English text is the key: t('Listening…') is the string itself in
// English and the catalog's entry in another language, so a missing entry
// shows English. A value goes in by name, t('Ask {agent}', { agent }).
// The language is read once, when the page loads; changing it reloads the
// page, so text made when a module loads is in it too.

const KEY = "yolo.language";
const CATALOGS = { "zh-Hans": zhHans };

// The choices, each named in its own language.
export const LANGUAGES = Object.freeze([
  { value: "en", label: "English" },
  { value: "zh-Hans", label: "简体中文" },
]);

/** This screen's choice: "en", "zh-Hans", or "" to follow the browser. */
export function chosenLanguage(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(KEY) ?? "";
    return LANGUAGES.some((language) => language.value === value) ? value : "";
  } catch {
    return "";
  }
}

export function chooseLanguage(value, storage = globalThis.localStorage) {
  try {
    if (value) storage?.setItem(KEY, value);
    else storage?.removeItem(KEY);
  } catch {
    // A private window: the choice lasts until the page reloads.
  }
}

/** The language a choice means, with the browser's languages for none. */
export function resolveLanguage(chosen = chosenLanguage(), languages = globalThis.navigator?.languages ?? [globalThis.navigator?.language]) {
  return chosen || languageFromTags(languages);
}

// The pages Yolo's server renders (sign-in, pairing, an agent's consent) cannot
// read localStorage, so a choice also goes in a cookie for them; an automatic
// screen sends none. Written each time the page loads, which changing the
// language always does, so it does not lapse and a choice made earlier counts.
const COOKIE_SECONDS = 400 * 24 * 60 * 60; // the longest browsers keep one

if (globalThis.document) {
  const chosen = chosenLanguage();
  const secure = globalThis.location?.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LANGUAGE_COOKIE}=${chosen}; Path=/; Max-Age=${chosen ? COOKIE_SECONDS : 0}; SameSite=Lax${secure}`;
}

let current = resolveLanguage();

/** The language the player shows: "en" or "zh-Hans". */
export const language = () => current;

/** For tests: show `value` from now on. */
export function useLanguage(value) {
  current = value;
}

/**
 * The language that goes with what this screen says to Yolo: the one chosen
 * here, or else the browser's own (a hint, so a Japanese browser's words
 * are still heard as Japanese).
 */
export function requestLanguage() {
  return chosenLanguage() || globalThis.navigator?.language || null;
}

/** `text` in the player's language, with `{name}` replaced from `values`. */
export function t(text, values = null) {
  const found = CATALOGS[current]?.[text] ?? text;
  return values ? found.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole)) : found;
}

// The page's own text: what index.html says in English, before any script
// draws more. Text nodes and these attributes are looked up as they are.
const ATTRIBUTES = ["aria-label", "placeholder", "title", "alt"];

export function translateDocument(doc = globalThis.document) {
  if (!doc) return;
  doc.documentElement.lang = current;
  if (!CATALOGS[current]) return;
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (text && CATALOGS[current][text]) node.nodeValue = node.nodeValue.replace(text, CATALOGS[current][text]);
  }
  for (const element of doc.body.querySelectorAll(ATTRIBUTES.map((name) => `[${name}]`).join(","))) {
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value && CATALOGS[current][value]) element.setAttribute(name, CATALOGS[current][value]);
    }
  }
}
