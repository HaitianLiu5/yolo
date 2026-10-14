import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseTextTrack, parseVtt, searchCues, sliceCues } from "../src/transcripts.js";

// Rolling automatic captions, as a source cleans them: each cue repeats the
// line before it, and 10 ms cues hold only the repeated line.
const VTT = `WEBVTT
Kind: captions

NOTE a comment

00:00:01.000 --> 00:00:04.000 align:start position:0%
<c>Welcome</c> back to the &amp; show

00:00:04.000 --> 00:00:04.010
Welcome back to the & show

00:00:04.010 --> 00:00:07.000
Welcome back to the & show
today we visit the old Lighthouse

00:00:07.000 --> 00:00:10.000
where the keeper
Café owners meet

00:01:05.500 --> 00:01:08.000
The lighthouse keeper waves goodbye

1:02:03.000 --> 1:02:05.000
Last line
`;

test("WebVTT becomes de-duplicated cues, sliced by time under a size cap, and searched", () => {
  const cues = parseVtt(VTT);
  assert.deepEqual(cues.map((cue) => [cue.start, cue.end, cue.text]), [
    [1, 4.01, "Welcome back to the & show"],
    [4.01, 7, "today we visit the old Lighthouse"],
    [7, 10, "where the keeper Café owners meet"],
    [65.5, 68, "The lighthouse keeper waves goodbye"],
    [3723, 3725, "Last line"],
  ]);

  // Cues that overlap the range, as "m:ss text" lines.
  const window = sliceCues(cues, { from: 5, to: 70 });
  assert.equal(window.text, "0:04 today we visit the old Lighthouse\n0:07 where the keeper Café owners meet\n1:05 The lighthouse keeper waves goodbye");
  assert.equal(window.nextFrom, null);
  // A cap cuts at a whole cue and says where to continue.
  const page = sliceCues(cues, { from: 0, maxChars: 80 });
  assert.equal(page.count, 2);
  assert.equal(page.nextFrom, 7);

  // A phrase across two cues, case and accents ignored.
  assert.deepEqual(searchCues(cues, "old lighthouse where").map((match) => match.at), [4.01]);
  assert.deepEqual(searchCues(cues, "cafe").map((match) => [match.at, match.time]), [[7, "0:07"]]);
  assert.deepEqual(searchCues(cues, "LIGHTHOUSE").map((match) => match.at), [4.01, 65.5]);
  // Every word, near each other, when the phrase itself is not said.
  assert.deepEqual(searchCues(cues, "keeper goodbye lighthouse").map((match) => match.at), [65.5]);
  assert.deepEqual(searchCues(cues, "submarine"), []);
});

test("the transcript track is the one asked for, else the selected, else the best text track; image tracks have no text", () => {
  const tracks = [
    { id: "img", language: "en", name: "English (PGS)", format: "image" },
    { id: "auto", language: "en", name: "English (auto)", format: "text", auto: true },
    { id: "zh", language: "zh-Hans", name: "中文", format: "text" },
    { id: "en", language: "eng", name: "English", format: "text" },
  ];
  assert.equal(chooseTextTrack(tracks, {}).id, "zh");
  assert.equal(chooseTextTrack(tracks, { selected: ["en"] }).id, "en");
  assert.equal(chooseTextTrack(tracks, { language: "en" }).id, "en");
  assert.equal(chooseTextTrack(tracks, { track: "auto" }).id, "auto");
  assert.throws(() => chooseTextTrack(tracks, { track: "img" }), { code: "invalid_request", message: /image subtitle/ });
  assert.throws(() => chooseTextTrack(tracks, { language: "fr" }), { code: "not_found", message: /en, zh/ });
  assert.throws(() => chooseTextTrack([tracks[0]], {}), { code: "not_found", message: /only image subtitles/ });
  assert.throws(() => chooseTextTrack([], {}), { code: "not_found", message: /no subtitles or captions/ });
});
