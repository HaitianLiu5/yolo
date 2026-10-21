// The web profile's playback engine (Agent Note 2026-10-12-two-playback-engines):
// the browser's own <video> element, with HLS through hls.js (Media Source
// Extensions) or the browser's native HLS, and progressive files directly.
// It has the canvas engine's interface (mediabunny-player.js), so player.js
// drives both the same way: states, time, seeks, stats, and sound.
//
// Positions are the item's: a <video> element counts from the stream's first
// segment, which for a source that began at an offset (a transcode resumed
// part way, the stream's `trimToStart`) is not the item's beginning. hls.js
// says where the media's own timestamps start (INIT_PTS_FOUND), which is the
// timeline the canvas engine reads; native HLS does not, so the missing part
// of the item's duration stands in for it.
//
// Buffering means the time stands still while the element should play. The
// element's events alone do not say so: WebKit's native HLS fires
// `waiting`, or ends a seek below HAVE_FUTURE_DATA, and then plays on
// without `playing` or `canplay`. So the time moving ends a wait, and a
// `waiting` becomes buffering only once the time has stood still for
// STALL_CONFIRM_MS. A browser may also pause the element itself when the
// data runs out (`pause` with nothing ahead to play): that is a stall too,
// not the owner's pause, and the engine plays on once data is back.
//
// Failures are classified for player.js's recovery: a 410 from the node is
// SESSION_EXPIRED, a 403 UPSTREAM_ACCESS_DENIED; a stall without new data,
// a network error, or a decode error is recoverable by a new stream.
//
// Every stream plays in the element the last stream played in
// (reusableVideo): WebKit lets an element play sound without a gesture
// only once a gesture has started it, so a new element for a new stream (a
// quality change, a recovery) would play muted until another tap.
//
// On iPhone the element's fullscreen is the system's own player, where
// Yolo's subtitles and danmaku cannot show. There Yolo's subtitles become
// the element's text tracks, and on the way back the engine takes over what
// that player did: a pause, a play, a seek, the sound turned off or on, or
// another speed.

import { trackLanguage } from "@useyolo/core";
import { MAX_SPEED, MIN_SPEED } from "../playback-speed.js";

const LOAD_TIMEOUT_MS = 45_000;
const SEEK_TIMEOUT_MS = 20_000;
const TIME_EVENT_INTERVAL_MS = 100;
const WATCH_INTERVAL_MS = 1_000;
// Playing without the time moving this long is a stall the browser did not
// report.
const FROZEN_AFTER_MS = 5_000;
// After `waiting`, a stall only once the time has stood still this long: a
// brief wait the picture moves on from shows no spinner.
const STALL_CONFIRM_MS = 750;
// Waiting this long asks the node whether the session still exists.
const PROBE_AFTER_MS = 8_000;
const PROBE_TIMEOUT_MS = 5_000;
// Waiting this long without new data gives the stream up.
const STALLED_AFTER_MS = 30_000;
// Below this much buffered media the browser is still fetching, so how fast
// the buffer grows measures the connection.
const FILLING_BELOW_SECONDS = 20;
const FILL_WINDOW_MS = 4_000;
const FIRST_FRAME_FALLBACK_MS = 1_000;
// Smaller media timestamp offsets are encoder delays, not a later start.
const MIN_TIMELINE_OFFSET_SECONDS = 0.5;
const AUDIO_CODEC = /^(mp4a|opus|ac-3|ec-3|mp3|flac|alac|vorbis)/i;
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value) => (Number.isFinite(value) ? value : null);

function codedError(message, code, fields = {}) {
  return Object.assign(new Error(message), { code, ...fields });
}

/**
 * Where a stream that native HLS plays begins in the item, in seconds. Only
 * a stream the node may have trimmed to its start position (`trimToStart`)
 * begins later than 0: it then lacks the item's beginning up to that point,
 * at most a segment before the start position and never after it.
 */
function streamTimelineOffset({ trimToStart = false, itemDuration, streamDuration, startTime, isLive = false, toleranceSeconds = 12 } = {}) {
  if (!trimToStart || isLive) return 0;
  const item = Number(itemDuration);
  const stream = Number(streamDuration);
  const start = Number(startTime);
  if (!(item > 0) || !(stream > 0) || !Number.isFinite(stream) || !(start > 0)) return 0;
  const missing = item - stream;
  if (missing < MIN_TIMELINE_OFFSET_SECONDS || missing > start + 1 || start - missing > toleranceSeconds) return 0;
  return missing;
}

/**
 * hls.js's retry rule for Yolo's /m/* routes: a 410 (the session ended) and
 * a 403 (upstream refused) are final, a 404 (a transcoder's segment not
 * written yet) is retried a few times, everything else as hls.js decides.
 */
function retryHlsLoad(retryConfig, retryCount, _isTimeout, response, retry) {
  const status = response?.code;
  if (status === 410 || status === 403) return false;
  if (status === 404) return Boolean(retryConfig) && retryCount < Math.min(3, retryConfig.maxNumRetry);
  return retry;
}

/** A fatal hls.js error as the error player.js recovers from or shows. */
function hlsFailure(data = {}) {
  const status = data.response?.code ?? null;
  const detail = data.details || "unknown";
  if (status === 410) return codedError(`The node ended this playback session (${detail})`, "SESSION_EXPIRED", { status });
  if (status === 403) return codedError(`Upstream answered 403 (${detail})`, "UPSTREAM_ACCESS_DENIED", { status });
  if (data.type === "networkError") return codedError(`HLS network error: ${detail}${status ? ` (${status})` : ""}`, "MEDIA_NETWORK_ERROR", { status });
  if (data.type === "mediaError") return codedError(`HLS media could not be decoded: ${detail}`, "MEDIA_DECODE_ERROR");
  return codedError(`HLS playback failed: ${detail}`, "MEDIA_UNSUPPORTED");
}

/**
 * A <video> element's error as the same, once the node said what it thinks
 * of the stream's URL (`status`, or null when it did not answer).
 */
function mediaElementFailure(mediaError, status) {
  if (status === 410) return codedError("The node ended this playback session", "SESSION_EXPIRED", { status });
  if (status === 403) return codedError("Upstream answered 403", "UPSTREAM_ACCESS_DENIED", { status });
  const message = mediaError?.message ? ` (${mediaError.message})` : "";
  if (mediaError?.code === 3) return codedError(`The browser could not decode the stream${message}`, "MEDIA_DECODE_ERROR");
  if (mediaError?.code === 4) return codedError(`This browser does not play this stream${message}`, "MEDIA_UNSUPPORTED");
  return codedError(`Media network error${message}`, "MEDIA_NETWORK_ERROR");
}

