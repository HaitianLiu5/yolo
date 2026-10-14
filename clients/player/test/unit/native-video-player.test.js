import assert from "node:assert/strict";
import test from "node:test";
import {
  fullscreenCaptionTrack, hlsFailure, importHls, mediaElementFailure, NativeVideoPlayer, retryHlsLoad, streamTimelineOffset,
} from "../../src/engine/native-video-player.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class Ranges {
  constructor(ranges = []) {
    this.ranges = ranges;
  }

  get length() {
    return this.ranges.length;
  }

  start(index) {
    return this.ranges[index][0];
  }

  end(index) {
    return this.ranges[index][1];
  }
}

// A text track: its cues read null while it is disabled, as in browsers.
class FakeTextTrack {
  constructor(kind, label, language, mode = "hidden") {
    Object.assign(this, { kind, label, language, mode });
    this.cueList = [];
  }

  get cues() {
    return this.mode === "disabled" ? null : [...this.cueList];
  }

  addCue(cue) {
    this.cueList.push(cue);
  }

  removeCue(cue) {
    this.cueList = this.cueList.filter((other) => other !== cue);
  }
}

function textTrackList() {
  const list = [];
  const events = new EventTarget();
  list.addEventListener = (...args) => events.addEventListener(...args);
  list.removeEventListener = (...args) => events.removeEventListener(...args);
  list.emit = (type) => events.dispatchEvent(new Event(type));
  return list;
}

// A <video> element as far as the engine uses it. `policy` is the
// browser's autoplay rule: "allow", "muted-only" (sound needs a gesture), or
// "none". Seeks finish on the next tick unless `holdSeeks`.
class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.dataset = {};
    this.attributes = new Map();
    this.time = 0;
    this.duration = NaN;
    this.paused = true;
    this.ended = false;
    this.muted = false;
    this.volume = 1;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.readyState = 0;
    this.error = null;
    this.bufferedRanges = [];
    this.seekable = new Ranges();
    this.policy = "allow";
    this.holdSeeks = false;
    this.removed = false;
    this.quality = { totalVideoFrames: 0, droppedVideoFrames: 0 };
    this.srcValue = "";
    this.textTracks = textTrackList();
  }

  // A track the page adds; a stream's own tracks (an HLS playlist's
  // subtitles) arrive through `inBandTrack`.
  addTextTrack(kind, label, language) {
    const track = new FakeTextTrack(kind, label, language);
    this.textTracks.push(track);
    return track;
  }

  inBandTrack(kind, label, language) {
    const track = new FakeTextTrack(kind, label, language, "disabled");
    this.textTracks.push(track);
    this.textTracks.emit("addtrack");
    return track;
  }

  set src(value) {
    this.srcValue = value;
  }

  get src() {
    return this.srcValue;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.srcValue = "";
  }

  get currentTime() {
    return this.time;
  }

  set currentTime(value) {
    this.time = value;
    this.emit("seeking");
    if (!this.holdSeeks) setTimeout(() => this.emit("seeked"), 0);
  }

  get buffered() {
    return new Ranges(this.bufferedRanges);
  }

  async play() {
    if (this.policy === "none" || (this.policy === "muted-only" && !this.muted)) {
      throw Object.assign(new Error("play() needs a gesture"), { name: "NotAllowedError" });
    }
    if (this.paused) {
      this.paused = false;
      this.emit("play");
      if (this.readyState >= 3) this.emit("playing");
    }
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }

  load() {}

  remove() {
    this.removed = true;
  }

  getVideoPlaybackQuality() {
    return this.quality;
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  // The browser read the stream's header.
  metadata({ duration = 60, width = 320, height = 180 } = {}) {
    this.duration = duration;
    this.videoWidth = width;
    this.videoHeight = height;
    this.readyState = 4;
    this.emit("loadedmetadata");
  }
}

