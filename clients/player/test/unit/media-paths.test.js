import assert from "node:assert/strict";
import test from "node:test";
import { createMediaPaths, LAN_CHOICE_KEY, PLAY_PROBE_WAIT_MS, REPROBE_AFTER_FAILURE_MS } from "../../src/media-paths.js";

// A screen's media path (Agent Note 2026-10-13-media-off-the-worker): it
// probes every path the welcome lists at once and takes the first that
// answers in the order lan, wan, relay; a stream that fails moves the
// screen down that order at once (the recovery's request then asks for
// it); every probe says why it failed.

const LAN = { path: "lan", origin: "https://yolo-lan-1.example.com:9443", notAfter: Date.now() + 60_000 };
const WAN = { path: "wan", origin: "https://yolo-wan-1.example.com:9444", notAfter: Date.now() + 60_000 };
const timeout = () => Object.assign(new Error("signal timed out"), { name: "TimeoutError" });

function screen({ reachable = ["lan", "wan"], permission = "granted" } = {}) {
  const env = { permission, reachable: new Set(reachable), items: new Map(), sent: [], events: [], timers: [], fetched: [] };
  env.paths = createMediaPaths({
    send: (message) => env.sent.push(message),
    record: (type, fields) => env.events.push({ type, ...fields }),
    win: { localStorage: { getItem: (key) => env.items.get(key) ?? null, setItem: (key, value) => env.items.set(key, value) } },
    fetchImpl: async (url) => {
      env.fetched.push(url);
      const path = url.includes("yolo-lan") ? "lan" : "wan";
      if (!env.reachable.has(path)) throw timeout();
      return Response.json({ ok: true, path });
    },
    permission: async () => env.permission,
    setTimer: (fn, ms) => env.timers.push({ fn, ms }),
    clearTimer: () => {},
  });
  return env;
}

const events = (env, type) => env.events.filter((event) => event.type === type);

test("a screen takes the first path that answers, in the order lan, wan, relay", async () => {
  // This screen has "Play over the home network" on.
  const at = screen();
  await at.paths.setEnabled(true);
  assert.equal(at.items.get(LAN_CHOICE_KEY), "on");
  await at.paths.setPaths({ media: { paths: [LAN, WAN], relay: true } });
  assert.equal(at.paths.network(), "lan");
  assert.deepEqual(at.fetched.sort(), [`${LAN.origin}/edge/probe`, `${WAN.origin}/edge/probe`], "both probed at once");
  assert.deepEqual(at.sent.at(-1), { type: "network", path: "lan", reason: "probe", probes: { lan: "ok", wan: "ok" } });
  assert.deepEqual(events(at, "media_probe").map(({ path, outcome }) => [path, outcome]).sort(), [["lan", "ok"], ["wan", "ok"]]);

  // Away from home the LAN does not answer: the remote path, with the reason.
  at.reachable.delete("lan");
  await at.paths.probe("online");
  assert.equal(at.paths.network(), "wan");
  assert.deepEqual(at.sent.at(-1), { type: "network", path: "wan", reason: "probe", probes: { lan: "timeout", wan: "ok" } });
  assert.deepEqual(events(at, "media_path").at(-1), { type: "media_path", path: "wan", from: "lan", reason: "probe", probes: { lan: "timeout", wan: "ok" } });

  // The car, whose switch is off, never probes the LAN and asks for no permission.
  const car = screen({ permission: "prompt" });
  await car.paths.setPaths({ media: { paths: [LAN, WAN], relay: false } });
  assert.deepEqual([car.paths.network(), car.fetched], ["wan", [`${WAN.origin}/edge/probe`]]);
});

test("a failed stream moves the screen down the order at once, and a probe thirty seconds later moves it back", async () => {
  const car = screen({ permission: "prompt" });
  await car.paths.setPaths({ media: { paths: [LAN, WAN], relay: true } });
  assert.equal(car.paths.network(), "wan");
  assert.equal(car.paths.canFallBack("wan"), true);
  const next = car.paths.failed(Object.assign(new Error("Failed to fetch"), { code: "HLS_SEGMENT_FETCH_FAILED" }), { position: 42 });
  assert.equal(next, "relay");
  assert.equal(car.paths.network(), "relay", "the recovery that follows asks for the relay");
  assert.deepEqual(car.sent.at(-1), { type: "network", path: "relay", reason: "media_error", probes: { lan: "off", wan: "failed" } });
  assert.deepEqual(events(car, "media_path_fallback").at(-1), { type: "media_path_fallback", from: "wan", to: "relay", code: "HLS_SEGMENT_FETCH_FAILED", message: "Failed to fetch", position: 42 });
  assert.equal(car.paths.canFallBack("relay"), false);
  assert.equal(car.timers.at(-1).ms, REPROBE_AFTER_FAILURE_MS);
  car.timers.at(-1).fn();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(car.paths.network(), "wan");
});

