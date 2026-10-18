import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { accountPage, consentPage, loginPage } from "../../src/auth/pages.js";

// Nothing the Worker serves references another host: not the player's build
// (from `npm run build`) and not the owner pages. A font, script, or image
// from a third-party host would show it the address of every screen
// (Agent Note 2026-10-12-two-playback-engines).

const ORIGIN = "https://yolo.example.com";
const DIST = fileURLToPath(new URL("../../../../clients/player/dist/", import.meta.url));
// URLs in the bundles that are never requested: namespaces, a scheme id, a base.
const NOT_REQUESTED = new Set(["http://www.w3.org/2000/svg", "http://www.w3.org/ns/ttml#styling", "https://aomedia.org/emsg/ID3", "http://localhost/"]);
const ABSOLUTE = /\b(?:https?|wss?):\/\/[^\s"'`()<>\\]+/gi;
const PROTOCOL_RELATIVE = /(?:\b(?:src|href|action|poster|srcset)\s*=\s*["']?|url\(\s*["']?|@import\s+["']?)(\/\/[^/\s"'()<>][^\s"'()<>]*)/gi;

function otherHosts(text, { markup = true } = {}) {
  const found = [...text.matchAll(ABSOLUTE)].map(([url]) => url).filter((url) => !NOT_REQUESTED.has(url) && URL.parse(url)?.origin !== ORIGIN);
  return markup ? [...found, ...[...text.matchAll(PROTOCOL_RELATIVE)].map(([, url]) => url)] : found;
}

test("the check finds other hosts", () => {
  assert.deepEqual(otherHosts('<link href="https://fonts.googleapis.com/css2"><a href="https://yolo.example.com/mcp">'), ["https://fonts.googleapis.com/css2"]);
  assert.deepEqual(otherHosts("src: url(//fonts.gstatic.com/s/a.woff2)"), ["//fonts.gstatic.com/s/a.woff2"]);
});

test("the player's build and the owner pages reference no other host", () => {
  assert.ok(existsSync(join(DIST, "index.html")), `${DIST} has no build; run npm run build`);
  const files = readdirSync(DIST, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/\.(?:woff2?|png|jpe?g|webp|ico)$/i.test(entry.name)).map((entry) => join(entry.parentPath, entry.name));
  assert.ok(files.some((file) => file.endsWith(".js")), "the build has no scripts");
  const found = files.flatMap((file) => otherHosts(readFileSync(file, "utf8"), { markup: /\.(?:html|css|svg)$/.test(file) }).map((url) => `${file.slice(DIST.length)}: ${url}`));
  const pages = [loginPage({ hasPasskey: true }), accountPage({ signedIn: true, origin: ORIGIN }), consentPage({ clientName: "An agent", redirectHost: "agent.example", scope: ["read"] }, "h")];
  assert.deepEqual([...found, ...pages.flatMap((html) => otherHosts(html))], []);
});
