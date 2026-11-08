import assert from "node:assert/strict";
import test from "node:test";
import { createOnItsWay } from "../../src/on-its-way.js";

const A = { plugin: "ytdlp", id: "https://example.com/a" };
const B = { plugin: "plex", id: "9896" };

// The loading screen of a stream on its way here, left with Back: its
// request's `load` is left, not played, however long the request takes,
// each left request stays left, and a `load` of something else plays
// (Agent Note 2026-10-11-yolo-web-client).

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setUp() {
  let route = "browse";
  const timers = [];
  const onItsWay = createOnItsWay({
    navigate: (path) => {
      route = path === "/play" ? "player" : "browse";
      return true;
    },
    parseRoute: () => ({ view: route }),
    back: () => {
      route = "browse";
    },
    setTimer: (task) => timers.push(task),
  });
  return { onItsWay, timers, leave: () => {
    route = "browse";
    return onItsWay.leave();
  } };
}

test("a left request's load is left however long the request waits, and only until a moment after it settles", async () => {
  const { onItsWay, timers, leave } = setUp();
  const request = deferred();
  onItsWay.start({ wants: { source: A } });
  onItsWay.sent(request.promise);
  leave();
  // Minutes may pass while it waits for a welcome and the node prepares:
  // nothing expires it before it settles.
  await new Promise((done) => setImmediate(done));
  assert.equal(timers.length, 0);
  request.resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(onItsWay.takeLeft({ source: A }), true, "its load, just after the answer");
  assert.equal(onItsWay.takeLeft({ source: A }), false, "once");

  const late = deferred();
  onItsWay.start({ wants: { source: A } });
  onItsWay.sent(late.promise);
  leave();
  late.resolve();
  await new Promise((done) => setImmediate(done));
  for (const timer of timers.splice(0)) timer();
  assert.equal(onItsWay.takeLeft({ source: A }), false, "a load long after the answer is someone else's");
});

test("while a left request waits, a load of another item (an agent's, another press's) plays; a link's, whose item is not known before Yolo answers, is left", () => {
  const { onItsWay, leave } = setUp();
  onItsWay.start({ wants: { itemId: "ytdlp:https://example.com/a" } });
  onItsWay.sent(deferred().promise);
  leave();
  assert.equal(onItsWay.takeLeft({ source: B }), false, "another item");
  assert.equal(onItsWay.takeLeft({ source: A }), true, "the item asked for by its id");
  onItsWay.start();
  onItsWay.sent(deferred().promise);
  leave();
  assert.equal(onItsWay.takeLeft({ source: B }), true, "a link's, whatever it plays");
  onItsWay.start({ wants: { source: { url: "https://example.com/queued" } } });
  onItsWay.sent(deferred().promise);
  leave();
  assert.equal(onItsWay.takeLeft({ source: B }), true, "a queued link no source plugin claimed yet, whatever it plays");
});

test("each left request stays left, so none of their failures shows over home", () => {
  const { onItsWay, leave } = setUp();
  const first = deferred();
  const second = deferred();
  for (const request of [first, second]) {
    request.promise.catch(() => {});
    onItsWay.start();
    onItsWay.sent(request.promise);
    leave();
  }
  assert.deepEqual([onItsWay.leftFrom(first.promise), onItsWay.leftFrom(second.promise)], [true, true]);
  const kept = deferred();
  onItsWay.start();
  onItsWay.sent(kept.promise);
  assert.equal(onItsWay.leftFrom(kept.promise), false);
});
