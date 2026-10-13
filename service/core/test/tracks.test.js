import assert from "node:assert/strict";
import { test } from "node:test";
import { selectTracks, preferenceFromTrack } from "../src/index.js";

const available = [
  { id: "lib:1", language: "eng", name: "English (SDH)", format: "text" },
  { id: "lib:2", language: "chi", name: "简体", format: "text" },
  { id: "lib:3", language: "zh-Hant", name: "繁體", format: "image" },
];

test("turning tracks off for a source beats the default preference", () => {
  const fallback = [preferenceFromTrack({ id: "s_zh", language: "zh", name: "Chinese", format: "text" })];
  assert.deepEqual(selectTracks({ saved: [], fallback, available }), []);
});

test("the default preference matches by language, in any common spelling, and format on another source", () => {
  const fallback = ["zh-Hans", "English", "fr"].map((language, index) => preferenceFromTrack({ id: `s_${index}`, language, name: "", format: "text" }));
  const withFrench = [...available, { id: "lib:4", language: "fr-CA", name: "Français", format: "text" }];
  assert.deepEqual(selectTracks({ fallback, available: withFrench }).map((track) => track.id), ["lib:2", "lib:1", "lib:4"]);
});

test("saved preference for the same source matches the exact id first", () => {
  const saved = [preferenceFromTrack(available[2])];
  assert.deepEqual(selectTracks({ saved, available }).map((track) => track.id), ["lib:3"]);
});
