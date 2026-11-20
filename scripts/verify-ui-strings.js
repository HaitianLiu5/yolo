// Every English text the player and the owner pages show has its Simplified
// Chinese, the catalogs hold nothing else, and a value named in English is
// named in Chinese too (Agent Note 2026-10-26-player-language). It reads the
// source: each t() of a literal, and what the player's index.html says before
// any script runs. `npm run check` runs it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import player from "../clients/player/src/locales/zh-Hans.js";
import pages from "../service/control/src/auth/locales/zh-Hans.js";

const root = resolve(import.meta.dirname, "..");
const CALL = /(?<![\w.$])t\(\s*("(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.)*`)/g;
// Names and marks that read the same in every language.
const SAME = new Set(["Yolo", "AirPlay", "Plex", "Tesla", "QR", "×", "·", "—", "OK"]);

function sources(dir, { deep = true } = {}) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return deep && name !== "locales" ? sources(path) : [];
    return name.endsWith(".js") ? [path] : [];
  });
}

function htmlTexts(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<!--[\s\S]*?-->/g, "");
  const texts = [...body.matchAll(/>([^<>]+)</g)].map((match) => match[1].trim());
  const attributes = [...body.matchAll(/\s(?:aria-label|placeholder|title|alt)="([^"]+)"/g)].map((match) => match[1]);
  return [...texts, ...attributes].filter((text) => /[A-Za-z]/.test(text) && !SAME.has(text));
}

function check(label, files, catalog, extra = []) {
  const used = new Map();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(CALL)) {
      const quoted = match[1];
      used.set(quoted.startsWith("`") ? quoted.slice(1, -1) : JSON.parse(quoted), file.slice(root.length + 1));
    }
  }
  for (const [text, file] of extra) used.set(text, file);
  const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join();
  const problems = [
    ["texts without Simplified Chinese", [...used].filter(([text]) => !(text in catalog)).map(([text, file]) => `${file}: ${text}`)],
    ["catalog entries nothing shows", Object.keys(catalog).filter((text) => !used.has(text))],
    ["values named differently", Object.entries(catalog).filter(([en, zh]) => names(en) !== names(zh)).map(([en]) => en)],
  ].filter(([, list]) => list.length > 0);
  for (const [what, list] of problems) console.error(`${label}: ${what}:\n  ${list.join("\n  ")}`);
  if (problems.length === 0) console.log(`${label}: ${used.size} texts, each with its Simplified Chinese`);
  return problems.length === 0;
}

const playerRoot = join(root, "clients/player");
const ok = [
  check("player", sources(join(playerRoot, "src")), player,
    htmlTexts(readFileSync(join(playerRoot, "index.html"), "utf8")).map((text) => [text, "clients/player/index.html"])),
  check("owner pages", sources(join(root, "service/control/src/auth"), { deep: false }), pages),
].every(Boolean);
if (!ok) process.exit(1);
