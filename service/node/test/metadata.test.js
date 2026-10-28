import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signNodeRequest } from "@useyolo/core";
import { createNodeApp } from "../src/app.js";
import { loadPlugins } from "../src/plugins.js";

// Metadata on the node (Agent Note 2026-10-25-metadata-plugins): the model
// says which work an item is, a metadata plugin confirms it against its
// records, and the item's details become the work's.

const secret = "node-test-secret";
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const UPLOAD = "救援高手/Nathan For You-第一季 [译制 by 电波字幕组][美剧] p08 救援高手.Nathan.For.You.S01E08.WEB-720p";
const PART_TITLES = ["p07 救援高手.Nathan.For.You.S01E07", UPLOAD];

// A web source with a two-part upload, a file-backed library item, and an
// item titled only by a clip.
function webSource() {
  const details = {
    "BV1-7": { kind: "video", title: PART_TITLES[0], duration: 1300, people: [{ name: "某UP主", role: "channel" }] },
    "BV1-8": { kind: "video", title: UPLOAD, description: "搬运", duration: 1320, people: [{ name: "某UP主", role: "channel" }], url: "https://www.bilibili.com/video/BV1?p=8" },
    clip: { kind: "video", title: "Nathan For You 搞笑片段", duration: 200 },
    film: { kind: "movie", title: "Local Film", duration: 6000 },
  };
  return (yolo) => yolo.registerSource("web", {
    describe: async (source) => ({ title: details[source.id].title, duration: details[source.id].duration }),
    details: async (source) => details[source.id],
    sequence: async (source) => (source.id.startsWith("BV1-")
      ? { title: "救援高手", index: source.id === "BV1-7" ? 0 : 1, items: [{ source: { id: "BV1-7" }, title: PART_TITLES[0] }, { source: { id: "BV1-8" }, title: UPLOAD }] }
      : null),
    file: async (source) => (source.id === "film" ? { path: "/media/Local Film (2020)/film.mkv", size: 10 } : null),
  });
}

// A folder of files: a clearly named episode, a phone video, and a film
// whose source knows it is one.
const FILES = { ep: "Nathan.For.You.S01E08.720p.WEB.mkv", phone: "IMG_2041.mp4", film: "Local Film (2020).mkv" };
function folderSource() {
  return (yolo) => yolo.registerSource("folder", {
    libraries: async () => [{ id: "home", title: "Home" }],
    // A frame of each file stands in for a picture until the work is known.
    items: async () => ({ items: Object.entries(FILES).map(([id, name]) => ({ id, kind: id === "film" ? "movie" : "video", title: name, ...(id === "film" ? {} : { artwork: "frame" }) })) }),
    details: async (source) => ({ kind: source.id === "film" ? "movie" : "video", title: FILES[source.id], duration: 1320 }),
    file: async (source) => ({ path: `/media/${FILES[source.id]}`, size: 1 }),
  });
}

// A database with one show of one name, two of another, and a film.
function database(calls) {
  const show = { id: "tv/1", kind: "show", title: "Nathan For You", year: 2013 };
  return (yolo) => yolo.registerMetadata("db", {
    async identify(subject) {
      calls.push(subject);
      const name = subject.identity?.show?.title ?? subject.hints.titles[0];
      const season = subject.identity?.season ?? subject.hints.season;
      const episode = subject.identity?.episode ?? subject.hints.episode;
      if (name === "Nathan For You" || name === "Nathan for You") return [{ ...show, kind: "episode", season, episode, confidence: 0.95, ids: { db: "tv/1" } }];
      if (name === "Twin") return [{ id: "tv/2", kind: "show", title: "Twin", year: 1990, confidence: 0.9 }, { id: "tv/3", kind: "show", title: "Twin", year: 2019, confidence: 0.88 }];
      return [];
    },
    async lookup(found) {
      if (found.id === "film/9") return { kind: "movie", title: "Local Film", poster: "local:poster", attribution: { text: "From the database." } };
      return {
        kind: "episode",
        title: `Episode ${found.episode}`,
        description: "Nathan helps a business.",
        series: { title: "Nathan For You", season: found.season, episode: found.episode, episodeTitle: found.episode === 8 ? "Private Investigator / Taxi Company" : "Episode 7" },
        show: { title: "Nathan For You", poster: "https://img.example/show.jpg" },
        people: [{ name: "Nathan Fielder", role: "cast", photo: "https://img.example/nathan.jpg" }],
        attribution: { text: "From the database.", url: "https://db.example/" },
      };
    },
    async search(query) {
      return query === "Twin" ? [{ id: "tv/2", kind: "show", title: "Twin", year: 1990, confidence: 0.9 }] : [];
    },
    async image(ref, { file }) {
      return ref === "poster" && file ? new Response("jpeg", { headers: { "content-type": "image/jpeg" } }) : new Response(null, { status: 404 });
    },
  });
}

// A model that answers from the title, counting its calls.
function model(asked, answer) {
  return (yolo) => yolo.registerModelProvider("fake", {
    async complete(request) {
      const facts = JSON.parse(request.messages[0].content);
      asked.push(facts);
      return { json: answer(facts), text: "", model: "fake", source: "test" };
    },
  });
}

