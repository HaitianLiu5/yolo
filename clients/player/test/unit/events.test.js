import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { eventLine } from "../../src/events.js";
import { useLanguage } from "../../src/i18n.js";

afterEach(() => useLanguage("en"));

const NOW = new Date(2026, 10, 5, 12, 0);
const sides = [{ name: "76人", score: 112 }, { name: "活塞", score: 106 }];
const at = (month, day, hour = 8) => new Date(2026, month, day, hour, 30).toISOString();

test("a live event says where it is and its score; one that ended never says its score", () => {
  useLanguage("zh-Hans");
  assert.equal(eventLine({ status: "live", progress: "第3节 05:12", sides }, { now: NOW }), "直播 · 第3节 05:12 · 112–106");
  assert.equal(eventLine({ status: "live" }, { now: NOW }), "直播");
  assert.equal(eventLine({ status: "live", sides: [{ name: "76人" }, { name: "活塞" }] }, { now: NOW }), "直播");
  const ended = eventLine({ status: "ended", startsAt: at(10, 4), competition: "NBA常规赛", sides }, { now: NOW });
  assert.equal(ended, "11月4日 · NBA常规赛");
  assert.doesNotMatch(ended, /112/);
});

test("what is to come says when, and today is today", () => {
  useLanguage("zh-Hans");
  const today = eventLine({ status: "upcoming", startsAt: at(10, 5, 20), competition: "NBA杯" }, { now: NOW });
  assert.match(today, /^今天 20:30 · NBA杯$/);
  assert.match(eventLine({ status: "upcoming", startsAt: at(10, 7) }, { now: NOW }), /^11月7日 08:30$/);
  assert.equal(eventLine({ status: "ended", startsAt: at(10, 5), sides }, { now: NOW }), "今天");
  useLanguage("en");
  assert.match(eventLine({ status: "ended", startsAt: at(10, 4), competition: "NBA" }, { now: NOW }), /^Nov 4 · NBA$/);
});

test("an event that says little still gives a line", () => {
  assert.equal(eventLine(undefined), "");
  assert.equal(eventLine({ status: "ended" }, { now: NOW }), "");
  assert.equal(eventLine({ status: "ended", startsAt: "not a time", competition: "NBA" }, { now: NOW }), "NBA");
});
