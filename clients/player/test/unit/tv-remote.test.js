import assert from "node:assert/strict";
import test from "node:test";
import { nearestInDirection, remoteKey } from "../../src/tv-remote.js";

// A TV's remote moves focus to the nearest control in an arrow's direction
// (Agent Note 2026-10-26-tv-web-client).

const box = (name, left, top, width = 100, height = 60) => ({ name, left, top, right: left + width, bottom: top + height });

// Two rows of cards under a header with a search field and a settings button.
const search = box("search", 700, 20, 500, 40);
const settings = box("settings", 1820, 20, 40, 40);
const row1 = [0, 1, 2, 3].map((i) => box(`a${i}`, 40 + i * 140, 120));
const row2 = [0, 1, 2, 3].map((i) => box(`b${i}`, 40 + i * 140, 240));
const all = [search, settings, ...row1, ...row2];
const go = (from, direction) => nearestInDirection(from, all, direction)?.name ?? null;

test("left and right keep to the row; past its end nothing moves", () => {
  assert.deepEqual([go(row1[1], "right"), go(row1[1], "left"), go(row1[0], "left")], ["a2", "a0", null]);
});

test("up and down keep to the column", () => {
  assert.deepEqual([go(row1[2], "down"), go(row2[2], "up")], ["b2", "a2"]);
});

test("up from a row reaches the header control nearest above it", () => {
  assert.deepEqual([go(row1[0], "up"), go(row1[3], "up")], ["search", "search"]);
});

test("along the header, a control far off in the same row beats a nearer card below, and its end stops", () => {
  const voice = box("voice", 179, 24, 40, 40);
  assert.equal(nearestInDirection(voice, [voice, search, row1[1]], "right")?.name, "search");
  assert.equal(go(settings, "right"), null);
});

test("down from a sheet's title reaches the choice just below, not the far one under the title", () => {
  const title = box("title", 1384, 18, 88, 28);
  const choice = box("choice", 1487, 181, 13, 13);
  const forget = box("forget", 1384, 595, 154, 40);
  assert.equal(nearestInDirection(title, [choice, forget], "down")?.name, "choice");
});

test("a card scrolled past the screen's edge is still the next one", () => {
  const scrolled = [box("c0", 1800, 120), box("c1", 1940, 120)];
  assert.equal(nearestInDirection(scrolled[0], scrolled, "right")?.name, "c1");
});

test("Tizen's and webOS's Back and media keys are read by code when the key has no name", () => {
  const keys = [
    { key: "ArrowUp" }, { key: "Enter" }, { key: "Unidentified", keyCode: 10009 }, { key: "Unidentified", keyCode: 461 },
    { key: "MediaPlayPause", keyCode: 10252 }, { key: "Unidentified", keyCode: 417 }, { key: "a", keyCode: 65 },
  ];
  assert.deepEqual(keys.map(remoteKey), ["up", "ok", "back", "back", "playpause", "forward", null]);
});
