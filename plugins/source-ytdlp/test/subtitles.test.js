import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSubtitleStore } from "../src/subtitles.js";

// The disk cache of downloaded WebVTT: no network.

test("a downloaded subtitle is served from the disk for a day; after that the old text is served at once and downloaded again behind it", async (t) => {
  const dir = mkdtempSync(`${tmpdir()}/yolo-subs-`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let time = Date.now();
  let text = "first";
  let status = 200;
  let asked = 0;
  const fetchImpl = async () => (asked += 1, new Response(`WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${text}\n`, { status }));
  const store = () => createSubtitleStore({ dir, fetchImpl, now: () => time });
  const entry = { key: "zh-Hans", ext: "vtt", url: "https://subs.example/zh.vtt" };
  assert.match(await store().get("video", entry), /first/);
  text = "corrected";
  time += 23 * 3_600_000;
  assert.match(await store().get("video", entry), /first/);
  assert.equal(asked, 1);
  time += 2 * 3_600_000;
  // The site refuses: the day-old text is better than none, and the failed
  // refresh is only logged.
  const logged = [];
  const refreshed = (count) => new Promise((resolve) => {
    const check = () => (asked >= count && logged.length + written() >= count - 1 ? resolve() : setTimeout(check, 5));
    check();
  });
  // Refreshes that ended: the failed ones are logged, the others replaced the file.
  const written = () => (readFileSync(file, "utf8").includes("corrected") ? 1 : 0);
  const file = join(dir, "subs", readdirSync(join(dir, "subs"))[0], "sub_zh-Hans.vtt");
  status = 429;
  assert.match(await createSubtitleStore({ dir, fetchImpl, now: () => time, log: { debug: (line) => logged.push(line) } }).get("video", entry), /first/);
  await refreshed(2);
  assert.equal(logged.length, 1);
  // The site answers, however slowly: this play gets the old text without
  // waiting, two at once ask the site once, and the next gets the new text.
  status = 200;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const slow = createSubtitleStore({ dir, fetchImpl: async (...args) => (await held, fetchImpl(...args)), now: () => time });
  assert.match(await slow.get("video", entry), /first/);
  assert.match(await slow.get("video", entry), /first/);
  release();
  await refreshed(3);
  assert.equal(asked, 3);
  // The new file is as old as the real clock says.
  time = Date.now();
  assert.match(await store().get("video", entry), /corrected/);
  assert.equal(asked, 3);
});
