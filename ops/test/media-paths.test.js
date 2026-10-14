import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaStep, relayCheck } from "../lib/media-paths.js";

// doctor and the deploy's last step on the media paths
// (Agent Note 2026-10-13-media-off-the-worker): the relay is information
// while it is automatic or on, and only off with no direct path fails.

const unreachable = { status: "unreachable", origin: null, forward: { port: 9444, internalPort: 9444, address: "10.0.0.12", gateway: "10.0.0.1" } };

test("doctor reports the relay as information unless it is off with no direct path", () => {
  const auto = relayCheck({ relayMode: "auto", streams: { days: 7, relay: 3 }, lan: { status: "off" }, remote: unreachable });
  assert.equal(auto.status, "info");
  assert.match(auto.message, /only when no direct path works.*3 relay streams in the last 7 days/);
  assert.equal(relayCheck({ relayMode: "on", lan: { status: "off" }, remote: unreachable }).status, "info");

  const dead = relayCheck({ relayMode: "off", lan: { status: "off" }, remote: unreachable });
  assert.equal(dead.status, "fail");
  assert.match(dead.fix, /Relay to Automatic/);
  assert.match(dead.fix, /forward TCP port 9444 to 10\.0\.0\.12/);
  assert.match(dead.fix, /router \(10\.0\.0\.1\)/);
  assert.equal(relayCheck({ relayMode: "off", lan: { status: "off" }, remote: { status: "ok" } }).status, "info");
});

test("the deploy reports the path that works and the router step, without failing", () => {
  const relayOnly = mediaStep({ node: { reachable: true }, media: { relayMode: "auto", lan: { status: "off" }, remote: unreachable } });
  assert.equal(relayOnly.status, "info");
  assert.match(relayOnly.message, /the relay \(auto, through the tunnel\)/);
  assert.match(relayOnly.fix, /turn on UPnP, or forward TCP port 9444/);
  const direct = mediaStep({ node: { reachable: true }, media: { relayMode: "auto", lan: { status: "ready" }, remote: { status: "ok", origin: "https://yolo-wan-1.example.com:9444" } } });
  assert.deepEqual([direct.status, direct.message], ["ok", "Media paths that work: the home network, remote direct play (reachable from outside at https://yolo-wan-1.example.com:9444), the relay (auto, through the tunnel)"]);
  assert.equal(mediaStep({ node: { reachable: true }, media: { relayMode: "off", lan: { status: "off" }, remote: { status: "off" } } }).status, "warn");
});
