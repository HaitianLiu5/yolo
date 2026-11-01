import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { CLIENT_PROTOCOLS } from "@useyolo/core";

import { DEVICE_ID, LAUNCH, makeClips, startKit } from "./kit.js";

// A client speaks one of the protocols the Hub serves: protocol 1 until the
// Apple clients move to 2 (Agent Note 2026-10-31-screen-sessions).
const NEWEST = Math.max(...CLIENT_PROTOCOLS);
const OLDEST = Math.min(...CLIENT_PROTOCOLS);

// The client protocol's required part (Agent Note 2026-10-19-client-protocol),
// one scenario per message or rule, against a real client: each starts the
// client afresh against a new kit. Without YOLO_CONFORMANCE_LAUNCH there is
// no client to run, and the scenarios are skipped.

const skip = LAUNCH ? false : "set YOLO_CONFORMANCE_LAUNCH to the command that starts a client with {url}";
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

let clips;
before(async () => {
  if (!skip) clips = await makeClips();
});

/** A scenario with its own kit, stopped afterwards. */
function scenario(name, run, { timeout = 120_000 } = {}) {
  test(name, { skip, timeout }, async (t) => {
    const kit = await startKit({ clips });
    t.after(() => kit.stop());
    try {
      await run(kit);
    } catch (error) {
      // What the client did, to tell a client that never came from one that
      // broke a rule.
      const seen = kit.events.map((e) => `${e.at - kit.events[0]?.at}ms ${e.kind} ${e.path ?? e.event ?? e.message?.type ?? (e.exact === false ? e.text : "")}`);
      error.message += `\nClient events:\n  ${seen.slice(-25).join("\n  ") || "(none)"}`;
      throw error;
    }
  });
}

/** The client plays the kit's long clip until it reports playing. */
async function playing(kit, options = {}) {
  const since = Date.now();
  kit.play(options);
  const sessionId = kit.state.sessionId;
  await kit.message("report", { since, timeout: 30_000, where: (m) => m.sessionId === sessionId && m.status === "playing" });
  return sessionId;
}

describe("discovery and pairing", () => {
  scenario("checks /.well-known/yolo, then pairs as a tv by the device grant at the server's interval", async (kit) => {
    kit.pairing = "pending";
    await kit.launch();
    const authorize = await kit.waitFor((e) => e.kind === "http" && e.path === "/oauth/device_authorization", { timeout: 60_000, label: "device_authorization" });
    const check = kit.events.find((e) => e.kind === "http" && e.path === "/.well-known/yolo");
    assert.ok(check && check.at <= authorize.at, "the address is checked before pairing");
    assert.equal(authorize.body.device_kind, "tv");
    assert.ok(authorize.body.client_id, "a client_id");
    assert.equal((await kit.debug()).screen, "pairing");
    const first = await kit.waitFor((e) => e.kind === "http" && e.path === "/oauth/token", { since: authorize.at, label: "the first poll" });
    const second = await kit.waitFor((e) => e.kind === "http" && e.path === "/oauth/token" && e.at > first.at, { since: first.at + 1, label: "the second poll" });
    assert.ok(second.at - first.at >= 4_500, `polls ${second.at - first.at} ms apart, under the 5 s interval`);
    kit.pairing = "approve";
    const hello = await kit.message("hello", { timeout: 30_000 });
    assert.equal(hello.v, 1);
    await kit.until((state) => state.screen === "ready", { label: "ready after pairing" });
  });

  scenario("a server that serves only newer protocols asks to update the client, before pairing", async (kit) => {
    kit.clientProtocols = [NEWEST + 1];
    await kit.launch();
    await kit.until((state) => state.screen === "update-client", { label: "update-client" });
    assert.ok(!kit.events.some((e) => e.kind === "http" && e.path === "/oauth/device_authorization"), "no pairing with a server it cannot speak to");
  });

  scenario("a server that serves only older protocols asks to upgrade the server", async (kit) => {
    kit.clientProtocols = [OLDEST - 1];
    await kit.launch();
    await kit.until((state) => state.screen === "update-server", { label: "update-server" });
  });
});