function harness(t, { hlsPath = "hls.js", loadHls, status = 200, now, respond = null } = {}) {
  const video = new FakeVideo();
  const events = { states: [], outputs: [], errors: [], ended: 0, probes: [], times: [], presentations: [], volumes: [] };
  const player = new NativeVideoPlayer({
    container: { appendChild: () => {} },
    createVideo: () => video,
    createCue: (startTime, endTime, text) => ({ startTime, endTime, text }),
    onTime: (seconds) => events.times.push(seconds),
    onPresentation: ({ fullscreen }) => events.presentations.push(fullscreen),
    onVolume: (volume) => events.volumes.push(volume),
    hlsPath,
    loadHls,
    baseUrl: "https://yolo.test/play",
    fetchFn: async (url, init) => {
      events.probes.push([url, init?.method || "GET"]);
      return respond ? respond(url, init) : { status };
    },
    ...(now ? { now } : {}),
    onStateChange: (state, detail) => events.states.push(detail.reason ? `${state}:${detail.reason}` : state),
    onAudioOutput: (output, detail) => events.outputs.push(`${output}${detail.hasVideo ? "" : ":audio-only"}`),
    onError: (error) => events.errors.push(error),
    onEnded: () => {
      events.ended += 1;
    },
  });
  t.after(() => player.destroy());
  return { video, player, events };
}

async function loaded(t, options = {}, loadOptions = { startTime: 5, duration: 60 }, metadata = {}) {
  const context = harness(t, { hlsPath: "native", ...options });
  const loading = context.player.load(loadOptions.source || { type: "mp4", url: "/m/token/f/0" }, loadOptions);
  await tick();
  context.video.metadata(metadata);
  await loading;
  return context;
}

test("play and pause from outside Yolo's controls become the owner's intent; the end is not a pause", async (t) => {
  const { video, player, events } = await loaded(t);
  assert.equal(player.getCurrentTime(), 5, "loaded at the start position");
  await player.play();
  assert.equal(player.getStatus(), "playing");
  // Picture-in-Picture's pause button, a phone call.
  video.pause();
  assert.deepEqual([events.states.at(-1), player.wantsPlayback], ["paused:external", false]);
  // And its play button.
  await video.play();
  assert.deepEqual([events.states.at(-1), player.wantsPlayback], ["playing:external", true]);

  // The end pauses the element too; the stream is over, not paused.
  video.ended = true;
  video.pause();
  video.emit("ended");
  assert.deepEqual([player.getStatus(), events.ended], ["ended", 1]);
  await player.play();
  assert.deepEqual([player.getStatus(), video.paused], ["ended", true], "an ended stream does not start again");
  assert.equal(events.states.filter((state) => state === "paused:external").length, 1);
});

test("when the browser blocks sound a picture plays muted until a tap, audio alone waits for one; the owner's own mute is no block", async (t) => {
  // A picture plays on muted, with "Tap for sound"; the tap brings the sound.
  const picture = await loaded(t);
  picture.video.policy = "muted-only";
  await picture.player.play();
  assert.deepEqual([picture.player.getStatus(), picture.video.muted, picture.events.outputs], ["playing", true, ["blocked"]]);
  picture.video.policy = "allow";
  await picture.player.enableAudioOutput();
  assert.deepEqual([picture.player.getStatus(), picture.video.muted, picture.player.audioOutputState], ["playing", false, "running"]);

  const { video, player, events } = await loaded(t, {}, { startTime: 0, duration: 60 }, { width: 0, height: 0 });
  video.policy = "muted-only";
  await player.play();
  assert.deepEqual([player.getStatus(), video.paused, events.outputs], ["paused", true, ["blocked:audio-only"]]);
  // The tap plays it, with sound.
  video.policy = "allow";
  await player.enableAudioOutput();
  await tick();
  assert.deepEqual([player.getStatus(), video.muted, player.audioOutputState], ["playing", false, "running"]);
  player.setVolume(0);
  assert.deepEqual([video.muted, player.audioOutputState], [true, "running"]);
});

test("a later seek replaces an earlier one; a seek while playing keeps playing", async (t) => {
  const { video, player } = await loaded(t);
  await player.play();
  video.holdSeeks = true;
  const first = player.seek(20_000n);
  const second = player.seek(30_000n);
  assert.equal(player.getStatus(), "seeking");
  video.emit("seeked");
  assert.deepEqual([await first, await second], [false, true]);
  assert.equal(player.getCurrentTime(), 30);
  assert.equal(player.getStatus(), "playing");
  // Clamped to the item.
  video.holdSeeks = false;
  await player.seek(90_000);
  assert.equal(player.getCurrentTime(), 60);
});

