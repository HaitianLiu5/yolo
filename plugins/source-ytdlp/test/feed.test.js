import assert from "node:assert/strict";
import { test } from "node:test";
import { createYtdlpSource, SOURCE_ID } from "../src/node.js";
import { createYtdlp } from "../src/ytdlp.js";

// What Yolo follows for the owner and reads by itself
// (Agent Note 2026-11-04-living-home-and-media-pool), parsing YouTube's channel
// tabs as recorded on 2026-11-06. Games are source-tencent-sports' event
// libraries.

const NOW = Date.parse("2026-11-05T04:08:00Z");
const quiet = { warn() {}, info() {} };

const CHANNEL = { id: "channel:UCu2Fxqf37DAZ0ZhIsd1FZwA", kind: "channel", title: "Capcom Fighters JP", url: "https://www.youtube.com/channel/UCu2Fxqf37DAZ0ZhIsd1FZwA" };
const thumbnails = (id) => [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }, { url: `https://i.ytimg.com/vi/${id}/hq720.jpg` }];
const watch = (id, fields) => ({ id, url: `https://www.youtube.com/watch?v=${id}`, thumbnails: thumbnails(id), ...fields });
const STREAMS = {
  channel: "Capcom Fighters JP",
  entries: [
    watch("farFuture", { title: "Division F 第8節", live_status: "is_upcoming", duration: null, timestamp: null }),
    watch("nextWeek", { title: "Division S 第8節", live_status: "is_upcoming", duration: null, timestamp: null }),
    watch("thisWeek", { title: "Division F 第7節", live_status: "is_upcoming", duration: null, timestamp: null }),
    watch("onAir", { title: "Division S 第7節", live_status: "is_live", duration: null, timestamp: null }),
    watch("bHJ4IMV5cro", { title: "Division S 第6節", live_status: "was_live", duration: 15413, timestamp: 1793404800 }),
  ],
};
const VIDEOS = { channel: "Capcom Fighters JP", entries: [watch("af9XFrFXEdE", { title: "Daigo vs. Mizuha", duration: 680, timestamp: 1793750400 })] };

function youtube({ streams = STREAMS, videos = VIDEOS } = {}) {
  const runs = [];
  const exec = (binary, args, options, callback) => {
    const target = args.at(-1);
    runs.push(args);
    if (target.endsWith("/streams")) return streams ? callback(null, JSON.stringify(streams)) : callback(new Error("x"), "", "ERROR: This channel does not have a streams tab");
    if (target.endsWith("/videos")) return callback(null, JSON.stringify(videos));
    const release = target.includes("premiere") ? 1794400000 : target.includes("thisWeek") ? 1794303000 : 1794900000;
    return callback(null, JSON.stringify({ channel: "Capcom Fighters JP", channel_id: "UCu2Fxqf37DAZ0ZhIsd1FZwA", channel_url: CHANNEL.url, release_timestamp: release }));
  };
  return { runs, exec };
}

test("a YouTube video belongs to its channel; other sites' videos to nothing, asking nobody", async () => {
  const { runs, exec } = youtube();
  const source = createYtdlpSource(createYtdlp({ exec }), { logger: quiet, now: () => NOW });
  const url = "https://www.youtube.com/watch?v=bHJ4IMV5cro";
  assert.deepEqual(await source.follows({ plugin: SOURCE_ID, id: url, url }), [CHANNEL]);
  assert.ok(runs[0].includes("--ignore-no-formats-error"));
  for (const elsewhere of ["https://www.bilibili.com/video/BV1xrnz6gEVD/", "https://sports.qq.com/kbsweb/game.htm?mid=100000:10022600173"]) {
    assert.deepEqual(await source.follows({ plugin: SOURCE_ID, id: elsewhere, url: elsewhere }), []);
  }
  assert.equal(runs.length, 1);
});

test("a channel lists what is on air, its next two broadcasts with their times, and its newest uploads, read without the owner's cookies", async () => {
  const { runs, exec } = youtube();
  const source = createYtdlpSource(createYtdlp({ exec, cookies: ["--cookies", "/secret"] }), { logger: quiet, now: () => NOW });
  const { entries } = await source.fresh(CHANNEL, { limit: 30 });
  assert.deepEqual(entries.map((entry) => [entry.source.url.split("=")[1], entry.live?.state ?? null]), [
    ["af9XFrFXEdE", null], ["nextWeek", "upcoming"], ["thisWeek", "upcoming"], ["onAir", "live"], ["bHJ4IMV5cro", null],
  ]);
  const byId = Object.fromEntries(entries.map((entry) => [entry.source.url.split("=")[1], entry]));
  assert.equal(byId.thisWeek.live.startsAt, 1794303000000);
  assert.equal(byId.thisWeek.at, 1794303000000);
  assert.equal(byId.bHJ4IMV5cro.duration, 15413);
  assert.equal(byId.bHJ4IMV5cro.at, 1793404800000);
  assert.equal(byId.bHJ4IMV5cro.thumbnail, "https://i.ytimg.com/vi/bHJ4IMV5cro/hq720.jpg");
  assert.deepEqual(byId.bHJ4IMV5cro.by, { title: "Capcom Fighters JP", url: CHANNEL.url });
  assert.ok(runs.every((args) => !args.includes("/secret")), "no cookies on what Yolo reads by itself");
});

test("a channel without a streams tab still lists its uploads, and one with neither fails", async () => {
  const { exec } = youtube({ streams: null });
  const source = createYtdlpSource(createYtdlp({ exec }), { logger: quiet, now: () => NOW });
  const { entries } = await source.fresh(CHANNEL, { limit: 30 });
  assert.deepEqual(entries.map((entry) => entry.title), ["Daigo vs. Mizuha"]);

  const refused = createYtdlpSource(createYtdlp({ exec: (binary, args, options, callback) => callback(new Error("x"), "", "ERROR: gone") }), { logger: quiet });
  await assert.rejects(refused.fresh(CHANNEL, { limit: 30 }), /gone/);
});

test("the next two broadcasts are the soonest of both tabs, not the last tab's", async () => {
  // A premiere on the videos tab starts before the streams tab's second broadcast.
  const videos = { ...VIDEOS, entries: [watch("premiere", { title: "Trailer premiere", live_status: "is_upcoming", duration: null, timestamp: null }), ...VIDEOS.entries] };
  const { exec } = youtube({ videos });
  const source = createYtdlpSource(createYtdlp({ exec }), { logger: quiet, now: () => NOW });
  const { entries } = await source.fresh(CHANNEL, { limit: 30 });
  const upcoming = entries.filter((entry) => entry.live?.state === "upcoming").map((entry) => [entry.source.url.split("=")[1], entry.live.startsAt]);
  assert.deepEqual(upcoming, [["premiere", 1794400000000], ["thisWeek", 1794303000000]]);
});
