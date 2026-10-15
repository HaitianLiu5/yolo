import assert from "node:assert/strict";
import test from "node:test";
import {
  createOwnActions, createSettledCommands, danmakuToApply, missedCommands, subtitlesToFollow,
} from "../../src/missed-commands.js";

// What the welcome after a reconnect says Yolo commanded the stream on
// screen that the screen never dealt with, read against what the owner did
// here unheard (Agent Note 2026-10-07-hub-and-realtime-channel).

const state = { deviceId: "dev_car", sessionId: "ses_a", status: "paused", tracks: { subtitles: [], audio: null } };
const welcome = (commands, overrides = {}) => ({ state: { ...state, ...overrides }, commands: { sessionId: "ses_a", ...commands } });
const screen = (settled = createSettledCommands(), own = new Set()) => ({ deviceId: "dev_car", sessionId: "ses_a", settled, own });
const NONE = { pause: false, resume: false, resumeHeld: false, seek: null, seekHeld: false };

test("a pause, resume, or seek the screen never dealt with is missed; one it heard is not", () => {
  const commands = { playback: { id: "cmd_p", action: "pause" }, seek: { id: "cmd_s", position: 40 } };
  assert.deepEqual(missedCommands(welcome(commands), screen()), { ...NONE, pause: true, seek: 40 });
  const settled = createSettledCommands();
  settled.settle("ses_a", "playback", "cmd_p");
  settled.settle("ses_a", "seek", "cmd_s");
  assert.deepEqual(missedCommands(welcome(commands), screen(settled)), NONE);
  assert.deepEqual(missedCommands(welcome({ playback: { id: "cmd_r", action: "resume" } }), screen()), { ...NONE, resume: true });
});

// A welcome settles what it names, done or left out: the next welcome
// naming the same commands changes nothing, also after the owner's pause
// counts as heard.
test("commands a welcome named are settled for that stream; another stream starts with none", () => {
  const settled = createSettledCommands();
  const resume = welcome({ playback: { id: "cmd_r", action: "resume" }, seek: { id: "cmd_s", position: 9 } });
  assert.deepEqual(missedCommands(resume, screen(settled, new Set(["playback"]))), { ...NONE, resumeHeld: true, seek: 9 });
  settled.settleWelcome(resume, "ses_a");
  assert.deepEqual(missedCommands(resume, screen(settled)), NONE, "the second welcome");
  settled.settle("ses_b", "playback", "cmd_x");
  assert.deepEqual(missedCommands(resume, screen(settled)), { ...NONE, resume: true, seek: 9 }, "settled for another stream only");
  settled.settleWelcome({ ...resume, commands: { ...resume.commands, sessionId: "ses_old" } }, "ses_a");
  assert.equal(settled.has("ses_a", "playback", "cmd_r"), false, "commands of another stream settle nothing");
});

test("only the stream on screen on this device counts, and a Hub that names no commands misses none", () => {
  const commands = { playback: { id: "cmd_p", action: "pause" } };
  assert.deepEqual(missedCommands(welcome(commands, { sessionId: "ses_b" }), screen()), NONE, "another stream");
  assert.deepEqual(missedCommands({ ...welcome(commands), commands: { ...commands, sessionId: "ses_old" } }, screen()), NONE, "commands for another stream");
  assert.deepEqual(missedCommands(welcome(commands, { deviceId: "dev_tv" }), screen()), NONE, "another device");
  assert.deepEqual(missedCommands(welcome(commands), { ...screen(), sessionId: null }), NONE, "nothing on screen");
  assert.deepEqual(missedCommands({ state }, screen()), NONE, "a 0.8.0 Hub");
  assert.deepEqual(missedCommands(welcome({ seek: { id: "cmd_s", position: "later" } }), screen()), NONE, "no position");
});

