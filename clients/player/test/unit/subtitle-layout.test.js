import assert from "node:assert/strict";
import test from "node:test";

import { buildCueEndPrefix, parseVTT } from "../../src/subtitle-cues.js";
import { activeSubtitleGroups, subtitleLineFit } from "../../src/subtitle-layout.js";

// What the subtitle overlay shows (Agent Note 2026-07-13-in-car-design-principles):
// a bilingual cue one line per language, a cue in one language its author's
// lines, and each line on one row where it can.

const VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
During the presentation, we may discuss certain non-GAAP financial measures.
在本次发布会中
我们可能会讨论某些非 GAAP 财务指标

00:00:02.000 --> 00:00:04.000
I've been thinking about what you said yesterday,
and I think you might be right about all of it.

00:00:04.000 --> 00:00:06.000
我一直在想你昨天说的话
我觉得你说的可能都对

00:00:06.000 --> 00:00:08.000
We discuss some non-GAAP measures.
我们讨论某些非
GAAP 财务指标

00:00:08.000 --> 00:00:10.000
- Where are you going?
- Home.
- 你去哪儿？
- 回家。

00:00:10.000 --> 00:00:12.000
Sure.
好，
没问题。

00:00:12.000 --> 00:00:14.000
你好
こんにちは
`;

test("a bilingual cue shows one line per language, and a cue in one language its author's lines", () => {
  const cues = parseVTT(VTT);
  const track = { lang: "plex:21", cues, cueEndPrefix: buildCueEndPrefix(cues) };
  const shown = (time) => activeSubtitleGroups([track], time)[0].lines;

  assert.deepEqual(shown(1), [
    "During the presentation, we may discuss certain non-GAAP financial measures.",
    "在本次发布会中我们可能会讨论某些非 GAAP 财务指标",
  ]);
  assert.deepEqual(shown(3), ["I've been thinking about what you said yesterday,", "and I think you might be right about all of it."]);
  assert.deepEqual(shown(5), ["我一直在想你昨天说的话", "我觉得你说的可能都对"]);
  // A Chinese line with Latin letters is Chinese; a Latin word meets a Chinese character with a space.
  assert.deepEqual(shown(7), ["We discuss some non-GAAP measures.", "我们讨论某些非 GAAP 财务指标"]);
  // Two speakers in two languages: one line each language, the dashes kept.
  assert.deepEqual(shown(9), ["- Where are you going? - Home.", "- 你去哪儿？ - 回家。"]);
  // Full-width punctuation takes no space.
  assert.deepEqual(shown(11), ["Sure.", "好，没问题。"]);
  // Chinese and Japanese share characters but are two languages.
  assert.deepEqual(shown(13), ["你好", "こんにちは"]);
});

test("a line keeps one row by shrinking to three quarters of its size, and beyond that wraps into the fewest rows at the largest size", () => {
  const fit = (width, available) => {
    const { scale, wrap } = subtitleLineFit(width, available);
    return [Math.round(scale * 1000) / 1000, wrap];
  };
  assert.deepEqual(fit(800, 1000), [1, false]);
  assert.deepEqual(fit(1100, 1000), [0.909, false]);
  assert.deepEqual(fit(1333, 1000), [0.75, false]);
  // Two rows hold it at full size.
  assert.deepEqual(fit(1500, 1000), [1, true]);
  assert.deepEqual(fit(2000, 1000), [0.9, true]);
  assert.deepEqual(fit(2400, 1000), [0.75, true]);
  // Two rows would need less than the floor: three, at full size.
  assert.deepEqual(fit(2500, 1000), [1, true]);
  // Not laid out yet: nothing to fit.
  assert.deepEqual(fit(0, 1000), [1, false]);
  assert.deepEqual(fit(800, 0), [1, false]);
});