test("native HLS of a trimmed stream counts from where the source began", async (t) => {
  // The item is 600 s; the source's transcode began at 120 s, and its
  // playlist lacks the 118 s before the segment that holds 120 s.
  const { player, video } = await loaded(t, {}, { source: { type: "hls", url: "/m/token/p/0.m3u8" }, startTime: 120, duration: 600, trimToStart: true }, { duration: 482 });
  assert.equal(player.mode, "native-hls");
  assert.equal(video.currentTime, 2, "the element seeks inside the stream");
  assert.equal(player.getCurrentTime(), 120);
  assert.deepEqual(player.getSeekableRange(), { start: 118, end: 600 });
  await player.seek(300_000);
  assert.equal(video.currentTime, 182);

  assert.equal(streamTimelineOffset({ trimToStart: false, itemDuration: 600, streamDuration: 482, startTime: 120 }), 0, "only a trimmed stream");
  assert.equal(streamTimelineOffset({ trimToStart: true, itemDuration: 600, streamDuration: 300, startTime: 120 }), 0, "missing more than came before the start");
});

test("Yolo's first subtitle shows in the system's fullscreen player as the element's text track, on the stream's timeline, and only there", async (t) => {
  // A transcode resumed at 120 s of a 600 s item: its timeline begins at 118 s.
  const { video, player, events } = await loaded(t, {}, { source: { type: "hls", url: "/m/token/p/0.m3u8" }, startTime: 120, duration: 600, trimToStart: true }, { duration: 482 });
  const inBand = video.inBandTrack("subtitles", "English", "en");
  player.setCaptions([
    { id: "plex:21", label: "English", language: "eng", cues: [{ start: 100, end: 110, text: "Before" }, { start: 125, end: 128, text: "Hello" }] },
    { id: "plex:22", label: "中文", language: "zh", cues: [{ start: 125, end: 128, text: "你好" }] },
  ]);
  const [english, chinese] = video.textTracks.filter((track) => track !== inBand);
  assert.deepEqual(english.cues, [{ startTime: 7, endTime: 10, text: "Hello" }], "on the stream's timeline");
  assert.deepEqual([english.kind, english.label, english.language], ["subtitles", "English", "eng"]);
  assert.deepEqual([english.mode, chinese.mode, inBand.mode], ["hidden", "hidden", "disabled"], "inline, Yolo draws them");

  await player.play();
  video.emit("webkitbeginfullscreen");
  assert.deepEqual([english.mode, chinese.mode, inBand.mode], ["showing", "hidden", "disabled"]);
  // A choice in the system player's own menu holds while it is open.
  english.mode = "disabled";
  inBand.mode = "showing";
  video.textTracks.emit("change");
  assert.deepEqual([english.mode, inBand.mode], ["disabled", "showing"]);

  // Meanwhile its controls paused, seeked, and turned the sound off, and
  // not every event reached the page.
  video.paused = true;
  video.time = 30;
  video.muted = true;
  video.emit("webkitendfullscreen");
  assert.deepEqual([english.mode, chinese.mode, inBand.mode], ["hidden", "hidden", "disabled"], "back to Yolo's own subtitles");
  assert.deepEqual(events.presentations, [true, false]);
  assert.deepEqual([events.states.at(-1), player.wantsPlayback], ["paused:external", false]);
  assert.equal(events.times.at(-1), 148, "the position the system's player left");
  assert.deepEqual(events.volumes, [0]);

  // Inline, a track the browser shows is turned off again.
  inBand.mode = "showing";
  video.textTracks.emit("change");
  assert.equal(inBand.mode, "disabled");
  // Subtitles off: Yolo's tracks too, also in fullscreen.
  player.setCaptions([]);
  video.emit("webkitbeginfullscreen");
  assert.deepEqual([english.mode, chinese.mode, inBand.mode], ["disabled", "disabled", "disabled"]);
});

test("without Yolo's cues for a subtitle, the stream's own track in its language stands in", async (t) => {
  const { video, player } = await loaded(t, {}, { source: { type: "hls", url: "/m/token/p/0.m3u8" }, startTime: 0, duration: 60 });
  const french = video.inBandTrack("subtitles", "Français", "fr");
  const english = video.inBandTrack("captions", "English CC", "en-US");
  // A subtitle Yolo could not load.
  player.setCaptions([{ id: "sub_1", label: "English", language: "eng", cues: null }]);
  video.emit("webkitbeginfullscreen");
  assert.deepEqual([english.mode, french.mode], ["showing", "disabled"]);
  video.emit("webkitendfullscreen");
  assert.deepEqual([english.mode, french.mode], ["disabled", "disabled"]);

  const own = { kind: "subtitles", language: "en" };
  assert.equal(fullscreenCaptionTrack([{ id: "a", language: "de", cues: null }], [french, english], () => null), null, "no track in that language");
  assert.equal(fullscreenCaptionTrack([{ id: "a", language: "en", cues: [] }], [english], () => own), own, "Yolo's own track first");
});

