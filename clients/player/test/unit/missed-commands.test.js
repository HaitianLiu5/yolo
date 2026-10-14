import assert from "node:assert/strict";
import test from "node:test";
import { createHeardCommands, missedCommands, subtitlesToFollow } from "../../src/missed-commands.js";

// What the welcome after a reconnect says Yolo commanded the stream on
// screen that the screen never heard (Agent Note 2026-10-07-hub-and-realtime-channel).

const state = { deviceId: "dev_car", sessionId: "ses_a", status: "paused", tracks: { subtitles: [], audio: null } };
const welcome = (commands, overrides = {}) => ({ state: { ...state, ...overrides }, commands: { sessionId: "ses_a", ...commands } });
const screen = (heard = [], options = {}) => ({ deviceId: "dev_car", sessionId: "ses_a", heard: (id) => heard.includes(id), ...options });

test("a pause, resume, or seek the screen never heard is missed; one it heard is not", () => {
  const commands = { playback: { id: "cmd_p", action: "pause" }, seek: { id: "cmd_s", position: 40 } };
  assert.deepEqual(missedCommands(welcome(commands), screen()), { pause: true, resume: false, resumeHeld: false, seek: 40 });
  assert.deepEqual(missedCommands(welcome(commands), screen(["cmd_p", "cmd_s"])), { pause: false, resume: false, resumeHeld: false, seek: null });
  assert.deepEqual(missedCommands(welcome({ playback: { id: "cmd_r", action: "resume" } }), screen()), { pause: false, resume: true, resumeHeld: false, seek: null });
});

test("only the stream on screen on this device counts, and a Hub that names no commands misses none", () => {
  const commands = { playback: { id: "cmd_p", action: "pause" } };
  const none = { pause: false, resume: false, resumeHeld: false, seek: null };
  assert.deepEqual(missedCommands(welcome(commands, { sessionId: "ses_b" }), screen()), none, "another stream");
  assert.deepEqual(missedCommands({ ...welcome(commands), commands: { ...commands, sessionId: "ses_old" } }, screen()), none, "commands for another stream");
  assert.deepEqual(missedCommands(welcome(commands, { deviceId: "dev_tv" }), screen()), none, "another device");
  assert.deepEqual(missedCommands(welcome(commands), screen([], { sessionId: null })), none, "nothing on screen");
  assert.deepEqual(missedCommands({ state }, screen()), none, "a 0.8.0 Hub");
  assert.deepEqual(missedCommands(welcome({ seek: { id: "cmd_s", position: "later" } }), screen()), none, "no position");
});

// In doubt, nothing starts playing: a pause here after the page last heard
// Yolo may be newer than the resume the reconnect lost.
test("a missed resume yields to the owner's pause here after the page last heard Yolo; a missed pause never does", () => {
  const resume = welcome({ playback: { id: "cmd_r", action: "resume" } });
  assert.deepEqual(missedCommands(resume, screen([], { heardAt: 1_000, pausedHereAt: 2_000 })), { pause: false, resume: false, resumeHeld: true, seek: null });
  assert.equal(missedCommands(resume, screen([], { heardAt: 2_000, pausedHereAt: 1_000 })).resume, true);
  const pause = welcome({ playback: { id: "cmd_p", action: "pause" } });
  assert.equal(missedCommands(pause, screen([], { heardAt: 1_000, pausedHereAt: 2_000 })).pause, true);
});

test("the heard ids keep the latest ones", () => {
  const heard = createHeardCommands(2);
  heard.note("a");
  heard.note("b");
  heard.note("a");
  heard.note("c");
  assert.deepEqual(["a", "b", "c"].map(heard.has), [true, false, true]);
  heard.note(undefined);
  assert.equal(heard.has(undefined), false);
});

const text = (id) => ({ id, delivery: "vtt", url: `/m/t/subtitles/${id}.vtt` });
const tracks = (selected) => ({ subtitles: [text("en"), text("fr"), { id: "pgs", delivery: "burn" }], audio: [], selected: { subtitles: selected, audio: null } });
const hubWith = (subtitles, overrides = {}) => ({ ...state, tracks: { subtitles, audio: null }, ...overrides });
const onScreen = (selected) => ({ deviceId: "dev_car", sessionId: "ses_a", tracks: tracks(selected) });

test("the screen follows the text subtitles Yolo chose when they switch in place", () => {
  assert.deepEqual(subtitlesToFollow(hubWith(["en", "fr"]), onScreen([])), ["en", "fr"]);
  assert.deepEqual(subtitlesToFollow(hubWith([]), onScreen(["en"])), []);
  assert.equal(subtitlesToFollow(hubWith(["fr", "en"]), onScreen(["en", "fr"])), null, "the same, in any order");
  assert.equal(subtitlesToFollow(hubWith(["pgs"]), onScreen([])), null, "burned in: a new stream");
  assert.equal(subtitlesToFollow(hubWith(["en"]), onScreen(["pgs"])), null, "from burned in: a new stream");
  assert.equal(subtitlesToFollow(hubWith(["de"]), onScreen([])), null, "a track the stream does not have");
  assert.equal(subtitlesToFollow(hubWith(["en"], { sessionId: "ses_b" }), onScreen([])), null, "another stream");
  assert.equal(subtitlesToFollow(hubWith(["en"], { deviceId: "dev_tv" }), onScreen([])), null, "another device");
});
