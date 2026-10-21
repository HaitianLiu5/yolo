import assert from "node:assert/strict";
import test from "node:test";
import { createMediaPaths, REPROBE_AFTER_FAILURE_MS } from "../../src/media-paths.js";

// A screen's media path (Agent Note 2026-10-13-media-off-the-worker): the
// first direct path that answers, in the order lan, wan; the relay only when
// no direct path works (`auto`) and never when the owner set it `off`.

const LAN = { path: "lan", origin: "https://yolo-lan-1.example.com:9443", notAfter: Date.now() + 60_000 };
const WAN = { path: "wan", origin: "https://yolo-wan-1.example.com:9444", notAfter: Date.now() + 60_000 };

function screen({ reachable = ["lan", "wan"], permission = "granted" } = {}) {
  const env = { reachable: new Set(reachable), items: new Map(), sent: [], timers: [], fetched: [] };
  env.paths = createMediaPaths({
    send: (message) => env.sent.push(message),
    win: { localStorage: { getItem: (key) => env.items.get(key) ?? null, setItem: (key, value) => env.items.set(key, value) } },
    fetchImpl: async (url) => {
      env.fetched.push(url);
      if (!env.reachable.has(url.includes("yolo-lan") ? "lan" : "wan")) throw Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
      return Response.json({ ok: true });
    },
    permission: async () => permission,
    setTimer: (fn, ms) => env.timers.push({ fn, ms }),
    clearTimer: () => {},
  });
  return env;
}

test("direct paths come first in the order lan, wan; the relay only when none answers", async () => {
  // The home network needs no switch, and a browser without Local Network
  // Access (Safari) probes it with no prompt.
  const home = screen({ permission: null });
  await home.paths.setPaths({ media: { paths: [LAN, WAN], relayMode: "auto" } });
  assert.equal(home.paths.network(), "lan");
  assert.deepEqual(home.sent.at(-1), { type: "network", path: "lan", reason: "probe", probes: { lan: "ok", wan: "ok" } });
  home.reachable.delete("lan");
  await home.paths.probe("online");
  assert.equal(home.paths.network(), "wan");
  home.reachable.clear();
  await home.paths.probe("online");
  assert.equal(home.paths.network(), "relay");
});

test("a failed direct stream falls back to the relay at once, and a probe later moves it back", async () => {
  const car = screen({ permission: "prompt" });
  await car.paths.setEnabled(false);
  await car.paths.setPaths({ media: { paths: [LAN, WAN], relayMode: "auto" } });
  assert.equal(car.paths.network(), "wan", "the owner turned the LAN switch off: no LAN probe");
  assert.equal(car.paths.failed(new Error("stalled"), { position: 42 }), "relay");
  assert.deepEqual(car.sent.at(-1), { type: "network", path: "relay", reason: "media_error", probes: { lan: "off", wan: "failed" } });
  assert.equal(car.paths.canFallBack("relay"), false);
  assert.equal(car.timers.at(-1).ms, REPROBE_AFTER_FAILURE_MS);
  car.timers.at(-1).fn();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(car.paths.network(), "wan");
});

test("the home network is on until the owner turns it off: a permission still to be asked is asked, a denied one never fetches", async () => {
  const asked = screen({ permission: "prompt" });
  await asked.paths.setPaths({ media: { paths: [LAN], relayMode: "auto" } });
  assert.equal(asked.paths.network(), "lan");
  assert.equal(asked.paths.status().enabled, true);
  const denied = screen({ permission: "denied" });
  await denied.paths.setPaths({ media: { paths: [LAN], relayMode: "auto" } });
  assert.deepEqual([denied.paths.network(), denied.paths.status().last.outcome, denied.fetched], ["relay", "permission_denied", []]);
  await asked.paths.setEnabled(false);
  assert.deepEqual([asked.paths.network(), asked.paths.status().last.outcome, asked.paths.status().enabled], ["relay", "off", false]);
});

test("with the relay off the screen never takes it, also when nothing answers or a stream fails", async () => {
  const away = screen({ reachable: [] });
  await away.paths.setPaths({ media: { paths: [WAN], relayMode: "off" } });
  assert.equal(away.paths.network(), null);
  assert.deepEqual(away.sent.at(-1), { type: "network", path: null, reason: "probe", probes: { wan: "timeout" } });
  away.reachable.add("wan");
  await away.paths.probe("online");
  assert.equal(away.paths.network(), "wan");
  assert.equal(away.paths.failed(new Error("stalled")), null);
  assert.equal(away.paths.canFallBack("wan"), false);
});
