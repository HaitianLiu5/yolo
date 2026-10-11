import assert from "node:assert/strict";
import { test } from "node:test";
import { createLegacyBridge } from "../src/legacy.js";

// The Drive-In bridge is temporary (0.3 deletes it with server/). It and this
// test are the only code in service/ that names the official source plugins:
// the Drive-In server plays Plex items through its Plex routes and anything
// else by URL.

const plexItem = (id) => ({ plugin: "plex", id });
const webVideo = (url) => ({ plugin: "ytdlp", id: url, url });

// A fake Drive-In server (server/) answering the legacy API.
function fakeDriveIn() {
  const calls = [];
  const state = { status: "idle", url: null, title: null, playerConnected: true, player: { currentTime: 0 } };
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || "GET", path: pathname, body });
    if (pathname === "/api/status") return Response.json(state);
    if (pathname === "/api/play") {
      Object.assign(state, { status: "playing", url: body.url, title: "A video" });
      return Response.json({ ok: true, title: "A video", isLive: false });
    }
    if (pathname === "/api/plex/play") {
      Object.assign(state, { status: "playing", url: `plex://${body.ratingKey}`, title: "Movie" });
      return Response.json({ ok: true, title: "Movie" });
    }
    if (pathname === "/api/control") {
      if (body.action === "stop") Object.assign(state, { status: "idle", url: null });
      return Response.json({ ok: true });
    }
    if (pathname === "/api/subtitles/select") return Response.json({ ok: true });
    return Response.json({ error: "nope" }, { status: 404 });
  };
  return { calls, state, bridge: createLegacyBridge({ baseUrl: "http://legacy.test", fetchImpl }) };
}

test("a Plex item plays through Drive-In's Plex route and is tracked as a session", async () => {
  const { bridge, calls } = fakeDriveIn();
  const descriptor = await bridge.prepare({ sessionId: "ses_1", source: plexItem("42"), startTime: 90, reason: "play" });
  assert.equal(descriptor.delivery.type, "external");
  assert.deepEqual(calls.at(-1), { method: "POST", path: "/api/plex/play", body: { ratingKey: "42", offset: 90_000, reason: "play" } });

  const [renderer] = await bridge.renderers();
  assert.deepEqual([renderer.playback.sessionId, renderer.playback.status], ["ses_1", "playing"]);

  await bridge.control("ses_1", { action: "seek", position: 120 });
  assert.equal(calls.at(-1).body.offset, 120_000);
  await bridge.stop("ses_1");
  assert.deepEqual(calls.at(-1).body, { action: "stop" });
});

test("a web video plays by the URL as given, and its subtitles map to languages", async () => {
  const { bridge, calls } = fakeDriveIn();
  const source = webVideo("https://example.com/v?ref=1");
  await bridge.prepare({ sessionId: "ses_2", source, startTime: 0, reason: "transfer" });
  assert.deepEqual(calls.at(-1).body, { url: "https://example.com/v?ref=1", startTime: 0, reason: "play" });
  assert.equal((await bridge.renderers())[0].playback.sessionId, "ses_2");
  await bridge.setTracks("ses_2", { subtitles: ["s_en", "s_zh-Hans"] });
  assert.deepEqual(calls.at(-1).body, { langs: ["en", "zh-Hans"], sourceUrl: "https://example.com/v?ref=1" });
  await assert.rejects(bridge.setTracks("ses_2", { audio: "a1" }), { code: "invalid_request" });
});

test("Plex track changes restart the transcode at the current position", async () => {
  const { bridge, calls, state } = fakeDriveIn();
  await bridge.prepare({ sessionId: "ses_3", source: plexItem("42"), startTime: 0, reason: "play" });
  state.player.currentTime = 33;
  await bridge.setTracks("ses_3", { subtitles: ["plex:7"], audio: "plex:2" });
  assert.deepEqual(calls.at(-1).body, { ratingKey: "42", offset: 33_000, reason: "seek", subtitleStreamID: "7", audioStreamID: "2" });
});

test("a source Drive-In cannot play is refused", async () => {
  const { bridge } = fakeDriveIn();
  await assert.rejects(bridge.prepare({ sessionId: "ses_4", source: { plugin: "folder", id: "a.mkv" }, startTime: 0 }), {
    code: "resolve_failed", message: /cannot play folder items/,
  });
});

test("a disconnected player's stale status is reported as idle", async () => {
  const { bridge, state } = fakeDriveIn();
  // Drive-In keeps the last session's status after the car disconnects.
  Object.assign(state, {
    status: "playing", url: "plex://9", title: "Movie", playerConnected: false, player: { currentTime: 1789, duration: 3600 },
  });
  assert.deepEqual(await bridge.health(), { online: true, playerConnected: false, status: "idle" });
  const [renderer] = await bridge.renderers();
  assert.equal(renderer.online, false);
  assert.deepEqual(
    { status: renderer.playback.status, title: renderer.playback.title, position: renderer.playback.position },
    { status: "idle", title: "Movie", position: 1789 },
  );
});
