import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  accountPage, consentPage, deviceCodeForm, deviceConfirmPage, deviceDeniedPage, devicePairedPage, loginPage, messagePage,
} from "../../src/auth/pages.js";

// Nothing the Worker serves references another host: not the player's build
// (its static assets, from `npm run build`) and not the owner pages. A font,
// script, or image from a third-party host would show that host the address
// of every screen (Agent Note 2026-10-12-two-playback-engines).

const ORIGIN = "https://yolo.example.com";
const DIST = fileURLToPath(new URL("../../../../clients/player/dist/", import.meta.url));

// Strings in the bundles that look like URLs but are never requested.
const NOT_REQUESTED = new Set([
  "http://www.w3.org/2000/svg", // the SVG namespace
  "http://www.w3.org/ns/ttml#styling", // the TTML styling namespace
  "https://aomedia.org/emsg/ID3", // the scheme of ID3 metadata in an emsg box
  "http://localhost/", // the base for relative URLs where there is no location
]);

const ABSOLUTE = /\b(?:https?|wss?):\/\/[^\s"'`()<>\\]+/gi;
// Protocol-relative addresses in markup and stylesheets ("//host/x").
const PROTOCOL_RELATIVE = /(?:\b(?:src|href|action|poster|srcset)\s*=\s*["']?|url\(\s*["']?|@import\s+["']?)(\/\/[^/\s"'()<>][^\s"'()<>]*)/gi;

function otherHosts(text, { markup }) {
  const found = [];
  for (const [url] of text.matchAll(ABSOLUTE)) {
    if (NOT_REQUESTED.has(url) || URL.parse(url)?.origin === ORIGIN) continue;
    found.push(url);
  }
  if (markup) for (const [, url] of text.matchAll(PROTOCOL_RELATIVE)) found.push(url);
  return found;
}

test("the player's build references no other host", () => {
  assert.ok(existsSync(join(DIST, "index.html")), `${DIST} has no build; run npm run build`);
  const files = readdirSync(DIST, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/\.(?:woff2?|png|jpe?g|webp|ico)$/i.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
  assert.ok(files.some((file) => file.endsWith(".js")), "the build has no scripts");
  const found = files.flatMap((file) => otherHosts(readFileSync(file, "utf8"), { markup: /\.(?:html|css|svg)$/.test(file) })
    .map((url) => `${file.slice(DIST.length)}: ${url}`));
  assert.deepEqual(found, []);
});

test("the owner pages reference no other host", async () => {
  const pages = {
    setUp: loginPage({ hasPasskey: false }),
    signIn: loginPage({ hasPasskey: true, context: { kind: "device", deviceName: "Model 3" } }),
    consent: consentPage({ clientName: "An agent", clientDomain: "agent.example", redirectHost: "agent.example", scope: ["read"] }, "handle"),
    accountSignedOut: accountPage({ signedIn: false, origin: ORIGIN }),
    account: accountPage({ signedIn: true, origin: ORIGIN }),
    deviceCode: deviceCodeForm("That code has expired."),
    deviceConfirm: deviceConfirmPage({ deviceName: "Model 3", deviceKind: "car", requestedAt: Date.now(), userCode: "BCDF-GHJK" }),
    devicePaired: await devicePairedPage({ deviceName: "Model 3", deviceKind: "car" }).text(),
    deviceDenied: await deviceDeniedPage({ deviceName: "Model 3" }).text(),
    message: await messagePage("Something went wrong", "Try again.").text(),
  };
  const found = Object.entries(pages).flatMap(([name, html]) => otherHosts(html, { markup: true }).map((url) => `${name}: ${url}`));
  assert.deepEqual(found, []);
});

test("the check finds other hosts", () => {
  assert.deepEqual(otherHosts('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP">', { markup: true }),
    ["https://fonts.googleapis.com/css2?family=Noto+Sans+JP"]);
  assert.deepEqual(otherHosts("src: url(//fonts.gstatic.com/s/a.woff2)", { markup: true }), ["//fonts.gstatic.com/s/a.woff2"]);
  assert.deepEqual(otherHosts('fetch("https://www.w3.org/2000/svg/x")', { markup: false }), ["https://www.w3.org/2000/svg/x"]);
  assert.deepEqual(otherHosts(`<a href="${ORIGIN}/mcp">`, { markup: true }), []);
});