test("with the relay off and nothing reachable the screen has no path, and says why", async () => {
  const away = screen({ reachable: [] });
  await away.paths.setPaths({ media: { paths: [WAN], relay: false } });
  assert.equal(away.paths.network(), null);
  assert.deepEqual(away.sent.at(-1), { type: "network", path: null, reason: "probe", probes: { wan: "timeout" } });
  away.reachable.add("wan");
  await away.paths.probe("online");
  assert.equal(away.paths.network(), "wan");
  assert.equal(away.paths.failed(new Error("stalled")), null, "nothing below the remote path while the relay is off");
  assert.equal(away.paths.canFallBack("wan"), false);
});

// The relay's modes (Agent Note 2026-10-13-media-off-the-worker): in
// automatic, the default, the relay is the path only when no direct path
// answers, and the one a failing direct stream falls back to.
test("automatic takes the relay only when no direct path answers, and when a direct stream fails in the middle", async () => {
  const away = screen({ reachable: [], permission: "prompt" });
  await away.paths.setPaths({ media: { paths: [WAN], relay: true, relayMode: "auto" } });
  assert.equal(away.paths.network(), "relay", "no direct path answers");
  assert.equal(away.paths.status().relayMode, "auto");

  const car = screen({ permission: "prompt" });
  await car.paths.setPaths({ media: { paths: [WAN], relay: true, relayMode: "auto" } });
  assert.equal(car.paths.network(), "wan", "a direct path that answers comes first");
  assert.equal(car.paths.failed(new Error("stalled"), { position: 42 }), "relay", "the recovery at 42 s comes by the relay");
  assert.deepEqual(car.sent.at(-1), { type: "network", path: "relay", reason: "media_error", probes: { wan: "failed" } });
  assert.deepEqual(events(car, "media_path_fallback").at(-1), { type: "media_path_fallback", from: "wan", to: "relay", code: null, message: "stalled", position: 42 });
  // Once the direct path answers again, the next stream takes it.
  car.timers.at(-1).fn();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(car.paths.network(), "wan");

  // A welcome that names only the mode: off is no relay at all.
  const off = screen({ reachable: [] });
  await off.paths.setPaths({ media: { paths: [WAN], relayMode: "off" } });
  assert.deepEqual([off.paths.network(), off.paths.status().relayMode], [null, "off"]);
  // The owner turns the relay on from this screen: it takes the relay at once.
  await off.paths.setPaths({ media: { paths: [WAN], relay: true, relayMode: "auto" } }, "paths");
  assert.equal(off.paths.network(), "relay");
});

test("the LAN probe says why it failed, never prompts by itself, and a welcome's old `lan` names no path", async () => {
  // A quick failure with the permission granted: the router hid the name.
  const blocked = screen();
  await blocked.paths.setEnabled(true);
  const original = blocked.reachable;
  blocked.reachable = { has: () => { throw new TypeError("Failed to fetch"); } };
  await blocked.paths.setPaths({ media: { paths: [LAN], relay: true } });
  assert.deepEqual([events(blocked, "media_probe").at(-1).outcome, blocked.paths.network()], ["dns_rebinding", "relay"]);
  blocked.reachable = original;
  // A denied permission is reported without asking again.
  blocked.permission = "denied";
  const fetched = blocked.fetched.length;
  await blocked.paths.probe("online");
  assert.deepEqual([events(blocked, "media_probe").at(-1).outcome, blocked.fetched.length], ["permission_denied", fetched]);

  // `lan`, the LAN origin alone that welcomes carried before 0.5, is not read:
  // the screen probes nothing and takes the relay, as with no `media` at all.
  const old = screen();
  await old.paths.setEnabled(true);
  await old.paths.setPaths({ lan: { origin: LAN.origin, notAfter: LAN.notAfter } });
  assert.deepEqual([old.fetched, old.paths.status().origin, old.paths.network()], [[], null, "relay"]);
});

