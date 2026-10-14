import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommentStore, WINDOW_SECONDS } from "../src/comments.js";
import { createSourceRegistry } from "../src/sources.js";

// A source whose comments come one window at a time (`segmented`) or all at once.
function registry(answer) {
  const calls = [];
  const sources = createSourceRegistry();
  sources.add("segmented", {
    comments: async (source, range) => {
      calls.push(["segmented", source.id, range.start]);
      return answer(source, range);
    },
  }, "test");
  sources.add("plain", {}, "test");
  return { sources, calls };
}

const at = (t, text = `at ${t}`) => ({ t, text, mode: "scroll", color: "#ffffff", size: 1 });

test("the store asks a source once per window, serves ranges from it, and keeps a whole item whole", async () => {
  const { sources, calls } = registry((source, { start }) => (source.id === "whole"
    ? { comments: [at(5), at(400), at(800)], start: 0, end: null }
    : { comments: [at(start + 1), at(start + 2), { t: -1, text: "dropped" }], start, end: start + WINDOW_SECONDS }));
  const store = createCommentStore({ sources });
  const item = { plugin: "segmented", id: "a" };
  const [first, again] = await Promise.all([store.get(item, { start: 0, end: 30 }), store.get(item, { start: 0, end: 30 })]);
  assert.deepEqual(first.comments.map((comment) => comment.t), [1, 2]);
  assert.deepEqual(again, first);
  assert.deepEqual(calls, [["segmented", "a", 0]], "one request for one window");
  // A range across two windows asks only for the new one.
  const across = await store.get(item, { start: 300, end: 400 });
  assert.deepEqual(across.comments.map((comment) => comment.t), [361, 362]);
  assert.deepEqual(calls.map((call) => call[2]), [0, 360]);

  const whole = { plugin: "segmented", id: "whole" };
  assert.deepEqual((await store.get(whole, { start: 390, end: 410 })).comments.map((comment) => comment.t), [400]);
  assert.deepEqual((await store.get(whole, { start: 790, end: 810 })).comments.map((comment) => comment.t), [800]);
  assert.equal(calls.filter((call) => call[1] === "whole").length, 1, "an answer to the end covers every window");
  assert.deepEqual(store.status(), { items: 2, comments: 7 });
});

test("an item without comments, a source without comments(), and a failing source", async () => {
  let now = 0;
  let fail = true;
  const { sources, calls } = registry((source) => {
    if (source.id === "none") return null;
    if (fail) throw new Error("upstream down");
    return { comments: [at(3)], start: 0, end: null };
  });
  const store = createCommentStore({ sources, now: () => now });
  assert.deepEqual(await store.get({ plugin: "segmented", id: "none" }, { start: 0, end: 30 }), { available: false, start: 0, end: 30, complete: true, comments: [] });
  assert.equal(store.has({ plugin: "plain", id: "x" }), false);
  const item = { plugin: "segmented", id: "flaky" };
  await assert.rejects(store.get(item, { start: 0, end: 30 }), /upstream down/);
  // Asked again within a minute: the same failure, without asking the source.
  fail = false;
  await assert.rejects(store.get(item, { start: 0, end: 30 }), /upstream down/);
  assert.equal(calls.filter((call) => call[1] === "flaky").length, 1);
  now += 61_000;
  assert.deepEqual((await store.get(item, { start: 0, end: 30 })).comments.map((comment) => comment.text), ["at 3"]);
});

test("the least recently used items go when the count bound is reached", async () => {
  const { sources } = registry((source) => ({ comments: Array.from({ length: 10 }, (_, index) => at(index)), start: 0, end: null }));
  const store = createCommentStore({ sources, maxTotal: 25 });
  for (const id of ["a", "b", "c"]) await store.get({ plugin: "segmented", id }, { start: 0, end: 30 });
  assert.deepEqual(store.status(), { items: 2, comments: 20 });
});