// hls.js is its own chunk, which only a page that plays HLS through it
// downloads (Agent Note 2026-10-12-two-playback-engines). One import serves
// every stream; the web profile's home screen starts it early (main.js), so
// the first tap does not wait for the chunk. A failed import is tried again
// by the next caller.
let hlsModule = null;
export function importHls(load = () => import("hls.js")) {
  hlsModule ??= load().catch((error) => {
    hlsModule = null;
    throw error;
  });
  return hlsModule;
}

// The element a closed engine leaves behind, for the next stream, and the
// subtitle tracks Yolo added to an element, which stay for its life: a
// closed engine's are disabled, and the next one takes them up again.
let spareVideo = null;
const spentCaptionTracks = new WeakMap();

/**
 * The element for a new engine: the one the last closed engine played in,
 * else a new one from `create`.
 */
function reusableVideo(create = () => document.createElement("video")) {
  const video = spareVideo;
  spareVideo = null;
  return video || create();
}

const probeSignal = () => (typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(PROBE_TIMEOUT_MS) : undefined);

const isCaptionTrack = (track) => track?.kind === "subtitles" || track?.kind === "captions";

/**
 * Which text track the system's fullscreen player shows for Yolo's
 * subtitles (`captions`, in Yolo's order): for the first that has one,
 * Yolo's own track with its cues (`ownTrack(caption)`), or else a subtitle
 * track of the stream itself (`embedded`, an HLS playlist's) in the same
 * language; null for none.
 */
function fullscreenCaptionTrack(captions, embedded, ownTrack) {
  for (const caption of captions) {
    const track = ownTrack(caption);
    if (track) return track;
    const language = caption?.language ? trackLanguage(caption.language) : "";
    const match = language && embedded.find((candidate) => isCaptionTrack(candidate)
      && candidate.language && trackLanguage(candidate.language) === language);
    if (match) return match;
  }
  return null;
}

/** The URI of a master playlist's first variant, or null for a media playlist. */
export function firstVariantUri(playlist) {
  const lines = String(playlist || "").split(/\r?\n/).map((line) => line.trim());
  const index = lines.findIndex((line) => line.startsWith("#EXT-X-STREAM-INF"));
  if (index === -1) return null;
  return lines.slice(index + 1).find((line) => line && !line.startsWith("#")) || null;
}

/**
 * Media throughput from how fast the buffer grows while the browser fetches,
 * in media seconds per second, from { at (ms), end (s) } samples; null
 * without two samples in the window.
 */
function bufferFillRate(samples, now, windowMs = FILL_WINDOW_MS) {
  const recent = samples.filter((sample) => now - sample.at <= windowMs);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent.at(-1);
  const seconds = (last.at - first.at) / 1000;
  return seconds > 0 ? Math.max(0, (last.end - first.end) / seconds) : null;
}

export class NativeVideoPlayer {
  /**
   * @param {object} options
   * @param {HTMLElement} options.container
   * @param {"hls.js" | "native"} [options.hlsPath] how HLS reaches the element
   * @param {() => Promise<{ default: any }>} [options.loadHls] hls.js (importHls)
   * @param {() => HTMLVideoElement} [options.createVideo]
   * @param {(url: string, init?: object) => Promise<Response>} [options.fetchFn]
   * @param {string} [options.baseUrl]
   * @param {() => number} [options.now]
   */
  constructor({
    container,
    onStateChange = () => {},
    onTime = () => {},
    onFirstVideo = () => {},
    onEnded = () => {},
    onError = () => {},
    onAudioOutput = () => {},
    onTracks = () => {},
    onPresentation = () => {},
    onVolume = () => {},
    onRate = () => {},
    hlsPath = "hls.js",
    loadHls = () => importHls(),
    createVideo = () => reusableVideo(),
    createCue = (start, end, text) => new globalThis.VTTCue(start, end, text),
    fetchFn = (...args) => globalThis.fetch(...args),
    baseUrl = globalThis.location?.href,
    now = () => globalThis.performance?.now?.() ?? Date.now(),
  }) {
    this.onStateChange = onStateChange;
    this.onTime = onTime;
    this.onFirstVideo = onFirstVideo;
    this.onEnded = onEnded;
    this.onError = onError;
    this.onAudioOutput = onAudioOutput;
    this.onTracks = onTracks;
    this.onPresentation = onPresentation;
    this.onVolume = onVolume;
    this.onRate = onRate;
    this.createCue = createCue;
    this.hlsPath = hlsPath;
    this.loadHls = loadHls;
    this.fetchFn = fetchFn;
    this.baseUrl = baseUrl;
    this.now = now;

    const video = createVideo();
    // A reused element starts as a new one would, with the sound on.
    video.removeAttribute("data-kept");
    video.muted = false;
    video.defaultPlaybackRate = 1;
    video.playbackRate = 1;
    // At a speed other than 1 the voice keeps its pitch, as on YouTube
    // (the default in today's browsers; prefixed in older Safari).
    video.preservesPitch = true;
    if ("webkitPreservesPitch" in video) video.webkitPreservesPitch = true;
    video.dataset.engine = "native";
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.setAttribute("x-webkit-airplay", "allow");
    video.preload = "auto";
    video.controls = false;
    container.appendChild(video);
    this.video = video;
    // The canvas engine's picture; this engine's is `video`.
    this.canvas = null;
    this.audioContext = null;
    this.hls = null;

    this.state = "idle";
    this.mode = null;
    this.url = null;
    this.loaded = false;
    this.destroyed = false;
    this.failed = false;
    this.wantsPlayback = false;
    this.isLive = false;
    this.duration = 0;
    this.offset = 0;
    this.trimToStart = false;
    this.mediaKbps = 0;
    this.volume = 1;
    // The browser would not start sound without a gesture: playing muted.
    this.policyMuted = false;
    // What the engine last set the element's `muted` to.
    this.mutedByEngine = false;
    // The speed Yolo set (player.js); another one came from the system's player.
    this.rateByEngine = 1;
    this.audioOutputReported = null;
    this.hasAudio = null;
    this.videoTrack = null;
    this.videoCodec = null;
    this.audioCodec = null;
    this.width = 0;
    this.height = 0;
    this.firstVideoRendered = false;
    this.seekRequestCount = 0;
    this.seekSupersededCount = 0;
    this.lastSeekTarget = null;
    this.pendingSeek = null;
    this.pendingStart = 0;
    this.hlsStartSeconds = null;
    this.initPts = null;
    this.mediaErrorRecoveries = 0;
    this.fragmentsLoaded = 0;
    this.fragmentsLoading = 0;
    this.fillSamples = [];
    this.lastBufferedEnd = 0;
    this.lastBufferGrowthAt = 0;
    this.lastProgressTime = null;
    this.lastProgressAt = 0;
    // When `waiting` came, and the time then, until the time moves again.
    this.waitingSince = 0;
    this.waitingTime = null;
    this.stallTimer = null;
    // The browser paused the element itself when the data ran out: playing
    // again is the engine's to do, once there is data.
    this.pausedByStall = false;
    this.bufferingSince = 0;
    this.probedThisWait = false;
    this.lastTimeEventAt = 0;
    this.loadWaiter = null;
    this.timeTimer = null;
    this.watchTimer = null;
    this.firstFrameTimer = null;
    // In the system's fullscreen player (iPhone), and Yolo's subtitles as the
    // element's text tracks for it: Yolo's track id → { track, cues, offset }.
    this.nativeFullscreen = false;
    this.captions = [];
    this.captionTracks = new Map();
    this.suspended = false;

    this.listeners = [];
    this.listen("playing", () => this.handlePlaying());
    this.listen("play", () => this.handlePlay());
    this.listen("waiting", () => this.handleWaiting());
    this.listen("pause", () => this.handlePause());
    this.listen("ended", () => this.handleEnded());
    this.listen("error", () => void this.handleMediaError());
    this.listen("loadedmetadata", () => this.handleMetadata());
    this.listen("resize", () => this.readPictureSize());
    this.listen("timeupdate", () => {
      this.noteProgress();
      this.emitTime();
    });
    this.listen("loadeddata", () => this.armFirstFrameFallback());
    this.listen("canplay", () => this.handleCanPlay());
    this.listen("volumechange", () => this.handleVolumeChange());
    this.listen("ratechange", () => this.handleRateChange());
    this.listen("webkitbeginfullscreen", () => this.handleNativeFullscreen(true));
    this.listen("webkitendfullscreen", () => this.handleNativeFullscreen(false));
    // Yolo draws its own subtitles over the picture: the browser's captions
    // (a playlist's subtitles, captions in the video, Yolo's own text tracks)
    // stay off, except in the system's fullscreen player, where what the
    // owner picks in its menu holds.
    this.hideTextTracks = () => {
      if (!this.nativeFullscreen) this.applyCaptionModes();
    };
    this.video.textTracks?.addEventListener?.("addtrack", this.hideTextTracks);
    this.video.textTracks?.addEventListener?.("change", this.hideTextTracks);
  }

