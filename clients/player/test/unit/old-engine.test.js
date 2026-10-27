import assert from "node:assert/strict";
import test from "node:test";
import { fillOldEngine } from "../../src/old-engine.js";

// What Chromium 85 lacks that the player uses (Agent Note
// 2026-10-26-tv-web-client), filled only where missing.

// An engine without the methods: bare stand-ins for its built-ins.
const bareRealm = () => ({
  Array: { prototype: {} },
  String: { prototype: {} },
  Object: {},
  AbortController,
  AbortSignal: function AbortSignal() {},
  DOMException,
});

test("the fills are set where missing and leave a newer engine's own alone", () => {
  const realm = bareRealm();
  fillOldEngine(realm);
  const list = [1, 2, 3];
  assert.equal(realm.Array.prototype.at.call(list, -1), 3);
  assert.equal(realm.Array.prototype.findLast.call(list, (n) => n < 3), 2);
  assert.equal(realm.Array.prototype.findLastIndex.call(list, (n) => n > 5), -1);
  assert.equal(realm.String.prototype.at.call("abc", 0), "a");
  assert.equal(realm.Object.hasOwn({ a: 1 }, "a"), true);
  assert.deepEqual(realm.structuredClone({ a: [1, { b: 2 }] }), { a: [1, { b: 2 }] });

  const own = Array.prototype.at;
  fillOldEngine(globalThis);
  assert.equal(Array.prototype.at, own);
});

test("AbortSignal.timeout and any abort as the newer ones do", async () => {
  const realm = bareRealm();
  fillOldEngine(realm);
  const timed = realm.AbortSignal.timeout(5);
  await new Promise((resolve) => timed.addEventListener("abort", resolve));
  assert.equal(timed.reason.name, "TimeoutError");
  const first = new AbortController();
  const either = realm.AbortSignal.any([first.signal, new AbortController().signal]);
  first.abort("gone");
  assert.equal(either.reason, "gone");
});
