import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalMetadata } from "../src/node.js";
import { parseNfo } from "../src/nfo.js";

// The local plugin over a real folder: NFO files, pictures beside the file,
// and embedded tags through a fake ffprobe. Nothing leaves the machine.

const EPISODE_NFO = `<?xml version="1.0" encoding="UTF-8"?>
<episodedetails>
  <title>Private Investigator &amp; Taxi Company</title>
  <showtitle>Nathan For You</showtitle>
  <season>1</season>
  <episode>8</episode>
  <plot><![CDATA[Nathan helps a <b>private</b> investigator.]]></plot>
  <aired>2013-04-16</aired>
  <uniqueid type="imdb" default="true">tt2297757</uniqueid>
  <actor><name>Nathan Fielder</name><role>Himself</role><order>0</order></actor>
  <director>Michael Koman</director>
</episodedetails>`;
const SHOW_NFO = "<tvshow><title>Nathan For You</title><plot>A comedian helps businesses.</plot><year>2013</year><genre>Comedy</genre></tvshow>";

function library(t) {
  const root = mkdtempSync(join(tmpdir(), "yolo-local-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const season = join(root, "Nathan For You", "Season 1");
  mkdirSync(join(season, ".actors"), { recursive: true });
  const video = join(season, "Nathan.For.You.S01E08.mkv");
  writeFileSync(video, "");
  writeFileSync(join(season, "Nathan.For.You.S01E08.nfo"), EPISODE_NFO);
  writeFileSync(join(season, "Nathan.For.You.S01E08-thumb.jpg"), "thumb");
  writeFileSync(join(season, ".actors", "Nathan_Fielder.jpg"), "face");
  writeFileSync(join(root, "Nathan For You", "tvshow.nfo"), SHOW_NFO);
  writeFileSync(join(root, "Nathan For You", "poster.jpg"), "poster");
  return { root, video };
}

test("an NFO beside a file matches for certain and describes the episode with its pictures", async (t) => {
  const { video } = library(t);
  const local = createLocalMetadata({ run: () => assert.fail("no ffprobe with an NFO") });
  const [found] = await local.identify({ file: { path: video, size: 0 }, kind: "episode", title: "S01E08" });
  assert.equal(found.confidence, 1);
  assert.deepEqual([found.kind, found.title, found.season, found.episode, found.ids], ["episode", "Nathan For You", 1, 8, { imdb: "tt2297757" }]);
  assert.doesNotMatch(found.id, /Nathan|\//, "the file's path stays on the node");

  const details = await local.lookup(found);
  assert.equal(details.title, "Private Investigator & Taxi Company");
  assert.equal(details.description, "Nathan helps a private investigator.");
  assert.deepEqual(details.series, { title: "Nathan For You", season: 1, episode: 8, episodeTitle: "Private Investigator & Taxi Company" });
  assert.deepEqual(details.show, { title: "Nathan For You", description: "A comedian helps businesses.", year: 2013, poster: "local:show-poster" });
  assert.deepEqual(details.people, [{ name: "Nathan Fielder", role: "cast", character: "Himself", photo: "local:actor-0" }, { name: "Michael Koman", role: "director" }]);
  assert.equal(details.still, "local:thumb");
  assert.equal(details.poster, "local:show-poster");
  assert.deepEqual(details.genres, ["Comedy"]);

  for (const [ref, body] of [["thumb", "thumb"], ["actor-0", "face"], ["show-poster", "poster"]]) {
    const response = await local.image(ref, { file: { path: video } });
    assert.equal(await response.text(), body);
  }
  assert.equal((await local.image("../../etc/passwd", { file: { path: video } })).status, 404);
});

test("without an NFO, tags embedded in the file describe the episode", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yolo-local-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const video = join(root, "episode.mp4");
  writeFileSync(video, "");
  const run = (command, args, options, done) => done(null, JSON.stringify({ format: { tags: { TITLE: "Taxi Company", SHOW: "Nathan For You", SEASON_NUMBER: "1", EPISODE_SORT: "8" } } }));
  const local = createLocalMetadata({ run });
  const [found] = await local.identify({ file: { path: video } });
  assert.deepEqual([found.kind, found.title, found.season, found.episode, found.confidence], ["episode", "Nathan For You", 1, 8, 0.9]);
  assert.deepEqual((await local.lookup(found)).series, { title: "Nathan For You", season: 1, episode: 8, episodeTitle: "Taxi Company" });
  assert.deepEqual(await local.identify({ file: null, title: "web video" }), []);
});

test("an NFO is read as text: only the elements Yolo shows, without markup", () => {
  const movie = parseNfo("<movie><title>Inception</title><year>2010</year><id>tt1375666</id><uniqueid type=\"tmdb\">27205</uniqueid><genre>Sci-Fi</genre></movie>");
  assert.deepEqual([movie.root, movie.title, movie.year, movie.ids, movie.genres], ["movie", "Inception", 2010, { tmdb: "27205", imdb: "tt1375666" }, ["Sci-Fi"]]);
  assert.equal(parseNfo("https://www.imdb.com/title/tt1375666/"), null);
});

test("the index of files is written once for many new files, through a rename, and a broken one starts empty", async (t) => {
  const { root, video } = library(t);
  const cacheDir = join(root, "cache");
  mkdirSync(cacheDir);
  writeFileSync(join(cacheDir, "files.json"), "{\"f-1\": \"/gone.mkv\", \"f-");
  const local = createLocalMetadata({ cacheDir, run: () => assert.fail("no ffprobe with an NFO") });
  const [found] = await local.identify({ file: { path: video, size: 0 }, kind: "episode", title: "S01E08" });
  assert.match(readFileSync(join(cacheDir, "files.json"), "utf8"), /^\{"f-1"/, "not written yet");
  local.flush();
  assert.deepEqual(JSON.parse(readFileSync(join(cacheDir, "files.json"), "utf8")), { [found.id]: video });
  assert.deepEqual(readdirSync(cacheDir), ["files.json"], "no temporary file is left");
  const again = createLocalMetadata({ cacheDir, run: () => assert.fail("no ffprobe with an NFO") });
  assert.equal((await again.lookup(found)).title, "Private Investigator & Taxi Company", "the next run knows the id");
  assert.ok(existsSync(join(cacheDir, "files.json")));
});

test("a TMDB number goes on as a film's or a show's; an episode's own is left out", async (t) => {
  const { root, video } = library(t);
  const local = createLocalMetadata({ run: () => assert.fail("no ffprobe with an NFO") });
  const season = join(root, "Nathan For You", "Season 1");
  writeFileSync(join(root, "Nathan For You", "tvshow.nfo"), SHOW_NFO.replace("</tvshow>", "<uniqueid type=\"tmdb\">53347</uniqueid><uniqueid type=\"tvdb\">264674</uniqueid></tvshow>"));
  writeFileSync(join(season, "Nathan.For.You.S01E08.nfo"), EPISODE_NFO.replace("</episodedetails>", "<uniqueid type=\"tmdb\">912345</uniqueid></episodedetails>"));
  const [episode] = await local.identify({ file: { path: video, size: 0 } });
  assert.deepEqual(episode.ids, { imdb: "tt2297757", tmdb: "tv/53347" });
  assert.deepEqual((await local.lookup(episode)).ids, episode.ids, "the details carry the same ids");
  writeFileSync(join(season, "Nathan.For.You.S01E08.nfo"), EPISODE_NFO.replace(/<uniqueid.*<\/uniqueid>/, ""));
  assert.deepEqual((await local.identify({ file: { path: video, size: 0 } }))[0].ids, { tvdb: "264674", tmdb: "tv/53347" });
  const film = join(root, "Inception (2010).mkv");
  writeFileSync(film, "");
  writeFileSync(join(root, "Inception (2010).nfo"), "<movie><title>Inception</title><uniqueid type=\"tmdb\">27205</uniqueid></movie>");
  const [movie] = await local.identify({ file: { path: film, size: 0 } });
  assert.deepEqual(movie.ids, { tmdb: "movie/27205" });
  assert.deepEqual((await local.lookup(movie)).ids, { tmdb: "movie/27205" });
});