// In doubt, nothing starts playing: a pause here that Yolo may not have
// heard may be newer than the resume the reconnect lost. A seek here
// unheard wins over a missed seek the same way. A missed pause always goes.
test("a missed resume or seek yields to the owner's unheard pause or seek here; a missed pause never does", () => {
  const commands = welcome({ playback: { id: "cmd_r", action: "resume" }, seek: { id: "cmd_s", position: 40 } });
  assert.deepEqual(missedCommands(commands, screen(undefined, new Set(["playback"]))), { ...NONE, resumeHeld: true, seek: 40 });
  assert.deepEqual(missedCommands(commands, screen(undefined, new Set(["seek"]))), { ...NONE, resume: true, seekHeld: true });
  const pause = welcome({ playback: { id: "cmd_p", action: "pause" } });
  assert.equal(missedCommands(pause, screen(undefined, new Set(["playback"]))).pause, true);
});

// The owner's action counts as heard only once Yolo answered a ping sent
// after it; a welcome takes what is unheard and leaves nothing unheard.
test("an owner action is unheard until a ping sent after it is answered, and a welcome takes it", () => {
  const pings = [];
  const own = createOwnActions({ confirm: (heard) => pings.push(heard) > 0 });
  own.note("playback");
  own.note("seek");
  assert.equal(pings.length, 1, "one ping in flight at a time");
  pings[0]();
  assert.equal(pings.length, 2, "the seek came after that ping: it needs one of its own");
  pings[1]();
  own.note("playback");
  assert.equal(pings.length, 3);
  assert.deepEqual([...own.take()], ["playback"], "unanswered");
  assert.deepEqual([...own.take()], [], "a welcome took it");
  own.note("danmaku:density");
  pings[2]();
  assert.deepEqual([...own.take()], ["danmaku:density"], "an answer from before the welcome counts for nothing after it");
});

// Holding an arrow key seeks about 30 times a second: one ping is in
// flight, and its answer covers what came before it; what came after it
// waits for one more.
test("owner actions share one ping in flight, and what came after it gets the next", () => {
  const pings = [];
  const own = createOwnActions({ confirm: (heard) => pings.push(heard) > 0 });
  own.note("seek");
  for (let step = 0; step < 30; step += 1) own.note("seek");
  assert.equal(pings.length, 1);
  pings[0]();
  assert.equal(pings.length, 2, "the seeks after the first ping get another");
  pings[1]();
  assert.equal(pings.length, 2);
  assert.deepEqual([...own.take()], []);
});

// Without a welcomed connection nothing is pinged, and the action stays
// unheard until the welcome takes it; the next action tries again.
test("an owner action that could not be pinged stays unheard", () => {
  let open = false;
  const pings = [];
  const own = createOwnActions({ confirm: (heard) => open && pings.push(heard) > 0 });
  own.note("playback");
  open = true;
  own.note("seek");
  assert.equal(pings.length, 1);
  pings[0]();
  assert.deepEqual([...own.take()], [], "the later ping covered the earlier action too");
  open = false;
  own.note("playback");
  assert.deepEqual([...own.take()], ["playback"]);
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

// A danmaku change the Hub sends again (`again`) skips what this page
// applied from that change already, which the owner may have changed since,
// and what the owner changed here unheard; a live change goes whole.
test("a danmaku change sent again keeps only the settings neither applied from it nor changed here unheard", () => {
  const change = { id: "cmd_d1", settings: { density: "high", opacity: 0.6, area: "full" } };
  assert.deepEqual(danmakuToApply(change, { heard: { density: "cmd_d1" }, own: new Set(["danmaku:opacity"]) }), change.settings, "live");
  assert.deepEqual(
    danmakuToApply({ ...change, again: true }, { heard: { density: "cmd_d1", area: "cmd_d0" }, own: new Set(["danmaku:opacity"]) }),
    { area: "full" },
  );
  assert.deepEqual(danmakuToApply({ id: "cmd_d2", again: true }, { heard: {}, own: new Set() }), {});
});