function fakeHls() {
  const instances = [];
  class Hls {
    static isSupported() {
      return true;
    }

    constructor(config) {
      this.config = config;
      this.handlers = new Map();
      this.audioTracks = [];
      this.audioTrack = -1;
      this.levels = [];
      this.currentLevel = -1;
      this.bandwidthEstimate = 500_000;
      this.recovered = 0;
      this.destroyed = false;
      instances.push(this);
    }

    on(event, handler) {
      this.handlers.set(event, [...(this.handlers.get(event) || []), handler]);
    }

    trigger(event, data) {
      for (const handler of this.handlers.get(event) || []) handler(event, data);
    }

    attachMedia(video) {
      this.media = video;
    }

    loadSource(url) {
      this.url = url;
    }

    recoverMediaError() {
      this.recovered += 1;
    }

    destroy() {
      this.destroyed = true;
    }
  }
  Hls.Events = {
    INIT_PTS_FOUND: "initPts", BUFFER_CODECS: "codecs", FRAG_LOADING: "fragLoading", FRAG_LOADED: "fragLoaded",
    AUDIO_TRACKS_UPDATED: "audioTracks", AUDIO_TRACK_SWITCHED: "audioSwitched", ERROR: "error",
  };
  return { instances, loadHls: async () => ({ default: Hls }) };
}


test("hls.js: the media's own timestamps are the item's timeline, and a 410 ends the stream", async (t) => {
  const { instances, loadHls } = fakeHls();
  const { video, player, events } = harness(t, { hlsPath: "hls.js", loadHls });
  const loading = player.load({ type: "hls", url: "/m/token/p/0.m3u8" }, { startTime: 130, duration: 600, trimToStart: true });
  await tick();
  const [hls] = instances;
  assert.equal(hls.config.startPosition, 0, "a trimmed stream starts with its first segment");
  // The first segment's media starts at 120 s of the item.
  hls.trigger("initPts", { initPTS: 120 * 90_000, timescale: 90_000 });
  video.metadata({ duration: 480 });
  await loading;
  assert.deepEqual([video.currentTime, player.getCurrentTime()], [10, 130]);

  // hls.js's estimate is the throughput; several variants are its to switch.
  hls.trigger("fragLoading", {});
  hls.trigger("fragLoaded", {});
  hls.bandwidthEstimate = 3_200_000;
  hls.levels = [{ bitrate: 800_000 }, { bitrate: 2_400_000 }];
  const stats = player.getStats();
  assert.deepEqual([stats.bandwidth, stats.hlsThroughputSampleCount, stats.adaptsWithinStream], [3_200_000, 1, true]);

  // One decode hiccup is hls.js's to repair. hls.js keeps a single
  // variant's fragment in its penalty box and asks again (not fatal), but a
  // 410 is final.
  hls.trigger("error", { fatal: true, type: "mediaError", details: "bufferAppendError" });
  assert.deepEqual([hls.recovered, events.errors.length], [1, 0]);
  hls.trigger("error", { fatal: false, type: "networkError", details: "fragLoadError", response: { code: 410 } });
  assert.equal(events.errors[0].code, "SESSION_EXPIRED");
  assert.equal(player.getStatus(), "error");
});

test("failures map to what recovery does: 410 and 403 are final, the rest gets a new stream or the error panel", () => {
  const config = { maxNumRetry: 6 };
  assert.equal(retryHlsLoad(config, 0, false, { code: 410 }, true), false);
  assert.equal(retryHlsLoad(config, 0, false, { code: 403 }, true), false);
  assert.equal(retryHlsLoad(config, 2, false, { code: 404 }, false), true, "a transcoder's segment may come");
  assert.equal(retryHlsLoad(config, 3, false, { code: 404 }, false), false);
  assert.equal(hlsFailure({ type: "networkError", details: "manifestLoadError", response: { code: 403 } }).code, "UPSTREAM_ACCESS_DENIED");
  assert.equal(hlsFailure({ type: "networkError", details: "fragLoadTimeOut" }).code, "MEDIA_NETWORK_ERROR");
  assert.equal(hlsFailure({ type: "mediaError", details: "bufferAppendError" }).code, "MEDIA_DECODE_ERROR");
  assert.equal(mediaElementFailure({ code: 2 }, 410).code, "SESSION_EXPIRED");
  assert.equal(mediaElementFailure({ code: 3 }, 200).code, "MEDIA_DECODE_ERROR");
  assert.equal(mediaElementFailure({ code: 4 }, 200).code, "MEDIA_UNSUPPORTED");
  assert.equal(mediaElementFailure({ code: 2 }, null).code, "MEDIA_NETWORK_ERROR");
});