  listen(type, handler) {
    const wrapped = (event) => {
      if (!this.destroyed) handler(event);
    };
    this.video.addEventListener(type, wrapped);
    this.listeners.push([type, wrapped]);
  }

  // --- Loading -------------------------------------------------------------

  /**
   * @param {string | { type: string, url?: string }} source the delivery
   * @param {{ startTime?: number, duration?: number, isLive?: boolean,
   *   trimToStart?: boolean, mediaKbps?: number }} [options]
   */
  async load(source, { startTime = 0, duration = 0, isLive = false, trimToStart = false, mediaKbps = 0 } = {}) {
    this.setState("loading");
    this.isLive = Boolean(isLive);
    this.trimToStart = Boolean(trimToStart);
    this.mediaKbps = Number(mediaKbps) > 0 ? Number(mediaKbps) : 0;
    const type = typeof source === "string" ? (/\.m3u8(?:[?#]|$)/i.test(source) ? "hls" : "mp4") : source?.type;
    if (type === "split-mp4") {
      throw codedError("A <video> element plays one stream, and this delivery is two files", "MEDIA_UNSUPPORTED");
    }
    const url = typeof source === "string" ? source : source?.url;
    if (!url) throw new Error("Missing MP4/HLS source URL");
    this.url = new URL(url, this.baseUrl).href;
    this.mode = type === "hls" ? (this.hlsPath === "native" ? "native-hls" : "hls.js") : "progressive";
    // A stream from the node's LAN origin loads with CORS, which that origin
    // answers, so the picture stays readable (the transition frame).
    this.video.crossOrigin = new URL(this.url).origin !== new URL(this.baseUrl).origin ? "anonymous" : null;
    const start = Math.max(0, Number(startTime) || 0);
    this.pendingStart = start;

    const metadata = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(codedError(`The stream did not load in ${LOAD_TIMEOUT_MS / 1000} s (timeout)`, "MEDIA_NETWORK_ERROR")), LOAD_TIMEOUT_MS);
      this.loadWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
    });
    // Rejections are read by the await below, or not at all when attaching
    // already failed.
    metadata.catch(() => {});
    try {
      if (this.mode === "hls.js") {
        // A trimmed stream's playlist starts near `startTime`: begin with its
        // first segment, and seek once the media's timestamps are known.
        await this.attachHls(this.url, this.isLive ? -1 : this.trimToStart ? 0 : start);
      } else {
        this.video.src = this.url;
      }
    } catch (error) {
      this.loadWaiter?.reject(error);
      this.loadWaiter = null;
      throw error;
    }
    if (this.destroyed) return this;
    await metadata;
    this.loadWaiter = null;
    if (this.destroyed) return this;

    const streamDuration = finite(this.video.duration);
    if (this.mode === "hls.js") {
      const offset = this.initPts ?? 0;
      this.offset = Math.abs(offset) >= MIN_TIMELINE_OFFSET_SECONDS ? offset : 0;
    } else if (this.mode === "native-hls") {
      this.offset = streamTimelineOffset({ trimToStart: this.trimToStart, itemDuration: duration, streamDuration, startTime: start, isLive: this.isLive });
    }
    const hint = Number(duration);
    this.duration = this.isLive ? 0 : hint > 0 ? hint : this.offset + (streamDuration ?? 0);
    this.readPictureSize();
    // Subtitles given while loading move to the stream's timeline.
    this.buildCaptionTracks();

    if (!this.isLive) {
      const target = clamp(start - this.offset, 0, streamDuration ?? Infinity);
      if (Math.abs(this.video.currentTime - target) > 0.25) await this.seekVideo(target);
    }
    if (this.destroyed) return this;
    this.watchFirstFrame();
    this.loaded = true;
    this.noteBuffer(this.now());
    if (!this.suspended) this.startTimers();
    this.setState("paused");
    this.emitTime(true);
    return this;
  }

  startTimers() {
    clearInterval(this.watchTimer);
    clearInterval(this.timeTimer);
    this.watchTimer = setInterval(() => this.watch(), WATCH_INTERVAL_MS);
    // The element's own timeupdate comes about every 250 ms; the position
    // moves on in finer steps for subtitles and the progress bar. A timer,
    // not an animation frame: a frame callback would make the page draw at
    // the display's rate instead of the video's.
    this.timeTimer = setInterval(() => {
      if (!this.video.paused) this.emitTime();
    }, TIME_EVENT_INTERVAL_MS);
  }

