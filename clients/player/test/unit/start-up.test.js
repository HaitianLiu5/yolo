import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";

// A paired screen's start (Agent Note 2026-10-11-yolo-web-client): it shows
// what it kept from last time, per device, which index.html's first script
// finds before the first paint, and which unpairing deletes for good; a
// press before the welcome waits for it, the latest one once; and a
// realtime channel that is down says so only after a few seconds.

class MemoryStorage {
  #items = new Map();
  get length() { return this.#items.size; }
  key(index) { return [...this.#items.keys()][index] ?? null; }
  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
}

globalThis.localStorage = new MemoryStorage();
const { createHomeCache, forgetHomeCaches } = await import("../../src/home-cache.js");
const { createConnectionIndicator, QUIET_AFTER_MS } = await import("../../src/connection-indicator.js");
const { createWelcomeWait, waitTimedOut } = await import("../../src/welcome-wait.js");

// index.html's first script, run as the page runs it: which start the page paints.
const bootScript = /<script>\s*([\s\S]*?)<\/script>/.exec(readFileSync(new URL("../../index.html", import.meta.url), "utf8"))[1];
function boot() {
  const root = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  new Function("document", "localStorage", bootScript)({ documentElement: root }, globalThis.localStorage);
  return root.attributes["data-boot"];
}

test("a screen's next start shows what it kept, its own record only, and a new pairing forgets it", () => {
  localStorage.setItem("yolo.device", JSON.stringify({ token: "ydt_car", deviceId: "dev_car" }));
  assert.equal(boot(), "cold", "nothing kept: the launch mark");
  assert.equal(createHomeCache("dev_car").read(), null);

  const page = createHomeCache("dev_car");
  const history = [{ sourceKey: "plex:7", title: "Fixture Movie", position: 40, duration: 120 }];
  const hub = { deviceId: "dev_car", status: "playing", sessionId: "ses_1", item: { title: "Fixture Movie" } };
  page.remember({ rows: { history, queue: [] }, hub });
  page.remember({ rows: { movies: Array.from({ length: 250 }, (_, index) => ({ id: `m${index}` })) } });
  page.flush();
  assert.equal(boot(), "warm", "the next start paints without the launch mark");

  const next = createHomeCache("dev_car").read();
  assert.deepEqual([next.rows.history, next.rows.queue, next.hub], [history, [], hub]);
  assert.equal(next.rows.movies.length, 200, "a row as long as the home screen asks Yolo for");
  // Yolo's answers replace a part in place; the rest stays.
  const replaced = createHomeCache("dev_car");
  replaced.remember({ rows: { history: [] } });
  replaced.flush();
  assert.deepEqual([createHomeCache("dev_car").read().rows.history, createHomeCache("dev_car").read().hub], [[], hub]);

  // Another device's record is not this one's, and goes when this one writes.
  assert.equal(createHomeCache("dev_phone").read(), null);
  const phone = createHomeCache("dev_phone");
  phone.remember({ rows: { history } });
  phone.flush();
  assert.equal(createHomeCache("dev_car").read(), null);

  // A record past its size keeps the Hub's state and history, without the libraries.
  const big = createHomeCache("dev_car");
  big.remember({ hub, rows: { history, movies: Array.from({ length: 200 }, () => ({ title: "x".repeat(8_000) })) } });
  big.flush();
  const trimmed = createHomeCache("dev_car").read();
  assert.deepEqual([trimmed.hub, trimmed.rows.history, trimmed.rows.movies], [hub, history, null]);

  forgetHomeCaches();
  assert.equal(boot(), "cold");
  assert.equal(createHomeCache("dev_car").read(), null);
});

test("an unpaired screen's record stays deleted: a write it had pending, or a flush as the page hides, writes nothing", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  localStorage.setItem("yolo.device", JSON.stringify({ token: "ydt_car", deviceId: "dev_car" }));
  const page = createHomeCache("dev_car");
  page.remember({ rows: { history: [{ title: "Watched" }] } });
  page.discard();
  forgetHomeCaches();
  mock.timers.tick(5_000);
  page.remember({ rows: { queue: [] } });
  page.flush();
  assert.equal(localStorage.getItem("yolo.home.dev_car"), null);
  assert.equal(boot(), "cold");
});

test("a press before the welcome: the latest one runs once when it comes; one replaced, or whose wait fails, never runs, and only a wait that ran out says so", async () => {
  let welcome;
  let refuse;
  const gate = () => new Promise((resolve, reject) => {
    welcome = resolve;
    refuse = reject;
  });
  let waitFor = gate();
  const wait = createWelcomeWait(() => waitFor);
  const ran = [];
  const ended = [];
  const notices = [];
  const press = (name) => wait.later(() => ran.push(name), {
    onEnd: () => ended.push(name),
    onFail: (error) => { if (waitTimedOut(error)) notices.push(name); },
  });

  // Tapped three times while the page connects: only the last plays, once.
  const presses = [press("first"), press("second"), press("third")];
  assert.equal(wait.waiting, true);
  assert.deepEqual(ended, ["first", "second"], "a replaced press stops looking pressed");
  welcome();
  await Promise.all(presses);
  assert.deepEqual([ran, ended, wait.waiting], [["third"], ["first", "second", "third"], false]);

  // The channel stopped (the screen pairs again): the press goes quietly,
  // and nothing runs it or tries again. No welcome in time: it goes, and
  // says so.
  waitFor = gate();
  const failed = press("while unpaired");
  refuse(Object.assign(new Error("This screen is not connected to Yolo"), { code: "realtime_stopped" }));
  assert.equal(await failed, undefined);
  waitFor = gate();
  const late = press("too late");
  refuse(Object.assign(new Error("Yolo's realtime connection did not come back within 20 s"), { code: "realtime_unavailable" }));
  await late;
  assert.deepEqual([ran, notices, wait.waiting], [["third"], ["too late"], false]);

  // Dropped on purpose: it never runs, even when the welcome comes.
  waitFor = gate();
  const dropped = press("dropped");
  wait.drop();
  welcome();
  await dropped;
  assert.deepEqual([ran, ended.at(-1), wait.waiting], [["third"], "dropped", false]);
});

test("the connection mark shows only after the channel has been down a few seconds, and goes when it is back", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const shown = [];
  const mark = createConnectionIndicator({ show: () => shown.push("show"), hide: () => shown.push("hide") });

  // A start, or a drop that comes back within the delay: nothing at all.
  mark.status("connecting");
  mock.timers.tick(QUIET_AFTER_MS - 1);
  mark.status("offline");
  mark.status("online");
  mock.timers.tick(QUIET_AFTER_MS);
  assert.deepEqual(shown, []);

  // Down longer: the mark, once, until the welcome.
  mark.status("offline");
  mark.status("connecting");
  mock.timers.tick(QUIET_AFTER_MS);
  mark.status("offline");
  mock.timers.tick(QUIET_AFTER_MS);
  assert.deepEqual(shown, ["show"]);
  mark.status("online");
  assert.deepEqual(shown, ["show", "hide"]);

  // Stopped on purpose (pairing again): it goes, and nothing waits to show it.
  mark.status("offline");
  mark.reset();
  mock.timers.tick(QUIET_AFTER_MS);
  assert.deepEqual(shown, ["show", "hide"]);
});