test("a <video> error asks the node about the stream, also while loading", async (t) => {
  const expired = await loaded(t, { status: 410 });
  expired.video.error = { code: 2, message: "network" };
  expired.video.emit("error");
  await tick();
  await tick();
  assert.deepEqual(expired.events.probes, [["https://yolo.test/m/token/f/0", "HEAD"]]);
  assert.equal(expired.events.errors[0].code, "SESSION_EXPIRED");

  const { video, player } = harness(t, { hlsPath: "native", status: 410 });
  const loading = player.load({ type: "mp4", url: "/m/token/f/0" }, { startTime: 0 });
  await tick();
  video.error = { code: 2 };
  video.emit("error");
  await assert.rejects(loading, { code: "SESSION_EXPIRED" });
});

test("native HLS asks the node about the variant playlist, which reaches the source", async (t) => {
  // The node answers the master from what it holds; the variant asks the
  // source, whose transcode is gone.
  const respond = (url, init) => {
    if (url.endsWith("/p/0.m3u8")) return { status: 200, text: async () => "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/m/token/p/1.m3u8\n" };
    return { status: init?.method === "HEAD" ? 410 : 404 };
  };
  const { video, events } = await loaded(t, { respond }, { source: { type: "hls", url: "/m/token/p/0.m3u8" }, startTime: 0, duration: 60 });
  video.error = { code: 2 };
  video.emit("error");
  for (let index = 0; index < 6; index += 1) await tick();
  assert.deepEqual(events.probes, [
    ["https://yolo.test/m/token/p/0.m3u8", "HEAD"], ["https://yolo.test/m/token/p/0.m3u8", "GET"], ["https://yolo.test/m/token/p/1.m3u8", "HEAD"],
  ]);
  assert.equal(events.errors[0].code, "SESSION_EXPIRED");
});

test("waiting without new data asks the node, then gives the stream up", async (t) => {
  let clock = 1_000;
  const { video, player, events } = await loaded(t, { status: 200, now: () => clock });
  await player.play();
  video.bufferedRanges = [[0, 6]];
  video.emit("waiting");
  for (let second = 0; second < 9; second += 1) {
    clock += 1_000;
    player.watch();
  }
  await tick();
  assert.equal(events.probes.length, 1, "the node is asked once per wait");
  assert.equal(events.errors.length, 0);
  for (let second = 0; second < 22; second += 1) {
    clock += 1_000;
    player.watch();
  }
  assert.equal(events.errors[0]?.code, "MEDIA_STALLED");

  // Playing with the time standing still is a wait the browser did not report.
  const frozen = await loaded(t, { now: () => clock });
  await frozen.player.play();
  frozen.player.watch();
  clock += 6_000;
  frozen.player.watch();
  assert.equal(frozen.player.getStatus(), "buffering");
  assert.equal(frozen.events.states.at(-1), "buffering:frozen");
});

test("without hls.js, buffer growth while fetching measures throughput", async (t) => {
  let clock = 0;
  const { video, player } = await loaded(t, { now: () => clock }, { startTime: 0, duration: 60, mediaKbps: 1000 });
  // A few seconds on, so the sample taken at load is out of the window.
  clock += 5_000;
  video.bufferedRanges = [[0, 2]];
  player.watch();
  clock += 2_000;
  video.bufferedRanges = [[0, 3]];
  player.watch();
  const stats = player.getStats();
  assert.equal(stats.bandwidth, 500_000, "half a second of 1000 kbps media per second");
  assert.equal(stats.hlsThroughputSampleCount, 2);
  assert.equal(stats.adaptsWithinStream, false);
});

test("hls.js is imported once, so the home screen's preload serves the first stream; a failed import is tried again", async () => {
  let loads = 0;
  const failing = async () => {
    loads += 1;
    throw new Error("offline");
  };
  await assert.rejects(importHls(failing), /offline/);
  const module = { default: class Hls {} };
  const load = async () => {
    loads += 1;
    return module;
  };
  const preload = importHls(load);
  assert.equal(await importHls(load), await preload);
  assert.equal(await preload, module);
  assert.equal(loads, 2);
});