const identityOf = (facts) => {
  if (/片段/.test(facts.title)) return { kind: "other", showTitle: null, originalTitle: null, year: null, title: null, season: null, episode: null, episodeTitle: null, confidence: 0.95, reason: "A clip.", parts: [] };
  return {
    kind: "episode", showTitle: "Nathan for You", originalTitle: "Nathan for You", year: 2013, title: null, season: 1, episode: 8,
    episodeTitle: "Private Investigator / Taxi Company", confidence: 0.97, reason: "S01E08 and p08 agree.",
    parts: facts.parts.map(({ index }) => ({ index, season: 1, episode: 7 + index, episodeTitle: null })),
  };
};

async function node(t, factories) {
  const dir = mkdtempSync(join(tmpdir(), "yolo-metadata-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plugins = await loadPlugins(factories.map((factory, index) => ({ name: `p${index}`, enabled: true, options: {}, factory })), { logger: quiet });
  await plugins.start();
  const app = createNodeApp({ secret, plugins, metadataCacheDir: dir, logger: quiet });
  const call = async (method, path, body) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers = await signNodeRequest(secret, { method, path, body: payload });
    return app.request(path, { method, headers: { ...headers, "content-type": "application/json" }, body: payload || undefined });
  };
  const details = async (id, match, plugin = "web") => (await call("GET", `/internal/v1/details?source=${encodeURIComponent(JSON.stringify({ plugin, id }))}${match ? `&match=${encodeURIComponent(JSON.stringify(match))}` : ""}`)).json();
  return { call, details };
}

test("an upload the model identified and a record confirmed shows as the episode, and its next part costs no model call", async (t) => {
  const asked = [];
  const calls = [];
  const { details } = await node(t, [webSource(), database(calls), model(asked, identityOf)]);

  const first = await details("BV1-7");
  assert.equal(first.title, "Nathan For You S1E7 — Episode 7");
  const item = await details("BV1-8");
  assert.equal(item.kind, "episode");
  assert.equal(item.title, "Nathan For You S1E8 — Private Investigator / Taxi Company");
  assert.equal(item.description, "Nathan helps a business.");
  assert.deepEqual(item.people, [{ name: "Nathan Fielder", role: "cast", photo: "https://img.example/nathan.jpg" }]);
  assert.equal(item.duration, 1320);
  assert.equal(item.upload.title, UPLOAD);
  assert.equal(item.upload.channel, "某UP主");
  assert.deepEqual(item.metadata, { plugin: "db", id: "tv/1", confidence: 0.95, origin: "auto", from: "records", attributions: [{ text: "From the database.", url: "https://db.example/" }] });
  // The model got the item and the other parts' titles, and the parser's reading.
  assert.equal(asked.length, 1, "the second part's identity came with the first call");
  assert.deepEqual(asked[0].parts.map(({ title }) => title), PART_TITLES);
  assert.deepEqual(asked[0].hints.agree, ["S01E07", "p07"]);
  assert.equal(calls[0].identity.show.title, "Nathan for You");
});

test("a database that fails to describe the work costs only its own fields", async (t) => {
  const broken = (yolo) => yolo.registerMetadata("broken", {
    identify: async (subject) => [{ id: "x", kind: "episode", title: "Nathan For You", season: subject.hints.season, episode: subject.hints.episode, confidence: 1 }],
    lookup: async () => {
      throw new Error("The operation was aborted due to timeout");
    },
  });
  const { details } = await node(t, [webSource(), broken, database([])]);
  const item = await details("BV1-8");
  assert.equal(item.title, "Nathan For You S1E8 — Private Investigator / Taxi Company");
  assert.equal(item.description, "Nathan helps a business.");
});

test("a play shows the cached match's title at once and only queues what it has not identified", async (t) => {
  const asked = [];
  const { call, details } = await node(t, [webSource(), database([]), model(asked, identityOf)]);
  const describe = async () => (await call("POST", "/internal/v1/metadata", { source: { plugin: "web", id: "BV1-8" } })).json();

  assert.equal((await describe()).title, UPLOAD, "nothing waits for identification");
  await details("BV1-8");
  const described = await describe();
  assert.equal(described.title, "Nathan For You S1E8 — Private Investigator / Taxi Company");
  assert.deepEqual(described.series, { title: "Nathan For You", season: 1, episode: 8 });
  assert.equal(described.poster, "https://img.example/show.jpg");
  assert.equal(asked.length, 1);
});

test("a clip the model calls other stays plain, and asks no plugin", async (t) => {
  const calls = [];
  const { details } = await node(t, [webSource(), database(calls), model([], identityOf)]);
  const item = await details("clip");
  assert.equal(item.title, "Nathan For You 搞笑片段");
  assert.equal(item.kind, "video");
  assert.equal(item.metadata, undefined);
  assert.equal(calls.length, 0);
});

test("without a model the parser's hints find the record; with a model and no record the identity names the item", async (t) => {
  const plain = await node(t, [webSource(), database([])]);
  assert.equal((await plain.details("BV1-8")).title, "Nathan For You S1E8 — Private Investigator / Taxi Company");

  const noRecords = await node(t, [webSource(), model([], identityOf)]);
  // A model without metadata plugins changes nothing: no plugin, no metadata.
  assert.equal((await noRecords.details("BV1-8")).title, UPLOAD);

  const empty = (yolo) => yolo.registerMetadata("empty", { identify: async () => [] });
  const identityOnly = await node(t, [webSource(), empty, model([], identityOf)]);
  const item = await identityOnly.details("BV1-8");
  assert.equal(item.title, "Nathan for You S1E8 — Private Investigator / Taxi Company", "the model's names");
  assert.equal(item.description, "搬运");
  assert.equal(item.metadata.from, "model");
});

test("two records of one name leave candidates for the owner, and the owner's choice or refusal wins", async (t) => {
  const twin = (facts) => ({ ...identityOf(facts), showTitle: "Twin", originalTitle: "Twin", episode: 2 });
  const { details, call } = await node(t, [webSource(), database([]), model([], twin)]);
  const unsure = await details("BV1-8");
  assert.equal(unsure.title, UPLOAD);
  assert.deepEqual(unsure.metadata.candidates.map(({ id, year }) => [id, year]), [["tv/2", 1990], ["tv/3", 2019]]);

  const chosen = await details("BV1-8", { plugin: "db", candidate: { id: "tv/1", kind: "episode", title: "Nathan For You", season: 1, episode: 8 } });
  assert.equal(chosen.title, "Nathan For You S1E8 — Private Investigator / Taxi Company");
  assert.equal(chosen.metadata.origin, "owner");
  const refused = await details("BV1-8", { none: true });
  assert.equal(refused.title, UPLOAD);
  assert.deepEqual(refused.metadata, { origin: "owner" });

  const found = await (await call("GET", "/internal/v1/metadata/search?q=Twin")).json();
  assert.deepEqual(found.results.map(({ plugin, id }) => [plugin, id]), [["db", "tv/2"]]);
});

test("a picture only the plugin can read becomes the item's artwork variant", async (t) => {
  const local = (yolo) => yolo.registerMetadata("local", {
    identify: async (subject) => (subject.file ? [{ id: "film/9", kind: "movie", title: "Local Film", confidence: 1 }] : []),
    lookup: async () => ({ kind: "movie", title: "Local Film", description: "From the NFO.", poster: "local:poster" }),
    image: async (ref, { file }) => new Response(`${ref} beside ${file.path}`, { headers: { "content-type": "image/jpeg" } }),
  });
  const { details, call } = await node(t, [webSource(), local]);
  const item = await details("film");
  assert.equal(item.description, "From the NFO.");
  assert.equal(item.poster, "/v1/library/items/web%3Afilm/artwork?variant=m-local-poster");
  const response = await call("GET", "/internal/v1/library/items/web%3Afilm/artwork?variant=m-local-poster");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "poster beside /media/Local Film (2020)/film.mkv");
});