describe("the realtime channel", () => {
  scenario("hello comes first, with the protocol, the device's kind, and its capabilities", async (kit) => {
    await kit.ready();
    const [first] = kit.messages();
    assert.equal(first.type, "hello");
    assert.ok(CLIENT_PROTOCOLS.includes(first.protocol), `protocol ${first.protocol} is one the Hub serves`);
    assert.equal(typeof first.name, "string");
    assert.ok(first.kind);
    for (const field of ["renderer", "delivery", "containers", "video", "audio", "maxHeight", "subtitles"]) assert.ok(field in first.capabilities, field);
  });

  scenario("the heartbeat is exactly HEARTBEAT_PING, at least every 30 seconds", async (kit) => {
    await kit.ready();
    const since = Date.now();
    await kit.waitFor((e) => e.kind === "ping", { since, timeout: 35_000, label: "a heartbeat" });
    assert.deepEqual(kit.events.filter((e) => e.kind === "ping" && !e.exact), [], "every ping is the exact string");
  });

  scenario("broadcasts are never answered, and commands with an id are acknowledged", async (kit) => {
    await kit.ready();
    // The screen reports its media path once after the welcome, by itself.
    const reported = await kit.waitFor((e) => e.kind === "message" && e.message.type === "network", { timeout: 15_000, label: "the network report" });
    let since = reported.at + 1;
    kit.send({ type: "state", state: kit.state });
    kit.send({ type: "queue", queue: [] });
    kit.send({ type: "playlists", playlists: [] });
    kit.send({ type: "devices", devices: [{ id: DEVICE_ID, name: "TV", online: true, active: false }] });
    await wait(3_000);
    assert.deepEqual(kit.messages(since), [], "nothing answers a broadcast");
    await playing(kit);
    since = Date.now();
    kit.send({ type: "pause", id: "cmd_ack", sessionId: kit.state.sessionId });
    await kit.message("ack", { since, where: (m) => m.id === "cmd_ack" });
  });

  scenario("a 1008 close waits at least 30 seconds before connecting again", async (kit) => {
    await kit.ready();
    const closed = Date.now();
    await kit.close(1008, "rate_limited");
    const again = await kit.waitFor((e) => e.kind === "http" && e.path === "/v1/realtime/ticket", { since: closed + 1, timeout: 60_000, label: "the next ticket" });
    assert.ok(again.at - closed >= 29_500, `connected again after ${again.at - closed} ms`);
  });

  scenario("a 429 on the ticket waits at least 30 seconds before asking again", async (kit) => {
    await kit.ready();
    kit.ticketStatus = 429;
    const killed = Date.now();
    kit.kill();
    const refused = await kit.waitFor((e) => e.kind === "http" && e.path === "/v1/realtime/ticket", { since: killed, label: "a ticket request" });
    kit.ticketStatus = 200;
    const again = await kit.waitFor((e) => e.kind === "http" && e.path === "/v1/realtime/ticket" && e.at > refused.at, { since: refused.at + 1, timeout: 60_000, label: "the next ticket" });
    assert.ok(again.at - refused.at >= 29_500, `asked again after ${again.at - refused.at} ms`);
  });

  scenario("a removed device returns to pairing", async (kit) => {
    await kit.ready();
    kit.ticketStatus = 401;
    await kit.close(4003, "revoked");
    await kit.until((state) => state.screen === "pairing", { label: "the pairing screen" });
  });

  scenario("a welcome with upgrade: true asks to update the client and does not reconnect at once", async (kit) => {
    kit.upgradeOnHello = true;
    await kit.launch();
    await kit.until((state) => state.screen === "update-client", { timeout: 60_000, label: "update-client" });
    const shown = Date.now();
    await wait(15_000);
    assert.ok(!kit.events.some((e) => e.kind === "http" && e.path === "/v1/realtime/ticket" && e.at > shown), "no new ticket within 15 s");
  });
});