test("at the home's own address the remote probe tests the router's loopback, and a new list of paths is probed at once", async () => {
  // No domain: the remote origin is the home's address, and the Hub says this screen connects from it.
  const HOME = { path: "wan", origin: "https://73.63.154.63:9444", notAfter: Date.now() + 60_000, home: true };
  const noLoopback = screen({ reachable: [] });
  await noLoopback.paths.setPaths({ media: { paths: [HOME], relay: true } });
  assert.equal(noLoopback.paths.network(), "relay");
  assert.deepEqual(noLoopback.sent.at(-1), { type: "network", path: "relay", reason: "probe", probes: { wan: "timeout" }, hairpin: "failed" });
  const { path, outcome, host, home, hairpin } = events(noLoopback, "media_probe").at(-1);
  assert.deepEqual({ path, outcome, host, home, hairpin }, { path: "wan", outcome: "timeout", host: "73.63.154.63:9444", home: true, hairpin: "failed" });
  assert.equal(noLoopback.paths.status().hairpin, "failed");

  const loopback = screen({ reachable: ["wan"] });
  await loopback.paths.setPaths({ media: { paths: [HOME], relay: true } });
  assert.deepEqual([loopback.paths.network(), loopback.sent.at(-1).hairpin, loopback.paths.status().hairpin], ["wan", "ok", "ok"]);

  // The Hub's `media` push after the home's address changed: the new origin is probed.
  const moved = { ...HOME, origin: "https://73.63.154.99:9444" };
  await loopback.paths.setPaths({ media: { paths: [moved], relay: true } }, "paths");
  assert.equal(loopback.fetched.at(-1), `${moved.origin}/edge/probe`);
  assert.equal(events(loopback, "media_probe").at(-1).trigger, "paths");
});

// A screen whose probes answer when the test says so.
function waitingScreen() {
  const env = { items: new Map(), sent: [], timers: [], answers: new Map() };
  env.answer = (path, ok) => env.answers.get(path)?.(ok);
  env.paths = createMediaPaths({
    send: (message) => env.sent.push(message),
    win: { localStorage: { getItem: (key) => env.items.get(key) ?? null, setItem: (key, value) => env.items.set(key, value) } },
    fetchImpl: (url) => new Promise((resolve, reject) => {
      env.answers.set(url.includes("yolo-lan") ? "lan" : "wan", (ok) => (ok ? resolve(Response.json({ ok: true })) : reject(timeout())));
    }),
    permission: async () => "granted",
    setTimer: (fn, ms) => env.timers.push({ fn, ms }),
    clearTimer: () => {},
  });
  env.bound = () => env.timers.filter((timer) => timer.ms === PLAY_PROBE_WAIT_MS);
  return env;
}

const settledNow = async (promise) => {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
};

test("a play waits for a path that worked here before; otherwise at most a second, then the relay, and the next stream takes what the probes find", async () => {
  const at = waitingScreen();
  const welcome = { media: { paths: [WAN], relay: true } };

  // Nothing known on this network yet: a second at most.
  const round = at.paths.setPaths(welcome);
  const play = at.paths.settled();
  assert.equal(await settledNow(play), false);
  assert.equal(at.bound().length, 1);
  at.bound()[0].fn();
  assert.equal(await settledNow(play), true);
  assert.equal(at.paths.network(), "relay");
  // The probe answers later: the screen moves up for the next stream.
  at.answer("wan", true);
  await round;
  assert.equal(at.paths.network(), "wan");
  assert.equal(at.sent.at(-1).path, "wan");

  // The remote path worked here: the next welcome's play waits for its probe.
  const again = at.paths.setPaths(welcome);
  const next = at.paths.settled();
  assert.equal(await settledNow(next), false);
  assert.equal(at.bound().length, 1, "no bound for a path known to work here");
  at.answer("wan", false);
  await again;
  assert.equal(at.paths.network(), "relay");

  // It failed here last time: the relay at once, while the probe runs on.
  const third = at.paths.setPaths(welcome);
  assert.equal(await settledNow(at.paths.settled()), true);
  assert.equal(at.paths.network(), "relay");
  at.answer("wan", true);
  await third;
  assert.equal(at.paths.network(), "wan");

  // With the relay off there is nothing to fall back on: plays wait for the round.
  const off = waitingScreen();
  void off.paths.setPaths({ media: { paths: [WAN], relay: false } });
  assert.equal(await settledNow(off.paths.settled()), false);
  assert.equal(off.bound().length, 0);
});