test("a clearly named file is confirmed by its title hints alone; only a file that reads unclearly asks the model", async (t) => {
  const asked = [];
  const other = () => ({ kind: "other", showTitle: null, originalTitle: null, year: null, title: null, season: null, episode: null, episodeTitle: null, confidence: 0.9, reason: "A phone video.", parts: [] });
  const { details } = await node(t, [folderSource(), database([]), model(asked, other)]);
  const folder = async (id) => details(id, null, "folder");
  assert.equal((await folder("ep")).title, "Nathan For You S1E8 — Private Investigator / Taxi Company");
  assert.equal(asked.length, 0, "no model call for a name a record confirms");
  assert.equal((await folder("phone")).title, "IMG_2041.mp4");
  assert.deepEqual(asked.map(({ file }) => file), ["IMG_2041.mp4"]);
});

test("a library listing shows the work a file was matched to once it is known, and leaves the source's own works alone", async (t) => {
  const calls = [];
  const { call } = await node(t, [folderSource(), database(calls)]);
  const list = async () => (await (await call("GET", "/internal/v1/library/folder%3Ahome/items")).json()).items;
  assert.deepEqual((await list()).map(({ title }) => title), Object.values(FILES), "nothing waits for identification");
  for (let tries = 0; tries < 50 && calls.length < 2; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const [episode, phone, film] = await list();
  assert.equal(episode.title, "Nathan For You S1E8 — Private Investigator / Taxi Company");
  assert.equal(episode.kind, "episode");
  assert.deepEqual(episode.series, { title: "Nathan For You", season: 1, episode: 8 });
  assert.equal(episode.poster, "https://img.example/show.jpg");
  assert.equal(episode.thumbnail, "https://img.example/show.jpg", "the work's picture, not the frame");
  assert.equal(phone.title, "IMG_2041.mp4");
  assert.equal(phone.thumbnail, "/v1/library/items/folder%3Aphone/artwork?variant=frame", "an unmatched file keeps its frame");
  assert.deepEqual(film, { id: "folder:film", kind: "movie", title: "Local Film (2020).mkv", thumbnail: null });
  assert.ok(!calls.some((subject) => subject.sourceKey === "folder:film"), "a source's own work is not identified for a listing");
});
