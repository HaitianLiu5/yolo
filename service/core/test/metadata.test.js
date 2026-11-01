import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeDetails, normalizeDetails, parseReleaseTitle, workTitle } from "../src/index.js";

// Title hints and the merge of a source's details with a work's metadata
// (Agent Note 2026-10-25-metadata-plugins).

const UPLOAD = "救援高手/Nathan For You-第一季 [译制 by 电波字幕组][美剧] p08 救援高手.Nathan.For.You.S01E08.WEB-720p.AAC-电波字幕组";

test("a title reads as the work's names, season, episode, and tags", () => {
  assert.deepEqual(parseReleaseTitle(UPLOAD), {
    titles: ["Nathan For You", "救援高手"],
    season: 1,
    episode: 8,
    part: 8,
    year: null,
    kind: "episode",
    agree: ["S01E08", "第一季", "p08"],
    tags: ["译制 by 电波字幕组", "美剧", "WEB", "720p", "AAC"],
  });
  const read = (title) => {
    const { titles, season, episode, year } = parseReleaseTitle(title);
    return { titles, season, episode, year };
  };
  assert.deepEqual(read("救援高手 第一季 第8集"), { titles: ["救援高手"], season: 1, episode: 8, year: null });
  assert.deepEqual(read("第十二季 第二十三集 老友记"), { titles: ["老友记"], season: 12, episode: 23, year: null });
  assert.deepEqual(read("The.Office.US.S02E03.720p.HDTV.x264"), { titles: ["The Office US"], season: 2, episode: 3, year: null });
  assert.deepEqual(read("Breaking Bad - 1x05 - Gray Matter"), { titles: ["Breaking Bad"], season: 1, episode: 5, year: null });
  assert.deepEqual(read("[SubsPlease] Frieren - 08 (1080p) [ABCD1234]"), { titles: ["Frieren"], season: null, episode: 8, year: null });
  assert.deepEqual(read("Inception (2010) 1080p BluRay"), { titles: ["Inception"], season: null, episode: null, year: 2010 });
  assert.deepEqual(read("2012 (2009) BluRay"), { titles: ["2012"], season: null, episode: null, year: 2009 });
  // A Bilibili part alone is an episode; beside a stronger marker it only agrees.
  assert.equal(parseReleaseTitle("某剧 p3").episode, 3);
  assert.equal(parseReleaseTitle("Show S01E05 p3").episode, 5);
  assert.equal(parseReleaseTitle("Nathan For You 搞笑片段合集").kind, null);
});

const WORK = {
  kind: "episode",
  title: "Private Investigator / Taxi Company",
  description: "Nathan helps a private investigator.",
  date: "2013-04-16",
  year: 2013,
  series: { title: "Nathan For You", season: 1, episode: 8, episodeTitle: "Private Investigator / Taxi Company" },
  show: { title: "Nathan For You", description: "A comedian helps small businesses.", year: 2013, poster: "https://img.example/w342/show.jpg" },
  people: [{ name: "Nathan Fielder", role: "cast", character: "Himself", photo: "https://img.example/w185/nathan.jpg" }],
  genres: ["Comedy"],
  still: "https://img.example/w300/still.jpg",
  ids: { db: "tv/53347" },
};
const MATCH = { plugin: "db", id: "tv/53347", confidence: 0.97, origin: "auto", from: "records", attributions: [{ text: "Uses the database's API.", url: "https://db.example/" }] };

test("an upload matched to a record takes the work's details and keeps its own under upload", () => {
  const source = normalizeDetails({
    kind: "video", title: UPLOAD, description: "电波字幕组 出品", date: "20200101", duration: 1320,
    people: [{ name: "某UP主", role: "channel" }], url: "https://www.bilibili.com/video/BV1?p=8", stats: { views: 10 }, tags: ["美剧"],
  });
  const merged = mergeDetails(source, { details: normalizeDetails(WORK), from: "records", match: MATCH });
  assert.equal(merged.kind, "episode");
  assert.equal(merged.title, "Nathan For You S1E8 — Private Investigator / Taxi Company");
  assert.equal(merged.description, WORK.description);
  assert.deepEqual(merged.people, WORK.people);
  assert.equal(merged.show.poster, WORK.show.poster);
  assert.equal(merged.duration, 1320, "the copy's duration");
  assert.equal(merged.url, "https://www.bilibili.com/video/BV1?p=8");
  assert.deepEqual(merged.stats, { views: 10 });
  assert.equal(merged.tags, undefined);
  assert.deepEqual(merged.upload, { title: UPLOAD, description: "电波字幕组 出品", channel: "某UP主", date: "2020-01-01", url: "https://www.bilibili.com/video/BV1?p=8", stats: { views: 10 } });
  assert.deepEqual(merged.metadata, MATCH);
});

test("an identity without a record changes only the names", () => {
  const source = normalizeDetails({ kind: "video", title: "救援高手 第一季 第8集", description: "搬运", people: [{ name: "某UP主", role: "channel" }] });
  const details = normalizeDetails({ kind: "episode", series: { title: "Nathan For You", season: 1, episode: 8, episodeTitle: "Private Investigator / Taxi Company" } });
  const merged = mergeDetails(source, { details, from: "model", match: { confidence: 0.95, origin: "auto", from: "model" } });
  assert.equal(merged.title, "Nathan For You S1E8 — Private Investigator / Taxi Company");
  assert.equal(merged.kind, "episode");
  assert.equal(merged.description, "搬运");
  assert.deepEqual(merged.people, [{ name: "某UP主", role: "channel" }]);
  assert.deepEqual(merged.upload, { title: "救援高手 第一季 第8集" });
});

test("a source that knows the work keeps its fields and gains what it lacks", () => {
  const library = normalizeDetails({
    kind: "episode", title: "Nathan For You S1E8 — Private Investigator", description: "The library's own synopsis.", duration: 1330,
    people: [{ name: "Nathan Fielder", role: "cast" }], series: { title: "Nathan For You", season: 1, episode: 8 },
  });
  const merged = mergeDetails(library, { details: normalizeDetails(WORK), from: "records", match: MATCH });
  assert.equal(merged.title, library.title);
  assert.equal(merged.description, "The library's own synopsis.");
  assert.deepEqual(merged.people, [{ name: "Nathan Fielder", role: "cast", photo: "https://img.example/w185/nathan.jpg" }]);
  assert.equal(merged.still, WORK.still);
  assert.equal(merged.series.episodeTitle, "Private Investigator / Taxi Company");
  assert.equal(merged.series.title, "Nathan For You");
  assert.equal(merged.upload, undefined);
});

test("details keep pictures only as images or artwork paths", () => {
  const details = normalizeDetails({
    poster: "javascript:alert(1)",
    backdrop: "/v1/library/items/library%3A1/artwork?variant=m-poster",
    people: [{ name: "A", photo: "file:///etc/passwd" }],
  });
  assert.equal(details.poster, undefined);
  assert.equal(details.backdrop, "/v1/library/items/library%3A1/artwork?variant=m-poster");
  assert.deepEqual(details.people, [{ name: "A", role: "cast" }]);
  assert.equal(workTitle({ kind: "movie", title: "Inception" }), "Inception");
});