  // A paused player kept behind the home screen (player.js) does no work:
  // its timers stop and hls.js fetches nothing more until wake(). What the
  // element has buffered stays; a file or native HLS the browser loads
  // itself stops at the browser's own read-ahead.
  suspend() {
    if (this.destroyed || this.suspended) return;
    this.suspended = true;
    clearInterval(this.watchTimer);
    clearInterval(this.timeTimer);
    this.watchTimer = null;
    this.timeTimer = null;
    this.hls?.pauseBuffering?.();
  }

  wake() {
    if (!this.suspended || this.destroyed) return;
    this.suspended = false;
    this.hls?.resumeBuffering?.();
    if (this.loaded) this.startTimers();
  }

  async attachHls(url, startPosition) {
    const { default: Hls } = await this.loadHls();
    if (this.destroyed) return;
    if (!Hls?.isSupported?.()) throw codedError("This browser has no Media Source Extensions for HLS", "MEDIA_UNSUPPORTED");
    const policy = ({ maxLoadTimeMs, errorRetries }) => ({
      default: {
        maxTimeToFirstByteMs: 10_000,
        maxLoadTimeMs,
        timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: errorRetries, retryDelayMs: 1_000, maxRetryDelayMs: 8_000, shouldRetry: retryHlsLoad },
      },
    });
    const hls = new Hls({
      startPosition,
      // Yolo's quality cap is the ceiling; within it hls.js adapts between
      // the variants of a multi-variant playlist (Agent Note 2026-10-12-two-playback-engines).
      backBufferLength: 90,
      // Subtitles are Yolo's, drawn over the picture (subtitles.js).
      enableWebVTT: false,
      enableIMSC1: false,
      enableCEA708Captions: false,
      renderTextTracksNatively: false,
      // The node may wait for a transcoder before it answers a playlist.
      manifestLoadPolicy: policy({ maxLoadTimeMs: 30_000, errorRetries: 2 }),
      playlistLoadPolicy: policy({ maxLoadTimeMs: 30_000, errorRetries: 2 }),
      fragLoadPolicy: policy({ maxLoadTimeMs: 120_000, errorRetries: 6 }),
    });
    this.hls = hls;
    const { Events } = Hls;
    hls.on(Events.INIT_PTS_FOUND, (_event, data) => {
      if (this.initPts != null || !Number(data?.timescale)) return;
      this.initPts = Number(data.initPTS) / Number(data.timescale);
    });
    hls.on(Events.BUFFER_CODECS, (_event, data) => {
      // Muxed media comes as one `audiovideo` track: "avc1…,mp4a…".
      const muxed = data?.audiovideo?.codec ? String(data.audiovideo.codec).split(",").map((codec) => codec.trim()) : null;
      const muxedAudio = muxed?.find((codec) => AUDIO_CODEC.test(codec)) || null;
      // A separate audio rendition reports its codecs after the video's.
      if (data?.audio || muxedAudio || (data?.audiovideo && !muxed)) this.hasAudio = true;
      else if (this.hasAudio == null) this.hasAudio = false;
      this.videoCodec ||= data?.video?.codec || muxed?.find((codec) => !AUDIO_CODEC.test(codec)) || null;
      this.audioCodec ||= data?.audio?.codec || muxedAudio;
    });
    hls.on(Events.FRAG_LOADING, () => {
      this.fragmentsLoading += 1;
    });
    hls.on(Events.FRAG_LOADED, () => {
      this.fragmentsLoading = Math.max(0, this.fragmentsLoading - 1);
      this.fragmentsLoaded += 1;
    });
    hls.on(Events.AUDIO_TRACKS_UPDATED, () => this.tracksChanged());
    hls.on(Events.AUDIO_TRACK_SWITCHED, () => this.tracksChanged());
    hls.on(Events.ERROR, (_event, data) => {
      if (!data?.fatal) {
        if (data?.details === "fragLoadError" || data?.details === "fragLoadTimeOut") this.fragmentsLoading = Math.max(0, this.fragmentsLoading - 1);
        // hls.js may keep asking again for a single-variant stream's
        // fragment, but a 410 (the session ended) or a 403 (upstream
        // refused) from the node never heals.
        const status = data?.response?.code;
        if (data?.type === "networkError" && (status === 410 || status === 403)) this.failure(hlsFailure(data));
        return;
      }
      // One decode hiccup is worth hls.js's own repair before a new stream.
      if (data.type === "mediaError" && this.mediaErrorRecoveries < 1) {
        this.mediaErrorRecoveries += 1;
        hls.recoverMediaError();
        return;
      }
      this.failure(hlsFailure(data));
    });
    hls.attachMedia(this.video);
    hls.loadSource(url);
  }

  handleMetadata() {
    this.readPictureSize();
    this.loadWaiter?.resolve();
  }

  readPictureSize() {
    const width = Number(this.video.videoWidth) || 0;
    const height = Number(this.video.videoHeight) || 0;
    if (width && height) {
      this.width = width;
      this.height = height;
      this.videoTrack = { width, height };
    }
  }

  // --- Playback ------------------------------------------------------------

  // "running": sound can play; "blocked": the browser would not start sound
  // without a gesture, so playback runs muted; "none": no audio track.
  get audioOutputState() {
    if (this.policyMuted) return "blocked";
    return this.hasAudio === false ? "none" : "running";
  }

  reportAudioOutput() {
    const output = this.audioOutputState;
    if (output === this.audioOutputReported) return;
    this.audioOutputReported = output;
    try {
      this.onAudioOutput(output, { hasVideo: Boolean(this.videoTrack) });
    } catch {
      // A UI callback never breaks playback.
    }
  }

  applyMuted() {
    this.mutedByEngine = this.volume === 0 || this.policyMuted;
    this.video.muted = this.mutedByEngine;
  }

  async play() {
    // An ended stream is over for Yolo too (it plays the queue's next item
    // or stops); the element would start it again from 0.
    if (this.destroyed || this.failed || this.state === "ended") return;
    this.wantsPlayback = true;
    this.applyMuted();
    try {
      await this.video.play();
    } catch (error) {
      if (this.destroyed || !this.wantsPlayback) return;
      if (error?.name === "AbortError") return;
      if (error?.name !== "NotAllowedError") {
        this.fail(error);
        return;
      }
      // The browser's autoplay policy: try muted, with "Tap for sound".
      if (!this.video.muted && this.videoTrack) {
        this.policyMuted = true;
        this.applyMuted();
        try {
          await this.video.play();
        } catch (mutedError) {
          if (this.destroyed || !this.wantsPlayback || mutedError?.name === "AbortError") return;
          this.waitForTap();
          return;
        }
      } else {
        // Muted audio shows nothing, and some browsers refuse even muted
        // playback (a phone's power saving): wait for a tap on play.
        this.policyMuted = !this.video.muted || this.policyMuted;
        this.waitForTap();
        return;
      }
    }
    this.reportAudioOutput();
    if (this.state === "loading" || this.state === "paused") {
      this.setState(this.video.readyState >= HAVE_FUTURE_DATA && !this.video.paused ? "playing" : "buffering");
    }
  }

  waitForTap() {
    this.wantsPlayback = false;
    this.reportAudioOutput();
    this.setState("paused", { reason: "audio-blocked" });
  }

  async pause() {
    this.wantsPlayback = false;
    this.pausedByStall = false;
    this.video.pause();
    this.setState("paused");
  }

  async resume() {
    return this.play();
  }

  async stop() {
    this.wantsPlayback = false;
    this.pausedByStall = false;
    this.video.pause();
    this.setState("stopped");
  }

  // Called from a user gesture (a tap anywhere): unmuting must happen while
  // the gesture is still active, before anything is awaited.
  async enableAudioOutput() {
    if (!this.policyMuted || this.destroyed) return this.audioOutputState;
    const activation = globalThis.navigator?.userActivation;
    if (activation && activation.isActive === false) return this.audioOutputState;
    this.policyMuted = false;
    this.applyMuted();
    if (this.wantsPlayback && this.video.paused) {
      try {
        await this.video.play();
      } catch (error) {
        if (error?.name === "NotAllowedError") {
          this.policyMuted = true;
          this.applyMuted();
        }
      }
    } else if (!this.wantsPlayback && this.state === "paused" && !this.videoTrack) {
      // Audio-only playback waited for this tap.
      void this.play();
    }
    this.reportAudioOutput();
    return this.audioOutputState;
  }

  async seek(milliseconds) {
    const seconds = Number(milliseconds) / 1000;
    const target = clamp(seconds, this.offset > 0 ? this.offset : 0, this.duration > 0 ? this.duration : Infinity);
    this.seekRequestCount += 1;
    this.lastSeekTarget = target;
    this.setState("seeking");
    const applied = await this.seekVideo(Math.max(0, target - this.offset));
    if (this.destroyed) return false;
    if (!applied) {
      this.seekSupersededCount += 1;
      return false;
    }
    this.lastProgressTime = null;
    this.waitingSince = 0;
    if (!this.wantsPlayback) this.setState("paused");
    else if (this.video.paused) void this.play();
    else this.setState(this.video.readyState >= HAVE_FUTURE_DATA ? "playing" : "buffering");
    return true;
  }

  // Resolves true once the element finished this seek, false when a later
  // seek replaced it.
  seekVideo(seconds) {
    this.pendingSeek?.(false);
    this.fillSamples = [];
    this.firstVideoRendered = false;
    return new Promise((resolve) => {
      let timer = null;
      const done = (applied) => {
        clearTimeout(timer);
        this.video.removeEventListener("seeked", onSeeked);
        if (this.pendingSeek === done) this.pendingSeek = null;
        if (applied) this.watchFirstFrame();
        resolve(applied);
      };
      const onSeeked = () => done(true);
      this.pendingSeek = done;
      timer = setTimeout(() => done(true), SEEK_TIMEOUT_MS);
      this.video.addEventListener("seeked", onSeeked);
      this.video.currentTime = seconds;
    });
  }

  // --- The element's own events --------------------------------------------

  handlePlay() {
    this.pausedByStall = false;
    // Play pressed outside Yolo's controls (Picture-in-Picture, the
    // system's media controls): the owner's intent now.
    if (!this.wantsPlayback && this.loaded) {
      this.wantsPlayback = true;
      this.externalPlay = true;
    }
  }

  handlePlaying() {
    if (!this.wantsPlayback || this.state === "seeking") return;
    const external = this.externalPlay;
    this.externalPlay = false;
    this.waitingSince = 0;
    this.lastProgressAt = this.now();
    this.setState("playing", external ? { reason: "external" } : {});
  }

  handleCanPlay() {
    if (this.resumeAfterStall()) return;
    if (this.wantsPlayback && this.state === "buffering" && !this.video.paused && this.video.readyState >= HAVE_FUTURE_DATA) {
      this.setState("playing");
    }
  }

  handleWaiting() {
    if (!this.wantsPlayback || this.state === "seeking" || this.state === "loading") return;
    if (!this.waitingSince) {
      this.waitingSince = this.now();
      this.waitingTime = this.video.currentTime;
    }
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => this.confirmStall(), STALL_CONFIRM_MS);
  }

  // A `waiting` the time has not moved on from: a stall.
  confirmStall(now = this.now()) {
    if (!this.waitingSince || !this.wantsPlayback || this.video.paused || this.state !== "playing") return;
    if (this.video.currentTime !== this.waitingTime) {
      this.waitingSince = 0;
      return;
    }
    if (now - this.waitingSince >= STALL_CONFIRM_MS) this.enterBuffering("waiting");
  }

  // The time moved while the element plays: whatever the events said, the
  // picture is not stuck.
  noteProgress(now = this.now()) {
    const time = this.video.currentTime;
    if (this.video.paused || this.video.seeking || this.state === "seeking") {
      this.lastProgressTime = null;
      return;
    }
    if (this.lastProgressTime == null) {
      this.lastProgressTime = time;
      this.lastProgressAt = now;
      return;
    }
    if (time === this.lastProgressTime) return;
    this.lastProgressTime = time;
    this.lastProgressAt = now;
    this.waitingSince = 0;
    if (this.wantsPlayback && this.state === "buffering") this.setState("playing");
  }

  handlePause() {
    // Paused outside Yolo's controls (Picture-in-Picture, the system, a
    // phone call): the owner's intent now. The end of the stream pauses too.
    if (!this.wantsPlayback || this.video.ended || !this.loaded) return;
    if (this.starved()) {
      // Paused by the browser itself because the data ran out (WebKit's
      // native HLS can): a stall, with the spinner, and it plays on.
      this.pausedByStall = true;
      this.enterBuffering("paused-by-browser");
      return;
    }
    this.wantsPlayback = false;
    this.setState("paused", { reason: "external" });
  }

  // Nothing ahead to play at the current time, or a stall already seen.
  starved() {
    return this.video.readyState < HAVE_FUTURE_DATA || this.state === "buffering" || Boolean(this.waitingSince);
  }

  // Data is back after the browser paused for a stall: play on, as the
  // owner asked. True when it did.
  resumeAfterStall() {
    if (!this.pausedByStall || !this.wantsPlayback || this.video.readyState < HAVE_FUTURE_DATA) return false;
    this.pausedByStall = false;
    if (this.video.paused) void this.play();
    return true;
  }

  handleEnded() {
    if (this.isLive) return;
    this.wantsPlayback = false;
    this.setState("ended", { reason: "ended" });
    this.onEnded();
  }

  async handleMediaError() {
    if (this.failed || this.destroyed) return;
    // hls.js reports its own failures, with the status it saw.
    if (this.mode === "hls.js" && this.hls) return;
    const mediaError = this.video.error;
    const status = await this.probeStatus();
    this.failure(mediaElementFailure(mediaError, status));
  }

  enterBuffering(reason) {
    if (this.state === "buffering") return;
    this.setState("buffering", { reason });
  }

  // --- Time, frames, and stalls ----------------------------------------------

  emitTime(force = false) {
    if (!this.loaded || this.destroyed) return;
    const now = this.now();
    if (!force && now - this.lastTimeEventAt < TIME_EVENT_INTERVAL_MS) return;
    this.lastTimeEventAt = now;
    this.onTime(this.getCurrentTime());
  }

  watchFirstFrame() {
    if (this.firstVideoRendered) return;
    if (typeof this.video.requestVideoFrameCallback === "function") {
      this.video.requestVideoFrameCallback(() => this.firstFrame());
    }
    this.armFirstFrameFallback();
  }

  // Without requestVideoFrameCallback (or when it never fires for a paused
  // element), a decoded first frame counts a moment after it is there.
  armFirstFrameFallback() {
    clearTimeout(this.firstFrameTimer);
    this.firstFrameTimer = setTimeout(() => {
      if (this.video.readyState >= HAVE_CURRENT_DATA) this.firstFrame();
    }, typeof this.video.requestVideoFrameCallback === "function" ? FIRST_FRAME_FALLBACK_MS : 0);
  }

  firstFrame() {
    if (this.firstVideoRendered || this.destroyed || !this.videoTrack) return;
    this.firstVideoRendered = true;
    clearTimeout(this.firstFrameTimer);
    this.onFirstVideo();
  }

  bufferedEnd() {
    const ranges = this.video.buffered;
    const time = this.video.currentTime;
    if (!ranges?.length) return time;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time + 0.5 && ranges.end(index) >= time) return ranges.end(index);
    }
    return time;
  }

  bufferedAhead() {
    return Math.max(0, this.bufferedEnd() - this.video.currentTime);
  }

  noteBuffer(now) {
    const end = this.bufferedEnd();
    if (end > this.lastBufferedEnd + 0.01) this.lastBufferGrowthAt = now;
    this.lastBufferedEnd = end;
    // Only while the browser is still fetching does the growth measure the
    // connection; a full buffer stops it on purpose.
    if (this.bufferedAhead() < FILLING_BELOW_SECONDS || this.state === "buffering") {
      this.fillSamples.push({ at: now, end });
      if (this.fillSamples.length > 16) this.fillSamples.shift();
    } else {
      this.fillSamples = [];
    }
  }

  watch() {
    if (this.destroyed || !this.loaded || this.failed) return;
    const now = this.now();
    this.noteBuffer(now);
    if (!this.wantsPlayback || this.state === "ended" || this.state === "paused" || this.state === "stopped") {
      this.bufferingSince = 0;
      this.probedThisWait = false;
      this.lastProgressTime = null;
      return;
    }
    this.resumeAfterStall();
    this.noteProgress(now);
    if (this.state === "playing") {
      this.confirmStall(now);
      if (this.state === "playing" && this.lastProgressTime != null && now - this.lastProgressAt >= FROZEN_AFTER_MS) this.enterBuffering("frozen");
    }
    if (this.state !== "buffering" && this.state !== "seeking") {
      this.bufferingSince = 0;
      this.probedThisWait = false;
      return;
    }
    this.bufferingSince ||= now;
    const waited = now - this.bufferingSince;
    if (waited >= PROBE_AFTER_MS && !this.probedThisWait) {
      this.probedThisWait = true;
      void this.probeStatus().then((status) => {
        if (status === 410 || status === 403) this.failure(mediaElementFailure(null, status));
      });
    }
    if (now - Math.max(this.bufferingSince, this.lastBufferGrowthAt) >= STALLED_AFTER_MS) {
      this.failure(codedError(`The video stalled: no new data for ${STALLED_AFTER_MS / 1000} s`, "MEDIA_STALLED"));
    }
  }

  // What the node answers for this stream now: a 410 means the session
  // ended, which the element itself never says. For HLS the browser plays
  // itself, the master playlist may come from what the node holds, so its
  // first variant playlist, which the node asks the source for, answers too.
  async probeStatus() {
    if (!this.url) return null;
    const status = await this.requestStatus(this.url, "HEAD");
    if (status !== 200 || this.mode !== "native-hls") return status;
    const variant = await this.firstVariantUrl();
    return variant ? (await this.requestStatus(variant, "HEAD")) ?? status : status;
  }

  async requestStatus(url, method) {
    try {
      const response = await this.fetchFn(url, { method, cache: "no-store", signal: probeSignal() });
      return response.status;
    } catch {
      return null;
    }
  }

  async firstVariantUrl() {
    try {
      const response = await this.fetchFn(this.url, { cache: "no-store", signal: probeSignal() });
      if (response.status !== 200) return null;
      const uri = firstVariantUri(await response.text());
      return uri ? new URL(uri, this.url).href : null;
    } catch {
      return null;
    }
  }

  failure(error) {
    if (this.loadWaiter) {
      this.loadWaiter.reject(error);
      this.loadWaiter = null;
      return;
    }
    this.fail(error);
  }

  fail(error) {
    if (this.failed || this.destroyed) return;
    this.failed = true;
    this.wantsPlayback = false;
    this.pausedByStall = false;
    try {
      this.video.pause();
    } catch {
      // Already gone.
    }
    this.setState("error");
    this.onError(error instanceof Error ? error : new Error(String(error)));
  }

  setState(state, detail = {}) {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    if (state === "buffering") this.bufferingSince = this.now();
    this.onStateChange(state, { previous, ...detail });
  }

  // --- Sound -----------------------------------------------------------------

  setVolume(volume) {
    this.volume = clamp(Number(volume) || 0, 0, 1);
    try {
      this.video.volume = this.volume || 1;
    } catch {
      // iOS keeps the volume to the hardware buttons.
    }
    this.applyMuted();
  }

  // The canvas engine boosts its own audio graph; a <video> element plays
  // at the system's volume.
  setAudioGain() {}

  // The owner's speed, or twice it while a press is held (player.js), to
  // 5× (playback-speed.js). The default rate too: loading a source resets
  // the element to it.
  setPlaybackRate(rate) {
    this.rateByEngine = clamp(Number(rate) || 1, MIN_SPEED, MAX_SPEED.native);
    this.video.defaultPlaybackRate = this.rateByEngine;
    this.video.playbackRate = this.rateByEngine;
  }

  // Another speed chosen outside Yolo's controls (the system's fullscreen
  // player on iPhone): the owner's choice now.
  handleRateChange() {
    if (this.destroyed) return;
    const rate = Number(this.video.playbackRate);
    if (!(rate > 0) || rate === this.rateByEngine) return;
    this.rateByEngine = rate;
    this.video.defaultPlaybackRate = rate;
    try {
      this.onRate(rate);
    } catch {
      // A UI callback never breaks playback.
    }
  }

  // The sound turned off or on outside Yolo's controls (the system's
  // fullscreen player): the owner's choice now.
  handleVolumeChange() {
    if (this.destroyed) return;
    const muted = Boolean(this.video.muted);
    if (muted === this.mutedByEngine) return;
    this.mutedByEngine = muted;
    if (muted) {
      this.volume = 0;
    } else {
      this.policyMuted = false;
      if (this.volume === 0) this.volume = 1;
    }
    this.reportAudioOutput();
    try {
      this.onVolume(this.volume);
    } catch {
      // A UI callback never breaks playback.
    }
  }

  // --- The system's fullscreen player (iPhone) ---------------------------------

  handleNativeFullscreen(active) {
    if (this.nativeFullscreen === active) return;
    this.nativeFullscreen = active;
    if (active) this.buildCaptionTracks();
    this.applyCaptionModes();
    if (!active) this.followSystemPlayer();
    try {
      this.onPresentation({ fullscreen: active });
    } catch {
      // A UI callback never breaks playback.
    }
  }

  // Back from the system's player, which may have paused, played, seeked,
  // or turned the sound off or on: what the element does now is the owner's
  // intent, whether or not each of its events reached the page.
  followSystemPlayer() {
    if (!this.loaded || this.failed || this.state === "ended") return;
    const playing = !this.video.paused && !this.video.ended;
    if (playing && !this.wantsPlayback) {
      this.wantsPlayback = true;
      this.setState("playing", { reason: "external" });
    } else if (!playing && this.wantsPlayback && !this.video.ended && !this.pausedByStall) {
      this.wantsPlayback = false;
      this.setState("paused", { reason: "external" });
    }
    this.handleVolumeChange();
    this.handleRateChange();
    this.lastProgressTime = null;
    this.emitTime(true);
  }

  /**
   * Yolo's subtitles shown now, in its order: { id, label, language, cues },
   * with cues in the item's seconds ([{ start, end, text }]), or null cues
   * when Yolo has none for that track. Each with cues becomes a text track of
   * the element, hidden while Yolo draws its own; the system's fullscreen
   * player shows the first (applyCaptionModes).
   */
  setCaptions(captions = []) {
    if (this.destroyed) return;
    this.captions = Array.isArray(captions) ? captions.filter((caption) => caption?.id != null) : [];
    this.buildCaptionTracks();
    this.applyCaptionModes();
  }

  // The cues on the element's timeline, which for a stream that begins part
  // way into the item starts at the engine's offset.
  buildCaptionTracks() {
    if (typeof this.video.addTextTrack !== "function") return;
    for (const caption of this.captions) {
      if (!caption.cues?.length) continue;
      let entry = this.captionTracks.get(caption.id);
      if (entry?.cues === caption.cues && entry.offset === this.offset) continue;
      try {
        if (!entry) {
          // A track the page adds starts hidden and stays for the element's
          // life: it can be disabled, never removed. A closed engine's track
          // with the same label and language serves again.
          const label = caption.label || caption.language || "Subtitles";
          const language = caption.language || "";
          const spent = spentCaptionTracks.get(this.video) || [];
          const index = spent.findIndex((track) => track.label === label && track.language === language);
          const track = index === -1 ? this.video.addTextTrack("subtitles", label, language) : spent.splice(index, 1)[0];
          entry = { track };
          this.captionTracks.set(caption.id, entry);
        }
        const { track } = entry;
        // A disabled track has no cue list to clear.
        if (track.mode === "disabled") track.mode = "hidden";
        for (const cue of Array.from(track.cues || [])) track.removeCue(cue);
        for (const cue of caption.cues) {
          const end = cue.end - this.offset;
          if (end > 0) track.addCue(this.createCue(Math.max(0, cue.start - this.offset), end, cue.text));
        }
        entry.cues = caption.cues;
        entry.offset = this.offset;
      } catch (error) {
        console.warn("[native] Subtitles for the system's player:", error?.message || error);
      }
    }
  }

  // Inline, Yolo draws the subtitles: its own tracks stay hidden and every
  // other track off. In the system's fullscreen player, the track for Yolo's
  // first subtitle shows (fullscreenCaptionTrack).
  applyCaptionModes() {
    const tracks = Array.from(this.video.textTracks || []);
    if (!tracks.length) return;
    const own = new Set(Array.from(this.captionTracks.values(), (entry) => entry.track));
    const spent = new Set(spentCaptionTracks.get(this.video) || []);
    const ownTrack = (caption) => (caption.cues?.length ? this.captionTracks.get(caption.id)?.track ?? null : null);
    const selected = new Set(this.captions.map(ownTrack).filter(Boolean));
    const shown = this.nativeFullscreen
      ? fullscreenCaptionTrack(this.captions, tracks.filter((track) => !own.has(track) && !spent.has(track)), ownTrack)
      : null;
    for (const track of tracks) {
      let mode;
      if (track === shown) mode = "showing";
      else if (spent.has(track)) mode = "disabled";
      else if (own.has(track)) mode = selected.has(track) ? "hidden" : "disabled";
      else mode = track.mode === "showing" ? "disabled" : track.mode;
      if (track.mode !== mode) track.mode = mode;
    }
  }

  // --- Audio renditions of the stream itself ---------------------------------

  // Audio tracks inside the stream (an HLS playlist's renditions), which the
  // engine switches without a new stream. Sources that list their own audio
  // tracks switch through Yolo instead.
  audioRenditions() {
    if (this.hls) {
      return (this.hls.audioTracks || []).map((track, index) => ({
        id: String(index), name: track.name || track.lang || `Track ${index + 1}`, language: track.lang || "", active: index === this.hls.audioTrack,
      }));
    }
    const tracks = this.video.audioTracks;
    if (!tracks?.length) return [];
    return Array.from({ length: tracks.length }, (_, index) => tracks[index]).map((track, index) => ({
      id: String(index), name: track.label || track.language || `Track ${index + 1}`, language: track.language || "", active: Boolean(track.enabled),
    }));
  }

  selectAudioRendition(id) {
    const index = Number(id);
    if (!Number.isInteger(index) || index < 0) return false;
    if (this.hls) {
      if (index >= (this.hls.audioTracks?.length || 0)) return false;
      this.hls.audioTrack = index;
      return true;
    }
    const tracks = this.video.audioTracks;
    if (!tracks || index >= tracks.length) return false;
    for (let other = 0; other < tracks.length; other += 1) tracks[other].enabled = other === index;
    this.tracksChanged();
    return true;
  }

  tracksChanged() {
    try {
      this.onTracks();
    } catch {
      // A UI callback never breaks playback.
    }
  }

  // --- What player.js reads ----------------------------------------------------

  // A live stream's position moves inside the window the element can seek.
  get seeksLiveInPlace() {
    return true;
  }

  injectVideoStall() {}

  resize() {}

  getStatus() {
    return this.state;
  }

  getCurrentTime() {
    // While loading: where it is about to start.
    if (!this.loaded) return this.pendingStart ?? 0;
    return Math.max(0, this.offset + (Number(this.video.currentTime) || 0));
  }

  getDuration() {
    return BigInt(Math.round((this.duration || 0) * 1000));
  }

  getSeekableRange() {
    return { start: this.offset > 0 ? this.offset : 0, end: this.duration > 0 ? this.duration : null };
  }

  getLiveTimeline() {
    if (!this.isLive) return null;
    const seekable = this.video.seekable;
    if (!seekable?.length) return null;
    return { startTime: seekable.start(0) + this.offset, edgeTime: seekable.end(seekable.length - 1) + this.offset, playStartTime: null };
  }

  // Throughput for adaptive quality: hls.js's own estimate once fragments
  // arrived, else how fast the buffer grows while the browser fetches.
  throughput(now = this.now()) {
    if (this.hls && this.fragmentsLoaded > 0 && Number(this.hls.bandwidthEstimate) > 0) {
      return { bitsPerSecond: Number(this.hls.bandwidthEstimate), samples: this.fragmentsLoaded };
    }
    const rate = bufferFillRate(this.fillSamples, now);
    if (rate == null || !this.mediaKbps) return { bitsPerSecond: null, samples: 0 };
    return { bitsPerSecond: rate * this.mediaKbps * 1000, samples: this.fillSamples.filter((sample) => now - sample.at <= FILL_WINDOW_MS).length };
  }

  getStats() {
    const now = this.now();
    const quality = this.video.getVideoPlaybackQuality?.() || null;
    const decoded = Number(quality?.totalVideoFrames) || 0;
    const dropped = Number(quality?.droppedVideoFrames) || 0;
    const timeMs = Math.round(this.getCurrentTime() * 1000);
    const ahead = this.loaded ? this.bufferedAhead() : 0;
    const { bitsPerSecond, samples } = this.throughput(now);
    const levels = this.hls?.levels?.length || 0;
    const level = this.hls && this.hls.currentLevel >= 0 ? this.hls.levels?.[this.hls.currentLevel] : null;
    const timeline = this.getLiveTimeline();
    // The browser is fetching: a fragment in flight, or the buffer grew lately.
    const fetching = this.fragmentsLoading > 0 || (this.lastBufferGrowthAt && now - this.lastBufferGrowthAt < 2_000);
    return {
      engine: "native",
      mode: this.mode,
      videoFrameDecodeCount: decoded,
      videoFrameDropCount: dropped,
      videoFrameRenderCount: Math.max(0, decoded - dropped),
      videoCurrentTime: timeMs,
      audioCurrentTime: timeMs,
      audibleAudioCurrentTime: timeMs,
      seekRequestCount: this.seekRequestCount,
      seekSupersededCount: this.seekSupersededCount,
      lastSeekTarget: this.lastSeekTarget,
      // The browser does not say the codec of a stream it plays itself.
      videocodec: this.videoCodec || (this.videoTrack ? "unknown" : null),
      audiocodec: this.audioCodec,
      width: this.width,
      height: this.height,
      bandwidth: bitsPerSecond,
      hlsThroughputSampleCount: samples,
      hlsBufferedAheadSeconds: Math.round(ahead * 10) / 10,
      hlsActiveDownloads: fetching ? 1 : 0,
      videoBufferedMs: Math.round(ahead * 1000),
      audioBufferedMs: Math.round(ahead * 1000),
      durationDistanceMs: this.duration > 0 ? Math.round((this.duration - this.getCurrentTime()) * 1000) : null,
      // hls.js switches between the variants of the stream itself.
      adaptsWithinStream: levels > 1,
      hlsLevels: levels || null,
      hlsLevelKbps: level?.bitrate ? Math.round(level.bitrate / 1000) : null,
      timelineOffset: this.offset,
      liveDvrStartTime: timeline?.startTime ?? null,
      liveEdgeTime: timeline?.edgeTime ?? null,
      livePlayStartTime: null,
      liveLatencyMs: timeline ? Math.max(0, Math.round((timeline.edgeTime - this.getCurrentTime()) * 1000)) : null,
    };
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.stallTimer);
    this.wantsPlayback = false;
    this.loadWaiter?.reject(codedError("The player was closed", "ABORTED"));
    this.loadWaiter = null;
    this.pendingSeek?.(false);
    clearInterval(this.watchTimer);
    clearInterval(this.timeTimer);
    clearTimeout(this.firstFrameTimer);
    for (const [type, handler] of this.listeners) this.video.removeEventListener(type, handler);
    this.listeners = [];
    this.video.textTracks?.removeEventListener?.("addtrack", this.hideTextTracks);
    this.video.textTracks?.removeEventListener?.("change", this.hideTextTracks);
    try {
      this.hls?.destroy();
    } catch {
      // Already torn down.
    }
    this.hls = null;
    try {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load?.();
    } catch {
      // Already gone.
    }
    // Yolo's subtitle tracks go off, empty, for the next engine.
    const spent = spentCaptionTracks.get(this.video) || [];
    for (const { track } of this.captionTracks.values()) {
      try {
        if (track.mode === "disabled") track.mode = "hidden";
        for (const cue of Array.from(track.cues || [])) track.removeCue(cue);
        track.mode = "disabled";
      } catch {
        // A track the browser dropped.
      }
      spent.push(track);
    }
    spentCaptionTracks.set(this.video, spent);
    this.captionTracks.clear();
    this.video.remove();
    spareVideo = this.video;
  }
}