describe("playback", () => {
  scenario("load plays the stream from its start and reports it", async (kit) => {
    await kit.ready();
    const since = Date.now();
    const sessionId = await playing(kit, { startTime: 5 });
    const shown = await kit.until((state) => state.sessionId === sessionId && !state.paused && state.position > 5, { label: "playing past 5 s" });
    assert.equal(shown.active, true);
    // Yolo saves what a report says: while it loads, the stream is where it
    // starts, not at 0, or a resume position is lost before it plays.
    const early = kit.messages(since).filter((m) => m.type === "report" && m.sessionId === sessionId && m.position < 4.5);
    assert.deepEqual(early.map((m) => [m.status, m.position]), []);
  });

  scenario("a load with autoplay false starts paused", async (kit) => {
    await kit.ready();
    const since = Date.now();
    kit.play({ autoplay: false, startTime: 3 });
    await kit.message("report", { since, where: (m) => m.sessionId === kit.state.sessionId && m.status === "paused" });
    const shown = await kit.until((state) => state.sessionId === kit.state.sessionId && state.paused, { label: "paused" });
    assert.ok(Math.abs(shown.position - 3) < 1.5, `at ${shown.position}`);
  });

  scenario("pause, resume, and seek apply to the stream and are reported", async (kit) => {
    await kit.ready();
    const sessionId = await playing(kit);
    let since = Date.now();
    kit.send({ type: "pause", id: "c1", sessionId });
    await kit.message("report", { since, where: (m) => m.status === "paused" });
    since = Date.now();
    kit.send({ type: "seek", id: "c2", sessionId, position: 20 });
    await kit.message("report", { since, where: (m) => Math.abs(m.position - 20) < 1 });
    await kit.until((state) => state.paused && Math.abs(state.position - 20) < 1, { label: "paused at 20 s" });
    since = Date.now();
    kit.send({ type: "resume", id: "c3", sessionId });
    await kit.message("report", { since, where: (m) => m.status === "playing" });
  });

  scenario("stop ends playback", async (kit) => {
    await kit.ready();
    await playing(kit);
    kit.send({ type: "stop" });
    await kit.until((state) => state.sessionId === null, { label: "no stream on screen" });
  });

  scenario("deactivate stops playback here without reporting it", async (kit) => {
    await kit.ready();
    const sessionId = await playing(kit);
    kit.send({ type: "deactivate" });
    await kit.until((state) => state.sessionId === null, { label: "no stream on screen" });
    const since = Date.now();
    await wait(6_000);
    assert.deepEqual(kit.messages(since).filter((m) => m.type === "report" && m.sessionId === sessionId), [], "no report for the stream that moved");
  });

  scenario("a stream played to its end says ended once", async (kit) => {
    await kit.ready();
    const since = Date.now();
    kit.play({ clip: "short" });
    const sessionId = kit.state.sessionId;
    await kit.message("ended", { since, timeout: 30_000, where: (m) => m.sessionId === sessionId });
    await wait(3_000);
    assert.equal(kit.messages(since).filter((m) => m.type === "ended").length, 1);
  });
});

describe("media paths", () => {
  scenario("probes the paths with the server's origin and reports the path once after the welcome", async (kit) => {
    await kit.ready();
    const network = await kit.message("network", { timeout: 15_000 });
    assert.equal(network.path, "lan");
    const probe = kit.events.find((e) => e.kind === "http" && e.origin === "lan" && e.path === "/edge/probe");
    assert.equal(probe?.headers.origin, kit.url, "the probe carries the server's origin");
  });

  scenario("a media message that takes the path in use away moves the screen to the next path", async (kit) => {
    await kit.ready();
    const reported = await kit.waitFor((e) => e.kind === "message" && e.message.type === "network", { timeout: 15_000, label: "the network report" });
    assert.equal(reported.message.path, "lan");
    kit.send({ type: "media", media: { paths: [], relayMode: "auto" } });
    // The answer can come within the same millisecond: it is the one on the relay.
    await kit.message("network", { since: reported.at, timeout: 15_000, where: (m) => m.path === "relay" });
  });

  scenario("a stream that fails on its path moves to the next path and rebuilds at the same position", async (kit) => {
    await kit.ready();
    const sessionId = await playing(kit, { startTime: 10 });
    await wait(2_000);
    const since = Date.now();
    kit.media = { paths: [], relayMode: "auto" };
    kit.killMedia(sessionId);
    const rebuild = await kit.waitFor((e) => e.kind === "http" && e.path === "/v1/playback/play", { since, timeout: 60_000, label: "a rebuild" });
    assert.equal(rebuild.body.reason, "recovery");
    assert.equal(rebuild.body.sessionId, sessionId);
    assert.ok(rebuild.body.startTime >= 10, `rebuilt at ${rebuild.body.startTime}`);
    assert.notEqual(rebuild.body.network, "lan");
  }, { timeout: 150_000 });
});

