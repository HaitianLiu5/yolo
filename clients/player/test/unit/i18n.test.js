import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chooseLanguage, chosenLanguage, resolveLanguage, t, useLanguage } from "../../src/i18n.js";
import zhHans from "../../src/locales/zh-Hans.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("a screen's choice wins over its browser, and any Chinese in the browser is Simplified Chinese", () => {
  const storage = new Map();
  const store = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  assert.equal(chosenLanguage(store), "");
  chooseLanguage("zh-Hans", store);
  assert.equal(resolveLanguage(chosenLanguage(store), ["en-US"]), "zh-Hans");
  chooseLanguage("", store);
  assert.equal(chosenLanguage(store), "");
  assert.equal(resolveLanguage("", ["en-US", "zh-Hans-US"]), "en");
  assert.equal(resolveLanguage("", ["zh-TW", "en"]), "zh-Hans");
  assert.equal(resolveLanguage("", ["ja-JP"]), "en");
});

test("text is looked up in the screen's language, English without an entry, with values by name", () => {
  try {
    useLanguage("zh-Hans");
    assert.equal(t("Language"), "语言");
    assert.equal(t("No entry for this {thing}", { thing: "text" }), "No entry for this text");
    useLanguage("en");
    assert.equal(t("Language"), "Language");
  } finally {
    useLanguage("en");
  }
});

// Every English text the player shows has its Chinese: each t() of a
// literal in src/, and what index.html says before any script runs. The
// catalog holds nothing else.
function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "locales" ? [] : sources(path);
    return name.endsWith(".js") ? [path] : [];
  });
}

const CALL = /(?<![\w.$])t\(\s*("(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.)*`)/g;
// Names and marks that read the same in every language.
const SAME = new Set(["Yolo", "AirPlay", "Plex", "Tesla", "QR", "×", "·", "—", "OK"]);

function htmlTexts(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<!--[\s\S]*?-->/g, "");
  const texts = [...body.matchAll(/>([^<>]+)</g)].map((match) => match[1].trim());
  const attributes = [...body.matchAll(/\s(?:aria-label|placeholder|title|alt)="([^"]+)"/g)].map((match) => match[1]);
  return [...texts, ...attributes].filter((text) => /[A-Za-z]/.test(text) && !SAME.has(text));
}

test("every text the player shows has its Simplified Chinese, and the catalog nothing else", () => {
  const used = new Map();
  for (const file of sources(join(root, "src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(CALL)) {
      const quoted = match[1];
      const text = quoted.startsWith("`") ? quoted.slice(1, -1) : JSON.parse(quoted);
      used.set(text, file.slice(root.length));
    }
  }
  for (const text of htmlTexts(readFileSync(join(root, "index.html"), "utf8"))) used.set(text, "index.html");
  const missing = [...used].filter(([text]) => !(text in zhHans)).map(([text, file]) => `${file}: ${text}`);
  assert.deepEqual(missing, [], "texts without Simplified Chinese");
  const unused = Object.keys(zhHans).filter((text) => !used.has(text));
  assert.deepEqual(unused, [], "catalog entries nothing shows");
  // A value named in English is named in Chinese too.
  const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  const misnamed = Object.entries(zhHans).filter(([en, zh]) => names(en).join() !== names(zh).join()).map(([en]) => en);
  assert.deepEqual(misnamed, [], "values named differently");
});
