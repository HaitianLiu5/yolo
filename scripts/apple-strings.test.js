import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The Apple apps' text (Agent Note 2026-10-26-player-language): every English
// text they show has its Simplified Chinese in Localizable.xcstrings, and the
// catalog holds nothing else. `npm run check` compiles no Swift, so this reads
// the source as the player's gate does: a literal where it is written, in the
// calls below. Xcode's own extraction finds the same keys when it builds.

const apple = fileURLToPath(new URL("../clients/apple/", import.meta.url));
const FOLDERS = ["Shared", "TV", "iOS"];
const catalog = JSON.parse(readFileSync(join(apple, "Shared/Localizable.xcstrings"), "utf8"));

// A call that takes its text as a LocalizedStringKey or a LocalizationValue,
// so a literal in its first argument is looked up; `t(` is the app's own, for
// a String. A literal in any other call stays as written.
const CALLS = /(?<![\w.$])(?:t|Text|Button|Label|Section|Tab|Toggle|Picker|Menu|NavigationLink|DisclosureGroup|ProgressView|TextField|LabeledContent|LocalizedStringKey|row)\(|\.(?:alert|accessibilityLabel|accessibilityValue)\(|\bShelf\(title:|\blabel:/g;
// A call whose text goes through `t()`, never a literal. UIKit's titles are
// Strings nothing looks up, and a navigation bar can keep a literal's old
// language after a second change, as a search prompt can.
const ONLY_T = /\b(?:UIAction|UIMenu)\(title:|\.navigationTitle\(|\bprompt:/g;
// A literal a UIKit label or button shows as written.
const ASSIGNED = /\.(?:text|title)\s*=\s*"((?:[^"\\\n]|\\.)*\p{L}(?:[^"\\\n]|\\.)*)"/gu;

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".swift") ? [path] : [];
  });
}

/** The Swift string literal opening at `start`: its text with each interpolation as `%@`, and where it ends. */
function readLiteral(source, start) {
  let text = "";
  let at = start + 1;
  while (at < source.length && source[at] !== '"') {
    if (source[at] === "\\" && source[at + 1] === "(") {
      at += 2;
      for (let depth = 1; depth > 0; at += 1) {
        if (source[at] === '"') at = readLiteral(source, at).end - 1;
        else if (source[at] === "(") depth += 1;
        else if (source[at] === ")") depth -= 1;
      }
      text += "%@";
    } else if (source[at] === "\\") {
      text += { n: "\n", t: "\t" }[source[at + 1]] ?? source[at + 1];
      at += 2;
    } else {
      text += source[at];
      at += 1;
    }
  }
  return { text, end: at + 1 };
}

/** The literals of the first argument at `start`, as far as its first comma or close outside brackets. */
function firstArgument(source, start) {
  const literals = [];
  let at = start;
  while (/\s/.test(source[at])) at += 1;
  if (source.startsWith("verbatim:", at) || source[at] === "{") return literals;
  for (let depth = 0; at < source.length; at += 1) {
    const c = source[at];
    if (c === '"') {
      const literal = readLiteral(source, at);
      const before = source.slice(Math.max(0, at - 4), at).trimEnd();
      if (depth === 0 && /\p{L}/u.test(literal.text) && !/[=!]=$/.test(before)) literals.push({ text: literal.text, fallback: before.endsWith("??") });
      at = literal.end - 1;
    } else if ("([{".includes(c)) {
      depth += 1;
    } else if (depth === 0 && ",)]}".includes(c)) {
      break;
    } else if (")]}".includes(c)) {
      depth -= 1;
    }
  }
  return literals;
}

/**
 * Every text the calls in `source` look up, a literal or a ternary's, and
 * the literals that read as text there but must go through `t()`: one after
 * `??` is a String, so `Text(title ?? "Untitled")` shows it as written.
 */
function looked(code) {
  const source = code.replace(/^\s*\/\/.*$/gm, "");
  const texts = [];
  const unlooked = [];
  for (const match of source.matchAll(CALLS)) {
    for (const { text, fallback } of firstArgument(source, match.index + match[0].length)) (fallback ? unlooked : texts).push(text);
  }
  for (const match of source.matchAll(ONLY_T)) {
    unlooked.push(...firstArgument(source, match.index + match[0].length).map(({ text }) => text));
  }
  for (const match of source.matchAll(ASSIGNED)) unlooked.push(match[1]);
  return { texts, unlooked };
}

// What Xcode writes for a value, whatever its type or position.
const normal = (key) => key.replace(/%(?:\d+\$)?(?:lld|ld|d|lf|f|@)/g, "%@");
const placeholders = (text) => (text.match(/%(?:\d+\$)?(?:lld|ld|d|lf|f|@)/g) ?? []).map((value) => value.replace(/^%\d+\$/, "%")).sort();

test("looking through the source finds literals, ternaries, and what sits inside an interpolation, and what stays English", () => {
  const source = [
    'Text("Home").font(.title)',
    'Button(open',
    '  ? "Close"',
    '  : "Open \\(name)") { go() }',
    '.accessibilityLabel("Continue \\(title ?? t("Playing")) here")',
    'Text(error)',
    'Text(verbatim: "No lookup")',
    'Image(systemName: "house")',
    'Text("-" + clock(position))',
    'Text(role == "cast" ? character : role)',
    '// Text("A comment")',
    'Button { go() } label: { Image(systemName: "play") }',
    'GlassIcon(systemImage: "gear", label: on ? "Hide" : "Show") { go() }',
    'Shelf(title: "Season \\(season.number)", items: items)',
    'choices(t("Density"), "density", [(t("Fewer"), "low")])',
    'Text(item.title ?? "Untitled")',
    'UIAction(title: "Off") { _ in }',
    'label.text = "LIVE"',
    'label.text = clock(position)',
    '.navigationTitle("Settings")',
    '.navigationTitle(t("Search"))',
  ].join("\n");
  const { texts, unlooked } = looked(source);
  assert.deepEqual([...texts].sort(), ["Close", "Continue %@ here", "Density", "Fewer", "Hide", "Home", "Open %@", "Playing", "Search", "Season %@", "Show"]);
  assert.deepEqual([...unlooked].sort(), ["LIVE", "Off", "Settings", "Untitled"]);
});

test("every text the Apple apps show has its Simplified Chinese, and the catalog nothing else", () => {
  const used = new Map();
  const notLookedUp = [];
  for (const folder of FOLDERS) {
    for (const file of sources(join(apple, folder))) {
      const { texts, unlooked } = looked(readFileSync(file, "utf8"));
      for (const text of texts) used.set(text, file.slice(apple.length));
      notLookedUp.push(...unlooked.map((text) => `${file.slice(apple.length)}: ${text}`));
    }
  }
  assert.deepEqual(notLookedUp, [], "literals shown as written: give them to t()");

  const entries = Object.entries(catalog.strings);
  const keys = new Map(entries.map(([key, entry]) => [normal(key), entry]));

  const missing = [...used].filter(([text]) => !keys.has(text)).map(([text, file]) => `${file}: ${text}`);
  assert.deepEqual(missing, [], "texts the catalog does not have");

  const translated = (entry) => entry.localizations?.["zh-Hans"]?.stringUnit;
  const untranslated = [...used.keys()].filter((text) => keys.get(text).shouldTranslate !== false && translated(keys.get(text))?.state !== "translated");
  assert.deepEqual(untranslated, [], "texts without Simplified Chinese");

  const unused = entries.map(([key]) => key).filter((key) => !used.has(normal(key)));
  assert.deepEqual(unused, [], "catalog entries nothing shows");

  // A value in the English is a value in the Chinese, of the same types.
  const mismatched = entries.filter(([key, entry]) => translated(entry) && placeholders(key).join() !== placeholders(translated(entry).value).join()).map(([key]) => key);
  assert.deepEqual(mismatched, [], "values that differ between the languages");
});
