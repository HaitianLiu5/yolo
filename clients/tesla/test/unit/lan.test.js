import assert from "node:assert/strict";
import test from "node:test";
import { createLan, LAN_CHOICE_KEY, REPROBE_AFTER_FAILURE_MS } from "../../src/lan.js";

// LAN direct play on a screen (Agent Note 2026-10-12-lan-direct-play): the
// switch gates the first probe, a LAN stream's failure moves the screen to
// the tunnel at once (the recovery's request then asks for it), and every
// probe says why it failed.

const LAN = { origin: "https://yolo-lan-1.example.com:9443", notAfter: Date.now() + 60_000 };

function screen({ answer = () => new Response("{}") } = {}) {
  const env = { permission: "prompt", items: new Map(), sent: [], events: [], timers: [], fetched: [] };
  env.lan = createLan({
    send: (message) => env.sent.push(message),
    record: (type, fields) => env.events.push({ type, ...fields }),
    win: { localStorage: { getItem: (key) => env.items.get(key) ?? null, setItem: (key, value) => env.items.set(key, value) } },
    fetchImpl: async (url) => {
      env.fetched.push(url);
      return answer(url);
    },
    permission: async () => env.permission,
    setTimer: (fn, ms) => env.timers.push({ fn, ms }),
    clearTimer: () => {},
  });
  return env;
}

test("a LAN stream's failure moves the screen to the tunnel at once, and probes say why they fail", async () => {
  const home = screen();
  await home.lan.setOrigin(LAN);
  assert.deepEqual([home.lan.network(), home.fetched.length], ["tunnel", 0], "no probe, so no prompt, until the owner turns it on");
  home.permission = "granted";
  await home.lan.setEnabled(true);
  assert.equal(home.items.get(LAN_CHOICE_KEY), "on");
  assert.deepEqual([home.lan.network(), home.fetched], ["lan", [`${LAN.origin}/lan/probe`]]);
  assert.deepEqual(home.sent.at(-1), { type: "network", lan: true, reason: "ok" });

  home.lan.failed(Object.assign(new Error("Failed to fetch"), { code: "MEDIA_NETWORK_ERROR" }), { position: 42 });
  assert.equal(home.lan.network(), "tunnel", "the recovery that follows asks for the tunnel");
  assert.deepEqual(home.sent.at(-1), { type: "network", lan: false, reason: "media_error" });
  assert.deepEqual(home.events.at(-1), { type: "lan_fallback", code: "MEDIA_NETWORK_ERROR", message: "Failed to fetch", position: 42 });
  // Thirty seconds later a probe brings the LAN path back.
  assert.equal(home.timers.at(-1).ms, REPROBE_AFTER_FAILURE_MS);
  home.timers.at(-1).fn();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(home.lan.network(), "lan");

  // A quick failure with the permission granted: the router hid the name.
  const blocked = screen({ answer: () => { throw new TypeError("Failed to fetch"); } });
  blocked.permission = "granted";
  await blocked.lan.setEnabled(true);
  await blocked.lan.setOrigin(LAN);
  assert.deepEqual([blocked.events.at(-1).type, blocked.events.at(-1).outcome, blocked.lan.network()], ["lan_probe", "dns_rebinding", "tunnel"]);
  // A denied permission is reported without asking again.
  blocked.permission = "denied";
  await blocked.lan.probe("online");
  assert.deepEqual([blocked.events.at(-1).outcome, blocked.fetched.length], ["permission_denied", 1]);
});
