import zhHans from "./locales/zh-Hans.js";

// The player's language (Agent Note 2026-10-26-player-language): English, or
// Simplified Chinese. Each screen keeps its own choice, as with the agent it
// asks; without one it shows the account's language (Agent Note
// 2026-11-06-account-language), and without that it follows the browser's
// languages, where any Chinese is Simplified Chinese. The language also goes
// with what the screen says to Yolo: the words of a voice request are heard
// in it, and the agent answers in it.
//
// The English text is the key: t('Listening…') is the string itself in
// English and the catalog's entry in another language, so a missing entry
// shows English. A value goes in by name, t('Ask {agent}', { agent }).
// The language is read once, when the page loads; changing it reloads the
// page, so text made when a module loads is in it too.

const KEY = "yolo.language";
// What Yolo last said the account's language is, so the page draws in it as
// it loads, before any connection.
const ACCOUNT_KEY = "yolo.accountLanguage";
const CATALOGS = { "zh-Hans": zhHans };

// The choices, each named in its own language.
export const LANGUAGES = Object.freeze([
  { value: "en", label: "English" },
  { value: "zh-Hans", label: "简体中文" },
]);

// A language this release does not show counts as none.
const shown = (value) => (LANGUAGES.some((language) => language.value === value) ? value : "");

function kept(key, storage) {
  try {
    return shown(storage?.getItem(key) ?? "");
  } catch {
    return "";
  }
}

function keep(key, value, storage) {
  try {
    if (value) storage?.setItem(key, value);
    else storage?.removeItem(key);
  } catch {
    // A private window: the choice lasts until the page reloads.
  }
}

/** This screen's choice: "en", "zh-Hans", or "" for Automatic. */
export function chosenLanguage(storage = globalThis.localStorage) {
  return kept(KEY, storage);
}

export function chooseLanguage(value, storage = globalThis.localStorage) {
  keep(KEY, value, storage);
}

/** The account's language as this screen last heard it, or "" for none. */
export function accountLanguage(storage = globalThis.localStorage) {
  return kept(ACCOUNT_KEY, storage);
}

/**
 * The language a choice means: the account's for none, then the browser's.
 */
export function resolveLanguage(chosen = chosenLanguage(), languages = globalThis.navigator?.languages ?? [globalThis.navigator?.language], account = accountLanguage()) {
  if (chosen) return chosen;
  if (account) return account;
  for (const tag of languages ?? []) {
    const primary = typeof tag === "string" ? tag.split("-")[0].toLowerCase() : "";
    if (primary === "zh") return "zh-Hans";
    if (primary === "en") return "en";
  }
  return "en";
}

let current = resolveLanguage();

/**
 * What Yolo says the account's language is (null for none), kept for the next
 * load. True when the page should load again to show it: never when nothing
 * keeps it, since the next load would only ask again.
 */
export function learnAccountLanguage(value, storage = globalThis.localStorage) {
  const language = shown(value);
  keep(ACCOUNT_KEY, language, storage);
  if (accountLanguage(storage) !== language) return false;
  return resolveLanguage(chosenLanguage(storage), undefined, language) !== current;
}

/** The language the player shows: "en" or "zh-Hans". */
export const language = () => current;

/** For tests: show `value` from now on. */
export function useLanguage(value) {
  current = value;
}

/**
 * The language that goes with what this screen says to Yolo: the one chosen
 * here or for the account, or else the browser's own (a hint, so a Japanese
 * browser's words are still heard as Japanese).
 */
export function requestLanguage() {
  return chosenLanguage() || accountLanguage() || globalThis.navigator?.language || null;
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