describe("what a dead connection takes", () => {
  scenario("a pause lost with the connection is made up after the welcome", async (kit) => {
    await kit.ready();
    const sessionId = await playing(kit);
    kit.lose({ type: "pause", id: "lost_pause", sessionId });
    kit.kill();
    await kit.until((state) => state.sessionId === sessionId && state.paused, { timeout: 30_000, label: "paused after the welcome" });
  });

  scenario("a seek lost with the connection is made up after the welcome", async (kit) => {
    await kit.ready();
    const sessionId = await playing(kit);
    kit.lose({ type: "seek", id: "lost_seek", sessionId, position: 22 });
    kit.kill();
    await kit.until((state) => state.sessionId === sessionId && state.position >= 21.5, { timeout: 30_000, label: "past 21.5 s after the welcome" });
  });

  scenario("a command the screen already dealt with is not done again from a welcome", async (kit) => {
    await kit.ready();
    const sessionId = await playing(kit);
    let since = Date.now();
    kit.send({ type: "pause", id: "heard_pause", sessionId });
    await kit.message("report", { since, where: (m) => m.status === "paused" });
    since = Date.now();
    kit.send({ type: "resume", id: "heard_resume", sessionId });
    await kit.message("report", { since, where: (m) => m.status === "playing" });
    // The Hub still names the resume: the screen heard it, and plays on.
    kit.send({ type: "pause", sessionId });
    await kit.until((state) => state.paused, { label: "paused by an id-less pause" });
    kit.kill();
    await kit.message("hello", { since: Date.now(), timeout: 30_000 });
    await wait(4_000);
    assert.equal((await kit.debug()).paused, true, "the welcome's settled resume does not start playback again");
  });

  scenario("a load lost with the connection: the screen asks for the Hub's stream", async (kit) => {
    await kit.ready();
    const first = await playing(kit);
    // The Hub built another stream for this screen, and its load went with
    // the connection.
    kit.sessions += 1;
    const hubs = `ses_${kit.sessions}`;
    kit.state = { ...kit.state, sessionId: hubs, status: "playing" };
    kit.commands = null;
    const since = Date.now();
    kit.kill();
    const ask = await kit.waitFor((e) => e.kind === "http" && e.path === "/v1/playback/play", { since, timeout: 30_000, label: "a request for the Hub's stream" });
    assert.equal(ask.body.reason, "recovery");
    assert.equal(ask.body.sessionId, hubs);
    assert.notEqual(ask.body.sessionId, first);
  });

  scenario("subtitles chosen while the connection was dead are shown after the welcome", async (kit) => {
    await kit.ready();
    const sessionId = await playing(kit);
    kit.state = { ...kit.state, tracks: { subtitles: ["sub_en"], audio: null } };
    kit.kill();
    await kit.until((state) => state.sessionId === sessionId && state.subtitles.includes("sub_en"), { timeout: 30_000, label: "the Hub's subtitles shown" });
  });
});

// Optional parts the Apple TV app implements: the Hub serves a client that
// ignores them, but one that takes them must take them right.
describe("optional parts", () => {
  scenario("danmaku: the stream's comments show over the picture, and an agent's change applies and is acknowledged", async (kit) => {
    await kit.ready();
    await playing(kit);
    const shown = await kit.until((state) => state.danmaku?.onScreen > 0, { timeout: 30_000, label: "comments on screen" });
    assert.equal(shown.danmaku.enabled, true);
    const since = Date.now();
    kit.send({ type: "danmaku", id: "dm_off", settings: { enabled: false } });
    await kit.message("ack", { since, where: (m) => m.id === "dm_off" });
    await kit.until((state) => state.danmaku?.enabled === false && state.danmaku.onScreen === 0, { label: "comments hidden" });
  });

  scenario("agent canvas: declared in hello, drawn from the welcome and canvas_ops, and read again after a gap", async (kit) => {
    kit.canvasPut("note", { title: "Before", text: "Placed before the screen connected" });
    await kit.ready();
    assert.deepEqual(kit.hello.capabilities.canvas?.kinds, { note: 1, image: 1, choices: 1 });
    await kit.until((state) => state.canvas?.rev === 1 && state.canvas.shown.includes("obj_note1"), { label: "the welcome's note" });
    const choices = kit.canvasPut("choices", { title: "Which one?", options: [
      { item: { source: { plugin: "conformance", id: "long" }, title: "Conformance long", thumbnail: null, duration: 30 }, note: null },
      { label: "Something else", note: null },
    ] });
    await kit.until((state) => state.canvas?.rev === 2 && state.canvas.shown.includes(choices.id), { label: "the choices" });
    // A change the screen never heard: the next ops leave a gap, so it reads the whole canvas.
    const since = Date.now();
    kit.canvasOps([{ op: "remove", id: "obj_note1" }], { skip: true });
    kit.canvasPut("image", { url: "https://example.com/poster.jpg", alt: "A poster" });
    await kit.waitFor((e) => e.kind === "http" && e.path === "/v1/canvas", { since, label: "GET /v1/canvas after a gap" });
    await kit.until((state) => state.canvas?.rev === 4 && !state.canvas.shown.includes("obj_note1") && state.canvas.shown.includes("obj_image4"), { label: "the canvas read again" });
  });

  scenario("adaptive quality: a connection that cannot carry the stream asks for a lower cap", async (kit) => {
    await kit.ready();
    const sessionId = await playing(kit);
    // The connection degrades below the stream's bitrate.
    kit.mediaRate = 0.3;
    const step = await kit.waitFor((e) => e.kind === "http" && e.path === "/v1/playback/play" && e.body.reason === "quality", { timeout: 90_000, label: "a quality step" });
    assert.equal(step.body.sessionId, sessionId);
    assert.ok(typeof step.body.maxVideoKbps === "number" && step.body.maxVideoKbps > 0, `asked for ${step.body.maxVideoKbps}`);
  }, { timeout: 150_000 });
});
