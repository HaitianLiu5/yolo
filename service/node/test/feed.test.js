import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFeed } from "../src/feed.js";
import { createSourceRegistry } from "../src/sources.js";

// What Yolo finds by itself for the owner
// (Agent Note 2026-11-04-living-home-and-media-pool): what becomes an interest,
// how the snapshot is read and kept, and the rows every home draws.

const NOW = Date.parse("2026-11-05T04:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEAGUE = { id: "schedule:nba", kind: "schedule", title: "NBA" };
const team = (id, title) => ({ id: `team:${id}`, kind: "team", title, within: "schedule:nba" });
const CHANNEL = { id: "channel:fighters", kind: "channel", title: "Fighters", url: "https://video.test/fighters" };

const game = (id, state, fields = {}) => ({
  source: { id: `game-${id}` },
  title: `${id} vs others`,
  at: NOW,
  live: { state, startsAt: fields.startsAt ?? NOW },
  matchup: { left: { name: id, score: 51 }, right: { name: "others", score: 46 }, period: "Q2 3:23" },
  related: fields.related ?? [],
  ...fields,
});
const upload = (id, fields = {}) => ({ source: { id }, title: `Upload ${id}`, at: NOW - HOUR, duration: 600, by: { title: "Fighters" }, ...fields });

// A source whose items belong to what `belongs` says, and whose follows have
// what `has` says.
function feedWith({ belongs = {}, has = {}, dir = null, now = () => NOW, loaded = true } = {}) {
  const sources = createSourceRegistry();
  const asked = { follows: [], fresh: [] };
  if (loaded) {
    sources.add("site", {
      async follows(source) {
        asked.follows.push(source.id);
        if (belongs[source.id] instanceof Error) throw belongs[source.id];
        return belongs[source.id] ?? [];
      },
      async fresh(follow) {
        asked.fresh.push(follow.id);
        if (has[follow.id] instanceof Error) throw has[follow.id];
        return { entries: has[follow.id] ?? [] };
      },
    }, "test");
  }
  const feed = createFeed({ sources, dir, now, paceMs: 0, passEveryMs: 3_600_000 });
  return { feed, asked, sources };
}

const play = (id, fields = {}) => ({ source: { plugin: "site", id }, title: `Play ${id}`, position: 700, duration: 1000, at: NOW - HOUR, watched: false, ...fields });
const titles = (row) => row?.items.map((item) => item.title);
const rowOf = (answer, id) => answer.rows.find((row) => row.id === id);

async function digestAndRead(feed, plays, interests = []) {
  const first = feed.digest([{ id: "owner", plays, interests }]);
  await feed.settled();
  // What the first pass learned about its plays, which the next answer proposes.
  const second = feed.digest([{ id: "owner", plays, interests }]);
  await feed.settled();
  return { first, second };
}

test("one long play is enough to follow its channel; a press taken back is not", async () => {
  const { feed, asked } = feedWith({ belongs: { long: [CHANNEL], tapped: [{ ...CHANNEL, id: "channel:other", title: "Other" }] } });
  const { second } = await digestAndRead(feed, [
    play("long", { position: 15119, duration: 15412 }),
    play("tapped", { position: 12, duration: 3600 }),
  ]);
  assert.deepEqual(second.proposed.owner.map((interest) => interest.title), ["Fighters"]);
  assert.deepEqual(second.proposed.owner[0].follows[0].id, "site:channel:fighters");
  assert.deepEqual(asked.follows, ["long"], "a press taken back asks nobody");
  feed.close();
});

test("two plays are enough for a channel, and a team needs two whatever the one play was", async () => {
  const belongs = {
    a: [LEAGUE, team("sixers", "76ers"), team("pistons", "Pistons")],
    b: [LEAGUE, team("sixers", "76ers"), team("bulls", "Bulls")],
    c: [{ ...CHANNEL, id: "channel:short" , title: "Short clips" }],
    d: [{ ...CHANNEL, id: "channel:short" , title: "Short clips" }],
  };
  const { feed } = feedWith({ belongs });
  const { second } = await digestAndRead(feed, [
    play("a", { watched: true }), play("b", { position: 120, duration: null }),
    play("c", { position: 70, duration: 600 }), play("d", { position: 70, duration: 600 }),
  ]);
  assert.deepEqual(second.proposed.owner.map((interest) => interest.title).sort(), ["76ers", "NBA", "Short clips"]);
  feed.close();
});

test("a muted interest is not proposed again and shows nothing; plays older than the window do not count", async () => {
  const { feed, asked } = feedWith({ belongs: { a: [CHANNEL], old: [{ ...CHANNEL, id: "channel:old", title: "Old" }] }, has: { "channel:fighters": [upload("v1")] } });
  const plays = [play("a", { watched: true }), play("old", { watched: true, at: NOW - 40 * DAY })];
  const interests = [{ key: "site:channel:fighters", state: "muted", follows: [] }];
  const { second } = await digestAndRead(feed, plays, interests);
  assert.deepEqual(second.proposed.owner, []);
  assert.deepEqual(asked.follows, ["a"]);
  assert.deepEqual(asked.fresh, []);
  assert.deepEqual(feed.rows("owner").rows, []);
  feed.close();
});

test("a game being played tops the home with its score; an ended one is a replay without it; a followed team goes first", async () => {
  const belongs = { a: [LEAGUE, team("sixers", "76ers")], b: [LEAGUE, team("sixers", "76ers")] };
  const related = ["team:sixers"];
  const has = {
    "schedule:nba": [
      game("Lakers", "live"),
      game("Sixers", "live", { related }),
      game("Bucks", "ended", { startsAt: NOW - 5 * HOUR }),
      game("Sixers-last", "ended", { startsAt: NOW - 20 * HOUR, related }),
      game("Old", "ended", { startsAt: NOW - 72 * HOUR }),
      game("Soon", "upcoming", { startsAt: NOW + 2 * HOUR }),
      game("Sixers-tomorrow", "upcoming", { startsAt: NOW + 20 * HOUR, related }),
      game("Later", "upcoming", { startsAt: NOW + 20 * HOUR }),
    ],
  };
  const { feed } = feedWith({ belongs, has });
  await digestAndRead(feed, [play("a", { watched: true }), play("b", { watched: true })]);
  const answer = feed.rows("owner");
  assert.deepEqual(titles(rowOf(answer, "live")), ["Sixers vs others", "Lakers vs others", "Sixers-tomorrow vs others", "Soon vs others"]);
  assert.deepEqual(titles(rowOf(answer, "replays")), ["Sixers-last vs others", "Bucks vs others"]);
  assert.equal(rowOf(answer, "new"), undefined, "games to come no followed team plays in say nothing yet");

  const [playing] = rowOf(answer, "live").items;
  assert.deepEqual(playing.matchup, { left: { name: "Sixers", score: "51" }, right: { name: "others", score: "46" }, period: "Q2 3:23" });
  assert.deepEqual(playing.why, { kind: "team", title: "76ers", interest: "site:team:sixers" });
  assert.equal(playing.related, undefined);
  const [replay] = rowOf(answer, "replays").items;
  assert.deepEqual(replay.matchup, { left: { name: "Sixers-last" }, right: { name: "others" } }, "no score or period once it ended");
  feed.close();
});

test("new uploads say why, newest ahead, and leave what the owner finished", async () => {
  const has = {
    "channel:fighters": [
      upload("fresh", { at: NOW - HOUR }),
      upload("week", { at: NOW - 7 * DAY }),
      upload("ancient", { at: NOW - 30 * DAY }),
      upload("seen", { at: NOW - 2 * HOUR }),
      upload("next-round", { live: { state: "upcoming", startsAt: NOW + 3 * DAY }, at: NOW + 3 * DAY, duration: null }),
      upload("on-air", { live: { state: "live" }, at: null, duration: null }),
    ],
  };
  const { feed } = feedWith({ belongs: { a: [CHANNEL] }, has });
  await digestAndRead(feed, [play("a", { watched: true }), play("seen", { watched: true })]);
  const answer = feed.rows("owner");
  assert.deepEqual(titles(rowOf(answer, "new")), ["Upload next-round", "Upload fresh", "Upload week"]);
  assert.deepEqual(rowOf(answer, "new").items[1].why, { kind: "channel", title: "Fighters", interest: "site:channel:fighters" });
  assert.deepEqual(titles(rowOf(answer, "live")), ["Upload on-air"]);
  feed.close();
});

test("one channel does not fill the new row: interests take turns", async () => {
  const other = { ...CHANNEL, id: "channel:league", title: "League" };
  const has = {
    "channel:fighters": [upload("f1", { at: NOW - HOUR }), upload("f2", { at: NOW - 2 * HOUR }), upload("f3", { at: NOW - 3 * HOUR })],
    "channel:league": [upload("l1", { at: NOW - 4 * HOUR })],
  };
  const { feed } = feedWith({ belongs: { a: [CHANNEL], b: [other] }, has });
  await digestAndRead(feed, [play("a", { watched: true }), play("b", { watched: true })]);
  assert.deepEqual(titles(rowOf(feed.rows("owner"), "new")), ["Upload f1", "Upload l1", "Upload f2", "Upload f3"]);
  feed.close();
});

test("a profile with more than it can read is not forever reading; a digest that stopped coming goes", async () => {
  let time = NOW;
  const many = Array.from({ length: 40 }, (_, index) => ({ ...CHANNEL, id: `channel:${index}`, title: `Channel ${index}` }));
  const { feed, asked } = feedWith({ belongs: { a: many }, now: () => time });
  await digestAndRead(feed, [play("a", { watched: true })]);
  assert.equal(new Set(asked.fresh).size, 30);
  assert.equal(feed.rows("owner").reading, false);

  time += 8 * DAY;
  feed.digest([{ id: "other", plays: [], interests: [] }]);
  await feed.settled();
  assert.equal(feed.rows("owner").needsDigest, true, "a home asks again");
  feed.close();
});

test("a home with no digest asks for one, and says it is reading until what it follows has answered", async () => {
  const { feed } = feedWith({ belongs: { a: [CHANNEL] }, has: { "channel:fighters": [upload("v1")] } });
  assert.deepEqual(feed.rows("owner").needsDigest, true);
  const plays = [play("a", { watched: true })];
  feed.digest([{ id: "owner", plays, interests: [] }]);
  assert.equal(feed.rows("owner").reading, true);
  await feed.settled();
  await feed.settled();
  const answer = feed.rows("owner");
  assert.equal(answer.needsDigest, false);
  assert.equal(answer.reading, false);
  assert.deepEqual(titles(rowOf(answer, "new")), ["Upload v1"]);
  feed.close();
});

test("profiles keep their own: another profile's plays give this one nothing", async () => {
  const { feed } = feedWith({ belongs: { a: [CHANNEL] }, has: { "channel:fighters": [upload("v1")] } });
  feed.digest([{ id: "owner", plays: [play("a", { watched: true })], interests: [] }, { id: "prf_family", plays: [], interests: [] }]);
  await feed.settled();
  assert.equal(rowOf(feed.rows("owner"), "new").items.length, 1);
  assert.deepEqual(feed.rows("prf_family").rows, []);
  assert.equal(feed.rows("prf_new").needsDigest, true);
  feed.close();
});

test("a failed read keeps what it had; an item's lookup that failed is asked again later, not every pass", async () => {
  let time = NOW;
  const has = { "channel:fighters": [upload("v1")] };
  const belongs = { a: [CHANNEL], b: new Error("site down") };
  const { feed, asked } = feedWith({ belongs, has, now: () => time });
  const plays = [play("a", { watched: true }), play("b", { watched: true })];
  await digestAndRead(feed, plays);
  assert.deepEqual(asked.follows.filter((id) => id === "b").length, 1);

  has["channel:fighters"] = new Error("site down");
  time += 2 * HOUR;
  feed.digest([{ id: "owner", plays: plays.map((entry) => ({ ...entry, at: time - HOUR })), interests: [] }]);
  await feed.settled();
  assert.equal(asked.fresh.length, 2);
  assert.deepEqual(titles(rowOf(feed.rows("owner"), "new")), ["Upload v1"]);

  time += 5 * HOUR;
  feed.digest([{ id: "owner", plays: plays.map((entry) => ({ ...entry, at: time - HOUR })), interests: [] }]);
  await feed.settled();
  assert.equal(asked.follows.filter((id) => id === "b").length, 2, "asked again after six hours");
  feed.close();
});

test("a follow is read when due: often with a game on, hourly with none", async () => {
  let time = NOW;
  const has = { "schedule:nba": [game("Lakers", "live")] };
  const { feed, asked } = feedWith({ belongs: { a: [LEAGUE] }, has, now: () => time });
  const plays = () => [play("a", { watched: true, at: time - HOUR })];
  await digestAndRead(feed, plays());
  const reads = () => asked.fresh.length;
  const before = reads();
  feed.digest([{ id: "owner", plays: plays(), interests: [] }]);
  await feed.settled();
  assert.equal(reads(), before, "not due yet");
  time += 6 * 60_000;
  has["schedule:nba"] = [game("Lakers", "ended", { startsAt: NOW })];
  feed.digest([{ id: "owner", plays: plays(), interests: [] }]);
  await feed.settled();
  assert.equal(reads(), before + 1, "a game on is read within five minutes or so");
  time += 30 * 60_000;
  feed.digest([{ id: "owner", plays: plays(), interests: [] }]);
  await feed.settled();
  assert.equal(reads(), before + 1, "with none on, not for an hour");
  feed.close();
});

test("the snapshot survives a restart, and a turned-off plugin's rows go", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yolo-feed-"));
  try {
    const belongs = { a: [CHANNEL] };
    const has = { "channel:fighters": [upload("v1")] };
    const first = feedWith({ belongs, has, dir });
    await digestAndRead(first.feed, [play("a", { watched: true })]);
    first.feed.close();

    const second = feedWith({ belongs, has, dir });
    assert.deepEqual(titles(rowOf(second.feed.rows("owner"), "new")), ["Upload v1"], "rows at once, from disk");
    second.sources.remove("site");
    assert.deepEqual(second.feed.rows("owner").rows, []);
    second.feed.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the registry stamps what a plugin answers and keeps a score only while a game is played", async () => {
  const sources = createSourceRegistry();
  const entries = [
    { source: { id: "a" }, title: " A vs B ", at: 5, related: ["team:a"], live: { state: "ended", startsAt: 5 }, matchup: { left: { name: "A", score: 3, badge: "https://art.test/a.png" }, right: { name: "B", score: 1 }, period: "Q4" } },
    { source: { id: "b" }, title: "C vs D", live: { state: "live" }, matchup: { left: { name: "C", score: "0" }, right: { name: "D", score: 0 }, period: "Q1" } },
    { source: { id: "c" }, title: "" },
    { title: "no source" },
    { source: { id: "d" }, title: "Odd state", live: { state: "sometime" } },
  ];
  sources.add("site", {
    follows: () => [{ id: "team:a", kind: "team", title: "A", within: "schedule:x" }, { id: "x", kind: "planet", title: "No" }, { kind: "channel", title: "No id" }],
    fresh: async () => ({ entries }),
  }, "test");
  sources.add("plain", {}, "test");
  assert.deepEqual(await sources.follows({ plugin: "site", id: "item" }), [{ id: "site:team:a", plugin: "site", kind: "team", title: "A", within: "site:schedule:x" }]);
  assert.deepEqual(await sources.follows({ plugin: "plain", id: "item" }), []);
  assert.equal(sources.canFollow({ plugin: "plain", id: "item" }), false);
  assert.equal(sources.canFollow({ plugin: "gone", id: "item" }), false);

  const answer = await sources.fresh({ id: "site:schedule:x", plugin: "site", kind: "schedule", title: "X" }, { limit: 10 });
  assert.deepEqual(answer.entries.map((entry) => entry.id), ["site:a", "site:b", "site:d"]);
  assert.deepEqual(answer.entries[0].matchup, { left: { name: "A", badge: "https://art.test/a.png" }, right: { name: "B" } });
  assert.deepEqual(answer.entries[0].related, ["site:team:a"]);
  assert.equal(answer.entries[0].title, "A vs B");
  assert.deepEqual(answer.entries[1].matchup, { left: { name: "C", score: "0" }, right: { name: "D", score: "0" }, period: "Q1" });
  assert.equal(answer.entries[2].live, undefined);
});
