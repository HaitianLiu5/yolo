// What the Worker serves references no other host: not the player's build
// (run after `npm run build`) and not the owner pages, since a font, script,
// or image from a third-party host would see the address of every screen
// (Agent Note 2026-10-12-two-playback-engines). And the owner pages, which
// inline their CSS, keep Yolo Web's dark tokens (Agent Note
// 2026-10-12-owner-web-pages). `npm run check` runs it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { wordsIn } from "../service/control/src/auth/i18n.js";
import { accountPage, consentPage, DARK_TOKENS, loginPage } from "../service/control/src/auth/pages.js";

const root = resolve(import.meta.dirname, "..");
const ORIGIN = "https://yolo.example.com";
const DIST = join(root, "clients/player/dist/");
// URLs in the bundles that are never requested: namespaces, a scheme id, a base.
const NOT_REQUESTED = new Set(["http://www.w3.org/2000/svg", "http://www.w3.org/ns/ttml#styling", "https://aomedia.org/emsg/ID3", "http://localhost/"]);
const ABSOLUTE = /\b(?:https?|wss?):\/\/[^\s"'`()<>\\]+/gi;
const PROTOCOL_RELATIVE = /(?:\b(?:src|href|action|poster|srcset)\s*=\s*["']?|url\(\s*["']?|@import\s+["']?)(\/\/[^/\s"'()<>][^\s"'()<>]*)/gi;

function otherHosts(text, { markup = true } = {}) {
  const found = [...text.matchAll(ABSOLUTE)].map(([url]) => url).filter((url) => !NOT_REQUESTED.has(url) && URL.parse(url)?.origin !== ORIGIN);
  return markup ? [...found, ...[...text.matchAll(PROTOCOL_RELATIVE)].map(([, url]) => url)] : found;
}

const problems = [];
if (!existsSync(join(DIST, "index.html"))) {
  problems.push(`${DIST} has no build; run npm run build`);
} else {
  const files = readdirSync(DIST, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/\.(?:woff2?|png|jpe?g|webp|ico)$/i.test(entry.name)).map((entry) => join(entry.parentPath, entry.name));
  for (const file of files) {
    for (const url of otherHosts(readFileSync(file, "utf8"), { markup: /\.(?:html|css|svg)$/.test(file) })) problems.push(`${file.slice(DIST.length)}: ${url}`);
  }
}
const t = wordsIn("en");
const pages = [loginPage(t, { hasPasskey: true }), accountPage(t, { signedIn: true, origin: ORIGIN }), consentPage(t, { clientName: "An agent", redirectHost: "agent.example", scope: ["read"] }, "h")];
for (const url of pages.flatMap((html) => otherHosts(html))) problems.push(`owner page: ${url}`);

const css = readFileSync(join(root, "clients/player/src/style.css"), "utf8");
const rootRule = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
const value = (name) => new RegExp(`${name}:\\s*([^;]+);`).exec(rootRule)?.[1].trim();
const pairs = {
  "--bg": "--surface-base", "--surface": "--surface-raised", "--tile": "--surface-tile", "--fg": "--text-primary", "--fg-2": "--text-secondary",
  "--fg-3": "--text-tertiary", "--line": "--hairline", "--danger": "--danger", "--ok": "--ok", "--press": "--press", "--hover": "--hover",
};
for (const [page, client] of Object.entries(pairs)) {
  if (DARK_TOKENS[page] !== value(client)) problems.push(`owner pages' ${page} is ${DARK_TOKENS[page]}, Yolo Web's ${client} is ${value(client)}`);
}

if (problems.length > 0) {
  console.error(`served pages:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("served pages: no other host, and the owner pages keep Yolo Web's dark tokens");
