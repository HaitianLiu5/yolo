import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchBrowser, openPage, pair, playingPast, waitFor } from "./browser.js";
import { makeMedia, mediaOrigin } from "./fixtures.js";
import { OWNER, startYolo } from "./yolo-stack.js";

// A home that fills itself (Agent Note 2026-11-04-living-home-and-media-pool):
// from one thing the owner watched, with no sign-in, model, or agent, the home
// shows what is on, what is new, and replays that give nothing away.

// A source whose item belongs to a schedule and a channel, each with something
// to show, and that plays anything from the HLS fixture.
const plugin = (hls) => `
const NOW = Date.now();
const game = (id, state, at, left, right) => ({
  source: { id }, title: left + " vs " + right, at, live: { state, startsAt: at },
  matchup: { left: { name: left, score: 51 }, right: { name: right, score: 46 }, period: "Q2 3:23" },
});
const ENTRIES = {
  "schedule:league": [game("game-on", "live", NOW - 3600000, "Lakers", "Kings"), game("game-over", "ended", NOW - 7200000, "76ers", "Pistons")],
  "channel:fighters": [
    { source: { id: "upload-1" }, title: "Round 6 Division F", duration: 900, at: NOW - 3600000 },
    { source: { id: "upload-2" }, title: "Round 6 interviews", duration: 300, at: NOW - 7200000 },
    { source: { id: "round-7" }, title: "Round 7 Division S", live: { state: "upcoming", startsAt: NOW + 3 * 86400000 }, at: NOW + 3 * 86400000 },
  ],
};
export default (yolo) => yolo.registerSource("feedtest", {
  follows: () => [{ id: "schedule:league", kind: "schedule", title: "League" }, { id: "channel:fighters", kind: "channel", title: "Fighters" }],
  fresh: async (follow) => ({ entries: ENTRIES[follow.id] ?? [] }),
  describe: async (source) => ({ title: source.id, duration: 8 }),
  prepare: async (source) => ({
    title: source.id, duration: 8, startTime: 0, parents: [],
    input: { type: "hls", url: ${JSON.stringify(hls)} },
    tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
  }),
});
`;

const texts = (page, selector) => page.locator(selector).allInnerTexts();

test("one thing watched fills the home: what is on with its score, what is new and why, replays without a score, and it plays", { timeout: 180_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "yolo-e2e-feed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await makeMedia(dir, { seconds: 8 });
  const media = await mediaOrigin(t, dir);
  const source = join(dir, "source-feedtest");
  await mkdir(source);
  await writeFile(join(source, "package.json"), JSON.stringify({
    name: "source-feedtest", version: "0.0.0", type: "module",
    yolo: { node: "./node.js", title: { en: "Feed test" }, summary: { en: "Feed test" }, kinds: ["source"], api: "0.x" },
  }));
  await writeFile(join(source, "node.js"), plugin(`${media.url}/hls/index.m3u8`));
  const watched = JSON.stringify({ plugin: "feedtest", id: "watched" });
  const yolo = await startYolo(t, {
    pluginConfig: { plugins: [{ source }] },
    seed: `INSERT INTO history (user_id, source_key, source, title, position, duration, play_count, updated_at, watched_at)
      VALUES ('${OWNER}', 'feedtest:watched', '${watched}', 'A long broadcast', 900, 1000, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL);`,
  });
  const context = await launchBrowser(t);
  const { page, errors } = await openPage(context, yolo.origin);
  await pair(yolo, page, { kind: "browser" });

  await waitFor(page, () => document.querySelectorAll("#live-list .browse-card").length > 0, null, "what is on", 40_000);
  assert.deepEqual(await texts(page, "#live-list .matchup-score"), ["51 – 46"]);
  assert.deepEqual(await texts(page, "#live-list .card-badge"), ["Live"]);
  assert.match((await texts(page, "#live-list .browse-card-meta"))[0], /Q2 3:23/);

  assert.deepEqual(await texts(page, "#replays-list .browse-card-title"), ["76ers vs Pistons"]);
  assert.deepEqual(await texts(page, "#replays-list .matchup-score"), ["vs"], "an ended game gives nothing away");
  assert.doesNotMatch((await page.locator("#replays-list").innerText()), /51|46|Q2/);

  assert.deepEqual(await texts(page, "#new-list .browse-card-title"), ["Round 7 Division S", "Round 6 Division F", "Round 6 interviews"]);
  assert.match((await texts(page, "#new-list .browse-card-meta"))[1], /From Fighters/);

  // A long press shows a card's actions; Not interested goes at once, and
  // stays gone.
  const card = page.locator("#new-list .browse-card").filter({ hasText: "interviews" });
  await card.locator(".browse-card-primary").hover();
  await page.mouse.down();
  await waitFor(page, () => document.getElementById("new-section").classList.contains("edit-mode"), null, "edit mode");
  await page.mouse.up();
  await card.locator(".card-action-remove").click();
  assert.deepEqual(await texts(page, "#new-list .browse-card-title"), ["Round 7 Division S", "Round 6 Division F"]);
  await page.locator("#new-section .section-done").click();
  const feedback = page.waitForResponse((response) => response.url().endsWith("/v1/feed/rows?limit=30"));
  await page.reload();
  await feedback;
  await waitFor(page, () => document.querySelectorAll("#new-list .browse-card").length === 2, null, "the rows again");
  await page.waitForTimeout(500);
  assert.deepEqual(await texts(page, "#new-list .browse-card-title"), ["Round 7 Division S", "Round 6 Division F"]);

  // What has not aired says when it does; what is on plays.
  await page.locator("#new-list .browse-card").first().locator(".browse-card-primary").click();
  await waitFor(page, () => /Round 7 Division S starts/.test(document.body.textContent), null, "when it starts");
  await page.locator("#live-list .browse-card-primary").click();
  await playingPast(page, 1, "the game on now");
  assert.deepEqual(errors, []);
});
