import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTimestamp, normalizeChapters, normalizeDetails, skipTarget } from "../src/index.js";

test("chapters and markers are sorted, bounded, and skippable", () => {
  const chapters = normalizeChapters([
    { start: 600, title: "Act two" },
    { start: 0, end: 90, kind: "intro" },
    { start: 0, title: "  Cold open  " },
    { start: 120.04, title: "Act one" },
    { start: 2580, end: 2700, kind: "credits" },
    { start: "nope" },
    // A bad end, and a kind Yolo does not know, are dropped.
    { start: 50, end: 40, title: "Backwards" },
    { start: 30, kind: "commercial", title: "Ad" },
  ], { duration: 2700 });
  assert.deepEqual(chapters, [
    { start: 0, end: 120, kind: "chapter", title: "Cold open" },
    { start: 0, end: 90, kind: "intro" },
    { start: 120, end: 600, kind: "chapter", title: "Act one" },
    { start: 600, end: 2700, kind: "chapter", title: "Act two" },
    { start: 2580, end: 2700, kind: "credits" },
  ]);

  // Inside the intro: past its end. Outside it: say where it is.
  assert.deepEqual(skipTarget(chapters, 12, "intro"), { position: 90, chapter: { start: 0, end: 90, kind: "intro" } });
  assert.throws(() => skipTarget(chapters, 400, "intro"), { code: "not_found", message: /0:00–1:30/ });
  // A chapter titled like an opening counts when there is no marker.
  assert.equal(skipTarget([{ start: 0, end: 85, kind: "chapter", title: "Opening" }], 3, "intro").position, 85);
  assert.equal(skipTarget(chapters, 130, "next_chapter").position, 600);
  assert.equal(skipTarget(chapters, 130, "previous_chapter").position, 120);
  assert.equal(skipTarget(chapters, 121, "previous_chapter").position, 0);
  assert.throws(() => skipTarget(chapters, 2600, "next_chapter"), { code: "not_found" });
  assert.throws(() => skipTarget([], 10, "next_chapter"), { code: "not_found", message: /no chapters/ });
  assert.equal(formatTimestamp(3725.4), "1:02:05");
});

test("details become one compact shape, whatever a plugin fills", () => {
  const details = normalizeDetails({
    title: " A Movie ",
    kind: "movie",
    description: `${"word ".repeat(600)}end`,
    date: "2024-05-01T00:00:00Z",
    duration: 5400.6,
    people: [
      { name: "Ann Actor", role: "cast", character: "Hero" },
      { name: "", role: "cast" },
      { name: "Dee Rector", role: "director" },
      ...Array.from({ length: 40 }, (_, index) => ({ name: `Extra ${index}`, role: "cast" })),
    ],
    genres: ["Drama", "Drama", " ", "Thriller"],
    tags: "not a list",
    ratings: [{ value: 8.2, max: 10, source: "critic" }, { value: "x" }],
    series: { title: "Show", season: 1, episode: 2 },
    stats: { views: 1200, likes: -1, bogus: "x" },
    url: "javascript:alert(1)",
    unknownField: { anything: true },
  });
  assert.equal(details.title, "A Movie");
  assert.equal(details.date, "2024-05-01");
  assert.equal(details.year, 2024);
  assert.equal(details.duration, 5401);
  assert.ok(details.description.length <= 1501 && details.description.endsWith("…"));
  assert.deepEqual(details.people.slice(0, 2), [{ name: "Ann Actor", role: "cast", character: "Hero" }, { name: "Dee Rector", role: "director" }]);
  assert.equal(details.people.length, 20);
  assert.deepEqual(details.genres, ["Drama", "Thriller"]);
  assert.deepEqual(details.ratings, [{ value: 8.2, max: 10, source: "critic" }]);
  assert.deepEqual(details.series, { title: "Show", season: 1, episode: 2 });
  assert.deepEqual(details.stats, { views: 1200 });
  for (const field of ["tags", "url", "unknownField"]) assert.equal(field in details, false, field);
  // A source with only describe(): its title and duration.
  assert.deepEqual(normalizeDetails(null, { title: "From describe", duration: 60 }), { title: "From describe", duration: 60 });
});
