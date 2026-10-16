import assert from "node:assert/strict";
import test from "node:test";

import { loadSubtitleTracks, MAX_SUBTITLE_RETRY_WAIT_MS, retryAfterMs, subtitleFailureNotice } from "../../src/subtitle-loading.js";

const ZH = { id: "s_zh-Hans", name: "Chinese (Simplified) (auto)", language: "zh-Hans" };
const ZH_HANT = { id: "s_zh-Hant", name: "Chinese (Traditional) (auto)", language: "zh-Hant" };
const EN = { id: "s_en", name: "English (auto)", language: "en" };

// What the owner saw on 2026-10-16: English and YouTube's machine-translated
// Chinese selected, English on screen, and "A subtitle could not be loaded".
test("the notice names the subtitles that did not load", () => {
  assert.equal(subtitleFailureNotice([ZH]), "Chinese (Simplified) (auto) subtitles could not be loaded");
  assert.equal(subtitleFailureNotice([ZH, EN]), "Chinese (Simplified) (auto) and English (auto) subtitles could not be loaded");
  assert.equal(subtitleFailureNotice([ZH, ZH_HANT, EN]), "Chinese (Simplified) (auto), Chinese (Traditional) (auto), and English (auto) subtitles could not be loaded");
  assert.equal(subtitleFailureNotice([{ id: "plex:1", language: "zh" }]), "zh subtitles could not be loaded");
  assert.equal(subtitleFailureNotice([{ id: "x" }]), "A subtitle could not be loaded");
  assert.equal(subtitleFailureNotice([]), null);
});

test("Retry-After is seconds or an HTTP date", () => {
  assert.equal(retryAfterMs("60"), 60_000);
  assert.equal(retryAfterMs("Thu, 15 Oct 2026 20:01:00 GMT", Date.parse("Thu, 15 Oct 2026 20:00:00 GMT")), 60_000);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs("soon"), null);
});

function harness(answers) {
  const asked = [];
  const waits = [];
  let release;
  const waited = new Promise((done) => { release = done; });
  return {
    asked,
    waits,
    release,
    load: async (track) => {
      asked.push(track.id);
      const next = answers[track.id].shift();
      return next;
    },
    wait: (ms) => {
      waits.push(ms);
      return waited;
    },
  };
}

test("a track the node asks to try later loads in the background, and a retry that works says nothing", async () => {
  const run = harness({ "s_zh-Hans": [{ retryAfterMs: 60_000 }, true], s_en: [true] });
  let loadedLater = 0;
  const { failed, later } = await loadSubtitleTracks([ZH, EN], { ...run, loadedLater: () => { loadedLater += 1; } });
  assert.deepEqual(failed, []);
  assert.deepEqual(run.asked, ["s_zh-Hans", "s_en"], "the stream waits for one round only");
  assert.deepEqual(run.waits, [60_000]);
  assert.equal(loadedLater, 0);
  run.release();
  assert.deepEqual(await later, [], "nothing to say");
  assert.deepEqual(run.asked, ["s_zh-Hans", "s_en", "s_zh-Hans"]);
  assert.equal(loadedLater, 1, "the captions follow the track that loaded later");
});

test("a track that never loads is named once, after its second try", async () => {
  const run = harness({ "s_zh-Hans": [{ retryAfterMs: 60_000 }, { retryAfterMs: 120_000 }], "s_zh-Hant": [{ retryAfterMs: null }], s_en: [true] });
  const { failed, later } = await loadSubtitleTracks([ZH, ZH_HANT, EN], run);
  assert.deepEqual(failed, [ZH_HANT], "a failure not worth asking again is final at once");
  run.release();
  assert.deepEqual(await later, [ZH_HANT, ZH]);
  assert.equal(subtitleFailureNotice(await later), "Chinese (Traditional) (auto) and Chinese (Simplified) (auto) subtitles could not be loaded");
});

test("a wait longer than two minutes is not waited for, and a stream that moved on hears nothing", async () => {
  const long = harness({ "s_zh-Hans": [{ retryAfterMs: MAX_SUBTITLE_RETRY_WAIT_MS + 1 }] });
  const { failed } = await loadSubtitleTracks([ZH], long);
  assert.deepEqual(failed, [ZH]);
  assert.deepEqual(long.waits, []);

  let current = true;
  const moved = harness({ "s_zh-Hans": [{ retryAfterMs: 1_000 }, true] });
  const { later } = await loadSubtitleTracks([ZH], { ...moved, current: () => current });
  current = false;
  moved.release();
  assert.deepEqual(await later, []);
  assert.deepEqual(moved.asked, ["s_zh-Hans"], "no second try for a stream that moved on");
});
