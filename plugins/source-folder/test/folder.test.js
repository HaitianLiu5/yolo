import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseReleaseTitle } from "@useyolo/plugin-api";
import folderSource, { createFolderSource } from "../src/node.js";
import { idOfFile, readRoots, rootKey, scanRoots, sidecars } from "../src/library.js";
import { readPath, seasonOfFolder } from "../src/names.js";
import { decodeSubtitle, languageOfName, languageOfText } from "../src/subtitles.js";

// The folder source (Agent Note 2026-10-26-folder-source), against a folder
// of empty files and a fake ffprobe: names, ids, shows, tracks, and the
// `local` Input it plays with.

function tree(t, files) {
  const root = mkdtempSync(join(tmpdir(), "yolo-folder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content = "x"] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

// A fake of media.js: every file has two audio streams and one text subtitle stream.
function fakeMedia({ vtt = (text) => `WEBVTT\n\n${text}` } = {}) {
  const streams = {
    duration: 1500, kbps: 4000, video: { codec: "h264", width: 1920, height: 1080, fps: 24 },
    audio: [{ index: 1, codec: "aac", channels: 2, language: "jpn", title: null, default: true }, { index: 2, codec: "ac3", channels: 6, language: "eng", title: "Commentary", default: false }],
    subtitles: [{ index: 3, codec: "subrip", text: true, language: "eng", title: null }, { index: 4, codec: "hdmv_pgs_subtitle", text: false, language: "eng" }],
  };
  return {
    probe: async () => streams,
    known: () => streams,
    frame: async () => Buffer.from("jpeg"),
    toVtt: async (text) => vtt(text),
    embedded: () => "WEBVTT\n\nembedded",
  };
}

test("a path names a movie or an episode, from its name and its folders", () => {
  const cases = {
    "Inception (2010)/Inception.2010.1080p.BluRay.x264.mkv": { kind: "movie", title: "Inception", year: 2010 },
    "让子弹飞 (2010)/movie.mkv": { kind: "movie", title: "让子弹飞", year: 2010 },
    "The Matrix 1999.mp4": { kind: "movie", title: "The Matrix", year: 1999 },
    "Nathan for You/Season 1/S01E08.mkv": { kind: "episode", show: "Nathan for You", season: 1, episode: 8, year: null },
    "庆余年/第二季/第08集.mp4": { kind: "episode", show: "庆余年", season: 2, episode: 8, year: null },
    "[Sub] Frieren - 08 [1080p].mkv": { kind: "episode", show: "Frieren", season: 1, episode: 8, year: null },
    "Some Show/08.mkv": { kind: "episode", show: "Some Show", season: 1, episode: 8, year: null },
    "Breaking.Bad.S02E03.720p.mkv": { kind: "episode", show: "Breaking Bad", season: 2, episode: 3, year: null },
    "繁花 第一季/繁花.EP03.mp4": { kind: "episode", show: "繁花", season: 1, episode: 3, year: null },
    "Friends/Specials/1x05.avi": { kind: "episode", show: "Friends", season: 1, episode: 5, year: null },
  };
  for (const [path, expected] of Object.entries(cases)) assert.deepEqual(readPath(`/lib/${path}`, "/lib"), expected, path);
  assert.equal(seasonOfFolder("Season 02"), 2);
  assert.equal(seasonOfFolder("第十二季"), 12);
  assert.equal(seasonOfFolder("Specials"), 0);
  assert.equal(seasonOfFolder("Extras"), null);
});

test("roots come from the options or FOLDER_ROOTS, absolute and once each", () => {
  const roots = readRoots(["/media/Movies/", { path: "/media/TV" }, "relative", "/media/Movies"]);
  assert.deepEqual(roots.map(({ path }) => path), ["/media/Movies", "/media/TV"]);
  assert.deepEqual(readRoots("/a:/b").map((root) => root.path), ["/a", "/b"]);
  assert.equal(roots[0].key, rootKey("/media/Movies"));
});

test("an item id is a short token that names no path, the same for the same file", () => {
  const [root] = readRoots(["/media/Movies"]);
  const id = idOfFile(root, "/media/Movies/A (2010)/a.mkv");
  assert.match(id, /^f-[0-9a-f]{8}-[0-9a-f]{24}$/);
  assert.equal(idOfFile(root, "/media/Movies/A (2010)/a.mkv"), id);
  assert.notEqual(idOfFile(root, "/media/Movies/B/a.mkv"), id);
});

test("a scan finds videos and their subtitle files, skips samples and the NAS's own folders, and gathers episodes into shows", async (t) => {
  const root = tree(t, {
    "Inception (2010)/Inception.2010.mkv": "x",
    "Inception (2010)/Inception.2010.chs.srt": "1",
    "Inception (2010)/Subs/English.srt": "1",
    "Inception (2010)/inception-sample.mkv": "x",
    "Nathan for You/Season 1/Nathan.for.You.S01E02.mkv": "x",
    "Nathan for You/Season 1/Nathan.for.You.S01E01.mkv": "x",
    "Nathan for You/Season 1/Nathan.for.You.S01E01.en.srt": "1",
    "Nathan for You/Season 2/Nathan.for.You.S02E01.mkv": "x",
    "@eaDir/thumb.mkv": "x",
    ".hidden/a.mkv": "x",
    "notes.txt": "x",
  });
  const roots = readRoots([root]);
  const { files, shows } = await scanRoots(roots);
  const byName = new Map([...files.values()].map((file) => [file.path.slice(root.length + 1), file]));
  assert.deepEqual([...byName.keys()].sort(), [
    "Inception (2010)/Inception.2010.mkv",
    "Nathan for You/Season 1/Nathan.for.You.S01E01.mkv",
    "Nathan for You/Season 1/Nathan.for.You.S01E02.mkv",
    "Nathan for You/Season 2/Nathan.for.You.S02E01.mkv",
  ]);
  assert.deepEqual(byName.get("Inception (2010)/Inception.2010.mkv").subtitles, ["Inception.2010.chs.srt", join("Subs", "English.srt")]);
  assert.deepEqual(byName.get("Nathan for You/Season 1/Nathan.for.You.S01E01.mkv").subtitles, ["Nathan.for.You.S01E01.en.srt"]);
  assert.deepEqual(byName.get("Nathan for You/Season 1/Nathan.for.You.S01E02.mkv").subtitles, []);
  assert.equal(shows.size, 1);
  const [show] = shows.values();
  assert.equal(show.title, "Nathan for You");
  assert.equal(show.dir, join(root, "Nathan for You"));
  assert.deepEqual(show.episodes.map((id) => [files.get(id).season, files.get(id).episode]), [[1, 1], [1, 2], [2, 1]]);
  // Ids are the hashed path below the root, the same on every scan.
  assert.equal(byName.get("Inception (2010)/Inception.2010.mkv").id, idOfFile(roots[0], join(root, "Inception (2010)/Inception.2010.mkv")));
  assert.deepEqual([...(await scanRoots(roots)).files.keys()].sort(), [...files.keys()].sort());
});

test("subtitle files beside a video belong to it by name, or all of them when it is alone", () => {
  assert.deepEqual(sidecars("Movie.mkv", ["Movie.zh.srt", "Other.srt"], 2), ["Movie.zh.srt"]);
  assert.deepEqual(sidecars("Movie.mkv", ["Movie.zh.srt", "Other.srt"], 1), ["Movie.zh.srt", "Other.srt"]);
});

test("a subtitle's language comes from its name, else its text; its text from its encoding", () => {
  assert.deepEqual(languageOfName("Movie.chs.srt", "Movie.mkv"), { language: "zh-Hans", label: "简体中文" });
  assert.deepEqual(languageOfName("Movie.chs&eng.ass", "Movie.mkv"), { language: "zh-Hans", label: "简英双语" });
  assert.deepEqual(languageOfName("Movie.English.srt", "Movie.mkv"), { language: "en", label: "English" });
  assert.equal(languageOfName("Movie.srt", "Movie.mkv"), null);
  assert.equal(languageOfText("1\n00:00:01,000 --> 00:00:02,000\n这是一个用来测试语言判断的中文字幕，里面有足够多的汉字。\n").language, "zh");

  const text = "1\n00:00:01,000 --> 00:00:02,000\n你好，世界。这是简体中文字幕。\n";
  assert.equal(decodeSubtitle(Buffer.from(text, "utf8")), text);
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")])), text);
  // "你好" in GB18030.
  assert.match(decodeSubtitle(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), /^你好$/);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  assert.equal(decodeSubtitle(utf16), text);
});

test("the source lists libraries of movies and shows, a show's episodes, search, and the run an episode is in", async (t) => {
  const root = tree(t, {
    "Inception (2010)/Inception.2010.mkv": "x",
    "Nathan for You/Season 1/Nathan.for.You.S01E01.mkv": "x",
    "Nathan for You/Season 1/Nathan.for.You.S01E02.mkv": "x",
  });
  const roots = readRoots([root]);
  const { source, rescan } = createFolderSource({ roots, media: fakeMedia() });
  await rescan();
  assert.deepEqual(await source.libraries(), [{ id: "movies", title: "Movies", type: "movie" }, { id: "shows", title: "Shows", type: "show" }]);
  const { total, items: [movie] } = await source.items("movies", { offset: 0, limit: 10 });
  assert.equal(total, 1);
  const { items: [show] } = await source.items("shows", { offset: 0, limit: 10 });
  await assert.rejects(source.items("other", {}), { code: "not_found" });
  assert.deepEqual({ kind: movie.kind, title: movie.title, year: movie.year, duration: movie.duration, artwork: movie.artwork }, { kind: "video", title: "Inception (2010)", year: 2010, duration: 1500, artwork: "poster" });
  assert.deepEqual({ title: show.title, episodes: show.episodes }, { title: "Nathan for You", episodes: 2 });
  const { items: episodes } = await source.children(show.id);
  assert.deepEqual(episodes.map((episode) => [episode.kind, episode.title]), [["video", "Nathan for You S01E01"], ["video", "Nathan for You S01E02"]]);
  // The titles read clearly to the node's parser: a name with a season and an episode, or with a year.
  const read = parseReleaseTitle(episodes[1].title);
  assert.deepEqual([read.titles[0], read.season, read.episode], ["Nathan for You", 1, 2]);
  assert.deepEqual([parseReleaseTitle(movie.title).titles[0], parseReleaseTitle(movie.title).year], ["Inception", 2010]);
  assert.deepEqual((await source.search("nathan", {})).map((item) => item.kind), ["show"]);
  assert.deepEqual((await source.search("incep", { type: "movie" })).map((item) => item.title), ["Inception (2010)"]);
  const run = await source.sequence({ plugin: "folder", id: episodes[1].id });
  assert.equal(run.index, 1);
  assert.deepEqual(run.items.map((item) => item.label), ["S1 · E1", "S1 · E2"]);
  assert.equal(await source.sequence({ plugin: "folder", id: movie.id }), null);
  assert.deepEqual(await source.details({ plugin: "folder", id: episodes[0].id }), {
    title: "Nathan for You S01E01", kind: "video", duration: 1500, series: { title: "Nathan for You", season: 1, episode: 1 },
  });
  assert.deepEqual(source.roots(), [root]);
  assert.equal((await source.health()).videos, 3);
});

test("a file plays as a local Input with the chosen audio, its subtitle files and text streams as WebVTT, and file() names it", async (t) => {
  const root = tree(t, {
    "Movie (2001)/Movie.2001.mkv": "x",
    "Movie (2001)/Movie.2001.chs.srt": "1\n00:00:01,000 --> 00:00:02,000\n你好\n",
  });
  const roots = readRoots([root]);
  const { source, rescan } = createFolderSource({ roots, media: fakeMedia() });
  await rescan();
  const path = join(root, "Movie (2001)", "Movie.2001.mkv");
  const id = idOfFile(roots[0], path);
  const tracks = await source.tracks({ plugin: "folder", id });
  assert.deepEqual(tracks.subtitles.map((track) => [track.id, track.language, track.name]), [
    ["file:Movie.2001.chs.srt", "zh-Hans", "简体中文"],
    ["stream:3", "eng", "eng"],
  ]);
  assert.deepEqual(tracks.audio.map((track) => [track.id, track.name]), [["stream:1", "jpn"], ["stream:2", "Commentary · eng"]]);

  let offered = null;
  const descriptor = await source.prepare({ plugin: "folder", id }, {
    startTime: null, reason: "play",
    chooseTracks: (available) => {
      offered = available;
      return { subtitles: ["file:Movie.2001.chs.srt"], audio: "stream:2" };
    },
  });
  assert.deepEqual(descriptor.input, { type: "local", path, audio: 2 });
  assert.equal(descriptor.startTime, 0);
  assert.equal(descriptor.duration, 1500);
  assert.deepEqual(offered.audio.map((track) => track.id), ["stream:1", "stream:2"]);
  assert.ok(descriptor.tracks.subtitles.every((track) => track.delivery === "vtt" && !("file" in track)));
  assert.match(await descriptor.subtitle("file:Movie.2001.chs.srt"), /^WEBVTT\n\n1\n00:00:01,000 --> 00:00:02,000\n你好/);
  assert.equal(await descriptor.subtitle("stream:3"), "WEBVTT\n\nembedded");
  await assert.rejects(descriptor.subtitle("file:../../etc/passwd"), { code: "not_found" });
  assert.deepEqual(await source.file({ plugin: "folder", id }), { path, size: 1 });

  // A frame for an agent hears the file's default audio and no subtitle.
  const frame = await source.prepare({ plugin: "folder", id }, { startTime: 10, reason: "frame", chooseTracks: () => assert.fail("no tracks for a frame") });
  assert.deepEqual(frame.input, { type: "local", path, audio: null });
  // An id no scan knows names nothing.
  await assert.rejects(source.prepare({ plugin: "folder", id: "f-00000000-000000000000000000000000" }, { chooseTracks: () => ({}) }), { code: "not_found" });
});

test("the plugin registers its source and scans in the background once the node starts", async (t) => {
  const root = tree(t, { "A.Film.2001.mkv": "x" });
  const handlers = {};
  let registered = null;
  folderSource({
    options: { roots: [root] }, env: {}, cacheDir: null, log: { info() {}, warn() {} },
    registerSource: (id, impl) => {
      registered = { id, impl };
    },
    on: (event, fn) => {
      handlers[event] = fn;
    },
  });
  assert.equal(registered.id, "folder");
  await handlers.start();
  assert.equal((await registered.impl.items("movies", { offset: 0, limit: 5 })).total, 1);
  await handlers.shutdown();

  // Without folders it registers a source that lists nothing and says why.
  folderSource({ options: {}, env: {}, cacheDir: null, log: {}, registerSource: (id, impl) => (registered = { id, impl }), on: () => assert.fail("nothing to start") });
  assert.equal((await registered.impl.health()).configured, false);
  assert.deepEqual(await registered.impl.libraries(), []);
});
