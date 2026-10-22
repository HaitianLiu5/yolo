import {
  AudioBufferSink,
  CanvasSink,
  EncodedPacketSink,
  HLS_FORMATS,
  Input,
  UrlSource,
  WEBM,
} from "mediabunny";
import { AudioRingBuffer } from "./audio-ring-buffer.js";
import { placeAudioBuffer, silentAudioBuffer } from "./audio-timeline.js";
import { DecoderProbe, firstStackFrame, injectDecodeErrors } from "./decoder-probe.js";
import { DecoderRecovery, isDecoderError, NEW_STREAM_STEP, RECOVERY_STEPS, VIDEO_HOLD_MS } from "./decoder-recovery.js";
import { HlsSegmentPrefetcher } from "./hls-segment-prefetcher.js";
import { getPlaybackEndReason } from "./playback-end.js";
import { hasHlsStartupBuffer, START_BUFFER_SECONDS, stallRunwaySeconds } from "./playback-buffer-policy.js";
import { estimateAudioOutputLatencySeconds, PresentationClock } from "./presentation-clock.js";
import { LatestOperation } from "../latest-operation.js";
import { MAX_SPEED, MIN_SPEED } from "../playback-speed.js";

const AUDIO_CAPACITY_SECONDS = 3;
const AUDIO_START_SECONDS = 0.75;
const AUDIO_REBUFFER_SECONDS = 0.15;
// Network resilience belongs in the encoded segment buffer. Keep only a short
// decoded-frame queue here to absorb decoder and render scheduling jitter.
const VIDEO_QUEUE_MIN_CAPACITY = 6;
const VIDEO_QUEUE_MAX_CAPACITY = 16;
const VIDEO_QUEUE_TARGET_SECONDS = 0.2;
const VIDEO_START_SECONDS = 0.1;
const VIDEO_REBUFFER_SECONDS = 0.08;
// Playback speeds this engine plays (setPlaybackRate): to 3×, since it
// decodes that many times the frames (playback-speed.js). The decoded
// margins above are wall time against scheduling jitter: faster, they hold
// that much more media, within the same queue bound.
const MIN_PLAYBACK_RATE = MIN_SPEED;
const MAX_PLAYBACK_RATE = MAX_SPEED.canvas;
const TIME_EVENT_INTERVAL_MS = 250;
// In-car connections often disappear for tens of seconds at a time. Keep the
// encoded HLS buffer large while the 720p60/1080p30 profile stays predictable;
// playback starts long before it is full (playback-buffer-policy.js).
const HLS_BUFFER_TARGET_SECONDS = 210;
const HLS_START_MAX_SECONDS = 15;
const HLS_BUFFER_MAX_SEGMENTS = 90;
const HLS_BUFFER_MAX_BYTES = 128 * 1024 * 1024;
const HLS_PREFETCH_CONCURRENCY = 1;
// Large enough to keep a 1080p video queue fed across Cloudflare, while still
// preventing UrlSource's open-ended ranges from extending to multi-GB EOFs.
const NETWORK_RANGE_CHUNK_BYTES = 2 * 1024 * 1024;
const ITERATOR_CLOSE_TIMEOUT_MS = 1_500;
// AudioContext.resume() never settles while the browser's autoplay policy
// blocks sound (no user gesture yet, low media engagement). This long, then
// play muted on the wall clock.
const AUDIO_RESUME_TIMEOUT_MS = 400;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function boundedRangeFetch(input, init = {}) {
  const headers = new Headers(init.headers);
  const range = headers.get("Range");
  const openRange = range?.match(/^bytes=(\d+)-$/i);
  if (openRange) {
    const start = Number(openRange[1]);
    if (Number.isSafeInteger(start)) {
      headers.set("Range", `bytes=${start}-${start + NETWORK_RANGE_CHUNK_BYTES - 1}`);
    }
  }
  return globalThis.fetch(input, { ...init, headers });
}

// Mediabunny's default retries every failed fetch forever. These errors come
// from the HLS prefetcher, which already retried or got a definite answer: a
// 403, a 410, or a segment whose bounded tries ran out. They end the stream at
// once. Anything else (a network error, a download a seek cancelled) gets
// three more tries. Then player.js recovers: a fresh stream at the same
// position, through the tunnel after a LAN failure
// (Agent Note 2026-04-04-canvas-playback-engine).
const TERMINAL_FETCH_ERRORS = new Set(["UPSTREAM_ACCESS_DENIED", "SESSION_EXPIRED", "HLS_SEGMENT_FETCH_FAILED"]);
const FETCH_RETRY_DELAYS_SECONDS = [0.5, 1, 2];

function fetchRetryDelay(previousAttempts, error) {
  if (TERMINAL_FETCH_ERRORS.has(error?.code)) return null;
  return FETCH_RETRY_DELAYS_SECONDS[previousAttempts - 1] ?? null;
}

// A recovery step's own wait (decoder-recovery.js) ran out.
const STEP_TIMEOUT = Symbol("decoder recovery step timeout");

function withDeadline(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(STEP_TIMEOUT), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const round3 = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);

async function closeIterator(iterator) {
  if (typeof iterator?.return !== "function") return true;
  let timeout = null;
  const closed = Promise.resolve()
    .then(() => iterator.return())
    .then(() => true, () => false);
  const timedOut = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), ITERATOR_CLOSE_TIMEOUT_MS);
  });
  const result = await Promise.race([closed, timedOut]);
  clearTimeout(timeout);
  return result;
}

export class MediabunnyPlayer {
  constructor({
    container,
    onStateChange = () => {},
    onTime = () => {},
    onFirstVideo = () => {},
    onEnded = () => {},
    onError = () => {},
    onAudioOutput = () => {},
    onDecoderRecovery = () => {},
    faultInjection = null,
    decodeFault = null,
    hlsStartSeconds = START_BUFFER_SECONDS,
  }) {
    this.container = container;
    this.onStateChange = onStateChange;
    this.onTime = onTime;
    this.onFirstVideo = onFirstVideo;
    this.onEnded = onEnded;
    this.onError = onError;
    this.onAudioOutput = onAudioOutput;
    this.onDecoderRecovery = onDecoderRecovery;
    this.faultInjection = faultInjection;
    // The page's decodeErrorAt fault, or one injectDecodeError() set:
    // { atSeconds, remaining, track } (decoder-probe.js).
    this.decodeFault = decodeFault;
    this.hlsStartSeconds = clamp(Number(hlsStartSeconds) || START_BUFFER_SECONDS, 1, HLS_START_MAX_SECONDS);
    // Set by a stall from playing: the runway it waits for, until it plays.
    this.stallRunwaySeconds = null;

    this.inputs = [];
    // Each track's Mediabunny input, and how to open it again for a
    // recovery step that reads its segment anew (decoder-recovery.js).
    this.trackInputs = { video: null, audio: null };
    this.trackSources = { video: null, audio: null };
    this.videoTrack = null;
    this.audioTrack = null;
    this.videoSink = null;
    this.audioSink = null;
    this.videoIterator = null;
    this.audioIterator = null;
    // Bumped when one track's decoder restarts on its own: that track's
    // older producer stops, the other plays on.
    this.trackRuns = { video: 0, audio: 0 };
    this.producerRestarts = new LatestOperation();
    this.audioContext = null;
    this.audioRing = null;
    this.audioNode = null;
    this.gainNode = null;
    this.compressorNode = null;
    // True while the browser does not let this page make sound: the picture
    // then runs on the wall clock, muted, until enableAudioOutput().
    this.audioBlocked = false;
    this.audioOutputReported = null;
    this.clock = new PresentationClock();
    this.playbackRate = 1;

    this.canvas = document.createElement("canvas");
    this.canvas.dataset.engine = "mediabunny";
    this.context = this.canvas.getContext("2d", { alpha: false });
    this.container.appendChild(this.canvas);

    this.state = "idle";
    this.wantsPlayback = false;
    this.duration = 0;
    this.isLive = false;
    this.firstTimestamp = 0;
    this.videoQueue = [];
    this.videoQueueCapacity = VIDEO_QUEUE_MIN_CAPACITY;
    this.videoEnded = false;
    this.audioEnded = false;
    this.generation = 0;
    this.destroyed = false;
    this.volume = 1;
    this.audioGain = 1;
    this.lastRenderedTimestamp = 0;
    this.firstVideoRendered = false;
    this.lastTimeEventAt = 0;
    this.videoDecodeCount = 0;
    this.videoRenderCount = 0;
    this.videoDropCount = 0;
    this.videoStutterCount = 0;
    this.audioBufferCount = 0;
    this.audioDiscontinuityCount = 0;
    this.seekRequestCount = 0;
    this.seekSupersededCount = 0;
    this.iteratorCloseTimeoutCount = 0;
    this.lastSeekTarget = null;
    this.hlsSegmentPrefetcher = null;
    this.videoCodec = null;
    this.audioCodec = null;
    this.width = 0;
    this.height = 0;
    this.videoFaultUntil = 0;
    this.scheduledFaultTriggered = false;
    // Each track's decoder, for the telemetry of a failure (decoder-probe.js),
    // and the failure itself once fail() ran.
    this.decoderProbes = { video: new DecoderProbe(), audio: new DecoderProbe() };
    this.failureDetail = null;
    this.failedWith = null;
    // The ladder a failed decoder climbs (decoder-recovery.js): each
    // track's step deadline, and until when a recovering picture holds
    // while the sound plays on.
    this.decoderRecovery = new DecoderRecovery();
    this.recoveryTimers = { video: null, audio: null };
    this.videoHoldUntil = 0;
    // Where the audio written to the ring ends, in media time: a restarted
    // audio decoder goes on from there.
    this.audioOutputEnd = 0;
    // While a hidden player is kept (suspend()): what its producers wait on
    // until wake() or destroy().
    this.suspension = null;

    this.renderFrame = this.renderFrame.bind(this);
    this.animationFrame = requestAnimationFrame(this.renderFrame);
  }

  async load(source, { startTime = 0, duration = 0, isLive = false } = {}) {
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
      throw new Error("Mediabunny engine requires COOP/COEP and SharedArrayBuffer");
    }
    this.setState("loading");
    this.isLive = Boolean(isLive);
    // While it loads, the engine is where the stream is about to start, as
    // the <video> engine is: a report, a recovery, or a quality change asked
    // for meanwhile goes on from there, not from 0 (Agent Note
    // 2026-04-04-canvas-playback-engine).
    this.clock.reset(Math.max(0, Number(startTime) || 0));
    if (source?.type === "split-mp4") {
      this.trackSources = {
        video: { url: source.videoUrl, boundedRanges: true },
        audio: { url: source.audioUrl, boundedRanges: true },
      };
      const videoInput = this.createInput(source.videoUrl, { boundedRanges: true });
      const audioInput = this.createInput(source.audioUrl, { boundedRanges: true });
      this.inputs.push(videoInput, audioInput);
      if (!await videoInput.canRead() || !await audioInput.canRead()) {
        throw new Error("Mediabunny could not recognize the split MP4 sources");
      }
      this.videoTrack = await videoInput.getPrimaryVideoTrack();
      this.audioTrack = await audioInput.getPrimaryAudioTrack();
      this.trackInputs = { video: videoInput, audio: audioInput };
    } else {
      const url = typeof source === "string" ? source : source?.url;
      if (!url) throw new Error("Missing MP4/HLS source URL");
      const isHls = source?.type === "hls" || /\.m3u8(?:[?#]|$)/i.test(url);
      const options = { url, boundedRanges: !isHls, prefetchHls: isHls };
      this.trackSources = { video: options, audio: options };
      const input = this.createInput(url, options);
      this.inputs.push(input);
      if (!await input.canRead()) {
        throw new Error("Mediabunny could not recognize this MP4/HLS source");
      }
      this.videoTrack = await input.getPrimaryVideoTrack();
      this.audioTrack = await input.getPrimaryAudioTrack();
      this.trackInputs = { video: input, audio: input };
    }
    if (!this.videoTrack && !this.audioTrack) {
      throw new Error("Source has no playable audio or video track");
    }
    if (this.videoTrack && typeof VideoDecoder !== "function") {
      throw new Error("Mediabunny engine requires WebCodecs VideoDecoder");
    }
    if (this.videoTrack && !await this.videoTrack.canDecode()) {
      throw new Error(`Browser cannot decode video codec: ${await this.videoTrack.getCodec()}`);
    }
    if (this.audioTrack && !await this.audioTrack.canDecode()) {
      throw new Error(`Browser cannot decode audio codec: ${await this.audioTrack.getCodec()}`);
    }

    const tracks = [this.videoTrack, this.audioTrack].filter(Boolean);
    const firstTimestamps = await Promise.all(tracks.map((track) => track.getFirstTimestamp()));
    this.firstTimestamp = Math.min(...firstTimestamps);
    const durationHint = Number(duration);
    if (Number.isFinite(durationHint) && durationHint > 0) {
      // yt-dlp/Plex already know the presentation duration. Fragmented MP4
      // tracks often omit it from their metadata; computeDuration() then has
      // to scan every moof in a multi-gigabyte file before decoding can start.
      this.duration = durationHint;
    } else {
      const durations = await Promise.all(tracks.map(async (track) => (
        await track.getDurationFromMetadata({ skipLiveWait: isLive })
        ?? await track.computeDuration({ skipLiveWait: isLive })
      )));
      this.duration = Math.max(...durations);
    }
    this.videoCodec = this.videoTrack ? await this.videoTrack.getCodec() : null;
    this.audioCodec = this.audioTrack ? await this.audioTrack.getCodec() : null;

    if (this.videoTrack) {
      this.width = await this.videoTrack.getDisplayWidth();
      this.height = await this.videoTrack.getDisplayHeight();
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.videoSink = this.createVideoSink(this.videoTrack);
    } else {
      this.canvas.hidden = true;
    }

    if (this.audioTrack) {
      await this.initializeAudio();
      this.audioSink = this.createAudioSink(this.audioTrack);
    }

    const liveTimeline = this.getLiveTimeline();
    const requestedInitialTime = startTime || liveTimeline?.playStartTime || this.firstTimestamp;
    const initialTime = clamp(requestedInitialTime, this.firstTimestamp, this.duration || Infinity);
    await this.restartProducers(initialTime);
    this.setState("paused");
    return this;
  }

  createPrefetcher() {
    return new HlsSegmentPrefetcher({
      ahead: HLS_BUFFER_MAX_SEGMENTS,
      targetAheadSeconds: HLS_BUFFER_TARGET_SECONDS,
      maxBytes: HLS_BUFFER_MAX_BYTES,
      maxConcurrent: HLS_PREFETCH_CONCURRENCY,
      onSessionExpired: (error) => {
        if (this.destroyed) return;
        this.hlsSessionError = error;
        // Paused players can keep their cached frame. Rebuild on resume,
        // rather than keeping idle Plex transcoders alive indefinitely.
        if (this.wantsPlayback) this.fail(error);
      },
    });
  }

  // An HLS input reads through the one prefetcher, also when a recovery
  // step opens the stream again: one buffer, one download slot.
  createInput(url, { boundedRanges = true, prefetchHls = false } = {}) {
    if (prefetchHls) this.hlsSegmentPrefetcher ??= this.createPrefetcher();
    return new Input({
      source: new UrlSource(new URL(url, location.href).href, {
        ...(boundedRanges ? { fetchFn: boundedRangeFetch } : {}),
        ...(prefetchHls ? { fetchFn: this.hlsSegmentPrefetcher.fetch.bind(this.hlsSegmentPrefetcher) } : {}),
        getRetryDelay: fetchRetryDelay,
        maxCacheSize: 16 * 1024 * 1024,
        parallelism: 2,
      }),
      formats: [...HLS_FORMATS, WEBM],
    });
  }

  releaseInput(input) {
    if (!input || Object.values(this.trackInputs).includes(input)) return;
    const index = this.inputs.indexOf(input);
    if (index >= 0) this.inputs.splice(index, 1);
    try { input.dispose(); } catch {}
  }

  // Every decoder of a sink can fail on the decodeErrorAt fault, and the
  // probe watches it (decoder-probe.js). `decoderOptions` adds to the
  // engine's own: a recovery step asks for software decoding.
  createVideoSink(track, decoderOptions = {}) {
    const sink = new CanvasSink(track, {
      poolSize: VIDEO_QUEUE_MAX_CAPACITY + 2,
      fit: "contain",
      decoderOptions: {
        optimizeForLatency: true,
        ...decoderOptions,
      },
    });
    injectDecodeErrors(sink, () => (this.decodeFault?.track === "video" ? this.decodeFault : null));
    this.decoderProbes.video.attach(sink);
    return sink;
  }

  createAudioSink(track) {
    const sink = new AudioBufferSink(track);
    injectDecodeErrors(sink, () => (this.decodeFault?.track === "audio" ? this.decodeFault : null));
    this.decoderProbes.audio.attach(sink);
    return sink;
  }

  async initializeAudio() {
    if (typeof AudioWorkletNode !== "function") {
      throw new Error("Mediabunny engine requires AudioWorklet");
    }

    const requestedSampleRate = await this.audioTrack.getSampleRate();
    const channels = await this.audioTrack.getNumberOfChannels();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextClass({ sampleRate: requestedSampleRate });
    if (this.audioContext.sampleRate !== requestedSampleRate) {
      throw new Error(
        `Audio sample-rate conversion is not implemented (${requestedSampleRate} -> ${this.audioContext.sampleRate})`,
      );
    }

    await this.audioContext.audioWorklet.addModule(
      new URL("./audio-worklet-processor.js", import.meta.url),
    );

    this.audioRing = new AudioRingBuffer({
      capacityFrames: Math.ceil(this.audioContext.sampleRate * AUDIO_CAPACITY_SECONDS),
      channels,
    });
    this.audioRing.setPlaybackRate(this.playbackRate);
    this.audioNode = new AudioWorkletNode(this.audioContext, "yolo-audio-output-v1", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: this.audioRing.processorOptions,
    });
    this.audioNode.port.onmessage = (event) => {
      if (event.data?.type === "underrun" && this.wantsPlayback && !this.audioEnded) {
        this.enterBuffering("audio-underrun");
      }
    };

    this.gainNode = this.audioContext.createGain();
    this.compressorNode = this.audioContext.createDynamicsCompressor();
    this.compressorNode.threshold.value = -24;
    this.compressorNode.knee.value = 12;
    this.compressorNode.ratio.value = 8;
    this.compressorNode.attack.value = 0.003;
    this.compressorNode.release.value = 0.15;
    this.audioNode.connect(this.gainNode);
    this.gainNode.connect(this.compressorNode);
    this.compressorNode.connect(this.audioContext.destination);
    this.updateGain();
    this.clock.useAudioRing(this.audioRing, this.audioContext.sampleRate);
    const context = this.audioContext;
    context.onstatechange = () => {
      if (this.destroyed || this.audioContext !== context) return;
      // A gesture elsewhere (or the browser itself) let it run.
      if (context.state === "running" && this.audioBlocked) void this.leaveAudioBlocked();
      // The system took the output away while playing (another app, a
      // call): try once more, else keep the picture going muted.
      else if (context.state !== "running" && context.state !== "closed" && this.wantsPlayback && !this.audioBlocked) {
        void this.startAudioOutput();
      }
    };
  }

  // "running": sound can play; "blocked": the browser will not start audio
  // without a user gesture, so playback runs muted; "none": no audio track.
  get audioOutputState() {
    if (!this.audioContext || this.audioContext.state === "closed") return "none";
    return this.audioBlocked ? "blocked" : "running";
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

  // Try to start sound. Chromium allows it after a gesture on the page or for
  // a site with high media engagement; otherwise resume() stays pending.
  async startAudioOutput() {
    const context = this.audioContext;
    if (!context || context.state === "closed") return this.audioOutputState;
    if (context.state !== "running") {
      await Promise.race([
        context.resume().catch(() => {}),
        wait(AUDIO_RESUME_TIMEOUT_MS),
      ]);
      if (this.destroyed || this.audioContext !== context) return this.audioOutputState;
    }
    if (context.state === "running") await this.leaveAudioBlocked();
    else this.enterAudioBlocked();
    return this.audioOutputState;
  }

  // Called from a user gesture (a tap anywhere): resume() must start inside
  // the gesture, so it is called before anything is awaited.
  async enableAudioOutput() {
    const context = this.audioContext;
    if (!context || context.state === "closed") return this.audioOutputState;
    if (context.state !== "running") {
      await Promise.race([context.resume().catch(() => {}), wait(AUDIO_RESUME_TIMEOUT_MS)]);
      if (this.destroyed || this.audioContext !== context) return this.audioOutputState;
    }
    if (context.state === "running") await this.leaveAudioBlocked();
    return this.audioOutputState;
  }

  enterAudioBlocked() {
    if (this.audioBlocked || this.destroyed) {
      this.reportAudioOutput();
      return;
    }
    this.audioBlocked = true;
    if (this.videoTrack) {
      // The audio clock stands still while the context is suspended: the
      // picture runs on the wall clock instead, from where it is.
      this.clock.useWallClock();
    } else {
      // Muted audio-only playback shows nothing: wait for a tap to play.
      this.wantsPlayback = false;
      this.audioRing?.setRunning(false);
      this.clock.stop();
      this.setState("paused", { reason: "audio-blocked" });
    }
    this.reportAudioOutput();
  }

  async leaveAudioBlocked() {
    if (!this.audioBlocked) {
      this.reportAudioOutput();
      return;
    }
    this.audioBlocked = false;
    // The ring still holds audio from where the picture left it: restart
    // both tracks at the picture's time, from the encoded buffer, so sound
    // and picture are in step again.
    const at = this.clock.currentTime;
    this.reportAudioOutput();
    if (this.videoTrack) await this.seek(Math.round(at * 1000), { preserveHlsBuffer: true });
  }

  async restartProducers(mediaTime, {
    resetHlsBuffer = false,
    hlsSeekTarget = mediaTime,
  } = {}) {
    // Invalidate current producers immediately. Iterator teardown is serialized
    // below so rapid seeks cannot make an old producer consume a newer iterator.
    const generation = ++this.generation;
    // What failed before is behind or ahead of the new place.
    this.decoderRecovery.reset();
    this.clearRecoveryTimers();
    this.videoHoldUntil = 0;
    return this.producerRestarts.run(async ({ isCurrent }) => {
      const videoIterator = this.videoIterator;
      const audioIterator = this.audioIterator;
      this.videoIterator = null;
      this.audioIterator = null;
      const closeResults = await Promise.all([
        closeIterator(videoIterator),
        closeIterator(audioIterator),
      ]);
      const closeFailures = closeResults.filter((closed) => !closed).length;
      if (closeFailures) {
        this.iteratorCloseTimeoutCount += closeFailures;
        console.warn("[mediabunny] Decoder iterator did not close cleanly", {
          closeFailures,
          target: mediaTime,
        });
      }
      if (!isCurrent() || generation !== this.generation || this.destroyed) return false;

      if (resetHlsBuffer) this.hlsSegmentPrefetcher?.handleSeek(hlsSeekTarget);
      this.videoQueue.length = 0;
      this.videoQueueCapacity = VIDEO_QUEUE_MIN_CAPACITY;
      this.videoEnded = !this.videoTrack;
      this.audioEnded = !this.audioTrack;
      this.audioRing?.reset();
      this.audioOutputEnd = mediaTime;
      // Seeking may return from a silent video tail to an active audio track.
      // While sound is blocked, the picture keeps the wall clock.
      this.clock.useAudioRing(this.audioBlocked ? null : this.audioRing, this.audioContext?.sampleRate || 0);
      this.clock.reset(mediaTime);
      this.lastRenderedTimestamp = mediaTime;
      this.firstVideoRendered = false;

      if (this.videoSink) {
        const nextVideoIterator = this.videoSink.canvases(mediaTime);
        this.videoIterator = nextVideoIterator;
        void this.produceVideo(generation, this.trackRuns.video, nextVideoIterator);
      }
      if (this.audioSink) {
        const nextAudioIterator = this.audioSink.buffers(mediaTime);
        this.audioIterator = nextAudioIterator;
        void this.produceAudio(generation, this.trackRuns.audio, mediaTime, nextAudioIterator);
      }
      return true;
    });
  }

  // `run` is the video track's restart count it belongs to. For a decoder a
  // recovery step restarted (`recovering`, decoder-recovery.js): `after`,
  // frames at or before it are already in the queue, since the decoder
  // starts at a key frame before them; `then`, the iterator that follows
  // this one when it ends, as the software decoder hands over to the
  // hardware one.
  async produceVideo(generation, run, iterator, { after = -Infinity, then = null, recovering = false } = {}) {
    const current = () => generation === this.generation && run === this.trackRuns.video && !this.destroyed;
    let asked = !recovering;
    try {
      while (current()) {
        while (this.videoQueue.length >= this.videoQueueCapacity || this.suspension) {
          if (!current()) return;
          await (this.suspension?.promise ?? wait(10));
        }

        await this.waitForVideoFault(generation);
        if (!current()) return;
        if (!asked) {
          asked = true;
          this.armRecoveryDeadline("video");
        }
        const result = await iterator.next();
        if (!current()) return;
        if (result.done) {
          if (then) {
            iterator = then();
            then = null;
            this.videoIterator = iterator;
            continue;
          }
          this.videoEnded = true;
          return;
        }
        const frame = result.value;
        if (frame.timestamp <= after) continue;
        const frameDuration = Number(frame.duration);
        if (Number.isFinite(frameDuration) && frameDuration > 0) {
          this.videoQueueCapacity = clamp(
            Math.ceil((VIDEO_QUEUE_TARGET_SECONDS * this.marginScale) / frameDuration),
            VIDEO_QUEUE_MIN_CAPACITY,
            VIDEO_QUEUE_MAX_CAPACITY,
          );
        }
        this.videoQueue.push(frame);
        this.videoDecodeCount += 1;
        if (recovering) recovering = !this.noteDecoderOutput("video", frame.timestamp);
      }
    } catch (error) {
      if (current()) this.handleTrackFailure(error, "video");
    }
  }

  // Audio buffers go out back to back, placed by their timestamps: a gap
  // becomes silence and an overlap is trimmed (audio-timeline.js).
  // `outputStart` is where the output so far ends: the start of playback,
  // or, for a restarted decoder, the end of what the ring already holds.
  async produceAudio(generation, run, outputStart, iterator, { recovering = false } = {}) {
    const current = () => generation === this.generation && run === this.trackRuns.audio && !this.destroyed;
    let first = true;
    let outputEnd = outputStart;
    let asked = !recovering;
    try {
      while (current()) {
        if (this.suspension) {
          await this.suspension.promise;
          continue;
        }
        if (!asked) {
          asked = true;
          this.armRecoveryDeadline("audio");
        }
        const result = await iterator.next();
        if (!current()) return;
        if (result.done) {
          this.audioEnded = true;
          this.audioRing.markEnded();
          return;
        }

        const { buffer, timestamp } = result.value;
        const placed = placeAudioBuffer({ timestamp, frames: buffer.length, sampleRate: buffer.sampleRate }, outputEnd, { first });
        outputEnd = placed.outputEnd;
        if (placed.discontinuity) this.audioDiscontinuityCount += 1;
        if (placed.skip) continue;
        first = false;
        const shouldContinue = current;
        const waitForSpace = () => this.suspension?.promise ?? wait(10);
        if (placed.silenceFrames > 0) {
          if (!await this.audioRing.writeAudioBuffer(silentAudioBuffer(placed.silenceFrames, buffer.sampleRate), { shouldContinue, waitForSpace })) return;
        }
        const wrote = await this.audioRing.writeAudioBuffer(buffer, { startFrame: placed.startFrame, shouldContinue, waitForSpace });
        if (!wrote) return;
        this.audioOutputEnd = outputEnd;
        this.audioBufferCount += 1;
        if (recovering) recovering = !this.noteDecoderOutput("audio", timestamp + buffer.length / buffer.sampleRate);
      }
    } catch (error) {
      if (current()) this.handleTrackFailure(error, "audio");
    }
  }

  // --- Recovering a failed decoder in place (decoder-recovery.js) --------

  // A producer's reading or decoding threw (`cause` "error"), a restarted
  // decoder gave nothing out by its step's deadline ("timeout"), or a step
  // could not be taken ("step"). A decoder's failure climbs the ladder;
  // anything else (a 410, a segment whose tries ran out) fails the engine,
  // and the player recovers with a new stream, as before.
  handleTrackFailure(error, track, { cause = "error" } = {}) {
    if (this.destroyed) return;
    let decoder = null;
    try { decoder = this.decoderProbes?.[track]?.describe() ?? null; } catch {}
    if (cause === "error" && !isDecoderError(error, decoder)) {
      this.fail(error, { track });
      return;
    }
    let failure = null;
    try { failure = error ? this.describeFailure(error, track) : null; } catch {}
    const at = Number.isFinite(decoder?.lastPacketTimestamp) ? decoder.lastPacketTimestamp : this.trackPosition(track);
    const segments = this.hlsSegmentPrefetcher?.describeSegmentsAt(at, this.firstTimestamp) ?? null;
    const plan = this.decoderRecovery.fail(track, { at, cause, detail: { failure, segments } });
    this.clearRecoveryTimer(track);
    if (plan.ended) this.reportRecovery(plan.ended);
    if (plan.step >= NEW_STREAM_STEP) {
      this.reportRecovery({ ...plan, cause, outcome: "requested", elapsedMs: 0, sinceFailureMs: plan.ended?.sinceFailureMs ?? 0, detail: { failure, segments } });
      const failed = new Error(`The ${track} decoder failed at ${round3(plan.at)} s and did not recover in place${error?.message ? `: ${error.message}` : ""}`);
      failed.code = "DECODER_FAILED";
      this.fail(failed, { track, failure: failure ?? this.describeFailure(failed, track) });
      return;
    }
    void this.recoverTrack(plan);
  }

  // Where `track` is now: the end of the decoded picture, or of the sound
  // the ring holds.
  trackPosition(track) {
    return track === "video" ? this.videoResumePoint().from : this.audioOutputEnd;
  }

  // A restarted picture decoder goes on from the end of the decoded queue,
  // which plays on meanwhile, or from the picture's time when it is empty.
  videoResumePoint() {
    const presentation = this.getVideoPresentationTime();
    const last = this.videoQueue[this.videoQueue.length - 1];
    const end = last ? last.timestamp + (Number(last.duration) || 0) : -Infinity;
    return end > presentation ? { from: end, after: last.timestamp } : { from: presentation, after: -Infinity };
  }

  async recoverTrack({ step, track, at }) {
    const generation = this.generation;
    const run = ++this.trackRuns[track];
    const current = () => generation === this.generation && run === this.trackRuns[track] && !this.destroyed;
    try {
      const failed = track === "video" ? this.videoIterator : this.audioIterator;
      if (track === "video") this.videoIterator = null;
      else this.audioIterator = null;
      if (!await closeIterator(failed)) this.iteratorCloseTimeoutCount += 1;
      if (!current()) return;
      // The local steps keep the sound going over a held picture; a refetch
      // waits for the network as any stall does.
      if (track === "video") this.videoHoldUntil = step === 2 ? 0 : performance.now() + VIDEO_HOLD_MS;
      const { deadlineMs } = RECOVERY_STEPS[step];
      let mediaTrack = track === "video" ? this.videoTrack : this.audioTrack;
      let sink = track === "video" ? this.videoSink : this.audioSink;
      if (step === 2) {
        // The segment may have come incomplete: it leaves the buffer, and a
        // new input reads it again from the same session.
        this.hlsSegmentPrefetcher?.evictSegmentsAt(at);
        const reopening = this.reopenTrack(track);
        const reopened = await withDeadline(reopening, deadlineMs).catch((error) => {
          reopening.then(({ input }) => this.releaseInput(input), () => {});
          throw error;
        });
        if (!current()) {
          this.releaseInput(reopened.input);
          return;
        }
        mediaTrack = reopened.track;
        sink = track === "video" ? this.createVideoSink(mediaTrack) : this.createAudioSink(mediaTrack);
        this.replaceTrack(track, mediaTrack, reopened.input, sink);
      }
      const key = step === 2 || step === 3
        ? await withDeadline(this.nextKeyTimestamp(mediaTrack, at), deadlineMs)
        : null;
      if (!current()) return;
      if (step === 3 && key === null) throw new Error(`No key frame follows ${round3(at)} s`);
      if (track === "video") {
        const { from, after } = this.videoResumePoint();
        let iterator;
        let then = null;
        if (step === 2 && (key === null || from < key)) {
          // Software only through the place that failed twice: the
          // hardware decoder takes over at the next key frame.
          const software = this.createVideoSink(mediaTrack, { hardwareAcceleration: "prefer-software" });
          const hardware = sink;
          iterator = key === null ? software.canvases(from) : software.canvases(from, key);
          if (key !== null) then = () => hardware.canvases(key);
        } else {
          iterator = sink.canvases(step === 3 ? Math.max(from, key) : from);
        }
        this.videoIterator = iterator;
        this.videoEnded = false;
        void this.produceVideo(generation, run, iterator, { after, then, recovering: true });
      } else {
        const outputStart = this.audioOutputEnd;
        const iterator = sink.buffers(step === 3 ? Math.max(outputStart, key) : outputStart);
        this.audioIterator = iterator;
        this.audioEnded = false;
        void this.produceAudio(generation, run, outputStart, iterator, { recovering: true });
      }
    } catch (error) {
      if (!current()) return;
      // The network's and the session's errors keep the player's recovery;
      // anything else that stops a step is the next step's cause.
      if (typeof error?.code === "string" && error.code) this.fail(error, { track });
      else if (error === STEP_TIMEOUT) this.handleTrackFailure(null, track, { cause: "timeout" });
      else this.handleTrackFailure(error, track, { cause: "step" });
    }
  }

  // The stream opened again from the same session, through the same
  // prefetcher, for the one track a recovery step reads anew.
  async reopenTrack(track) {
    const source = this.trackSources[track];
    const input = this.createInput(source.url, source);
    this.inputs.push(input);
    try {
      if (!await input.canRead()) throw new Error("Mediabunny could not read the stream again");
      const mediaTrack = track === "video" ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
      if (!mediaTrack) throw new Error(`The stream has no ${track} track any more`);
      return { input, track: mediaTrack };
    } catch (error) {
      this.releaseInput(input);
      throw error;
    }
  }

  // The track plays on from the new input; the one it leaves is disposed
  // unless the other track still reads it.
  replaceTrack(track, mediaTrack, input, sink) {
    const previous = this.trackInputs[track];
    this.trackInputs[track] = input;
    if (track === "video") {
      this.videoTrack = mediaTrack;
      this.videoSink = sink;
    } else {
      this.audioTrack = mediaTrack;
      this.audioSink = sink;
    }
    if (previous !== input) this.releaseInput(previous);
  }

  // The first key frame after `at`; for sound, whose packets are all key
  // frames, the packet after it. Null when there is none.
  async nextKeyTimestamp(mediaTrack, at) {
    const packets = new EncodedPacketSink(mediaTrack);
    const options = { verifyKeyPackets: true };
    const key = await packets.getKeyPacket(at, options);
    const next = key ? await packets.getNextKeyPacket(key, options) : await packets.getFirstKeyPacket(options);
    return next ? next.timestamp : null;
  }

  // A restarted decoder was asked for its first output: that starts its
  // step's deadline, unless it already gave some.
  armRecoveryDeadline(track) {
    const step = this.decoderRecovery.asked(track);
    if (!step) return;
    const { token, deadlineMs } = step;
    this.clearRecoveryTimer(track);
    const expire = () => {
      this.recoveryTimers[track] = null;
      if (this.destroyed || !this.decoderRecovery.waiting(track, token)) return;
      // Hidden, nothing decodes: not the decoder's fault.
      if (this.suspension) {
        this.recoveryTimers[track] = setTimeout(expire, deadlineMs);
        return;
      }
      this.handleTrackFailure(null, track, { cause: "timeout" });
    };
    this.recoveryTimers[track] = setTimeout(expire, deadlineMs);
  }

  // A restarted decoder gave media out: it met its deadline. True once its
  // ladder closed, past the place it failed, or was left behind.
  noteDecoderOutput(track, timestamp) {
    this.clearRecoveryTimer(track);
    const recovered = this.decoderRecovery.output(track, timestamp);
    if (recovered) {
      if (track === "video") this.videoHoldUntil = 0;
      this.reportRecovery(recovered);
    }
    return !this.decoderRecovery.ladders[track];
  }

  clearRecoveryTimer(track) {
    if (!this.recoveryTimers?.[track]) return;
    clearTimeout(this.recoveryTimers[track]);
    this.recoveryTimers[track] = null;
  }

  clearRecoveryTimers() {
    this.clearRecoveryTimer("video");
    this.clearRecoveryTimer("audio");
  }

  // One `decoder_recovery` event per step (Agent Note
  // 2026-10-11-device-telemetry): the failure that started it, with the
  // segments in `segments` rather than inside it.
  reportRecovery({ step, action, track, at, cause, outcome, elapsedMs, firstOutputMs, sinceFailureMs, detail }) {
    const failure = detail?.failure ? { ...detail.failure, segments: undefined } : null;
    const event = {
      step,
      action,
      track,
      at: round3(at),
      cause,
      outcome,
      elapsedMs,
      firstOutputMs: firstOutputMs ?? null,
      sinceFailureMs: sinceFailureMs ?? null,
      segments: detail?.segments ?? null,
      ...(failure ? { failure } : {}),
    };
    console.warn("[mediabunny] decoder recovery", event);
    try {
      this.onDecoderRecovery(event);
    } catch {
      // Telemetry never breaks playback.
    }
  }

  async play() {
    if (this.hlsSessionError) { this.fail(this.hlsSessionError); return; }
    this.wantsPlayback = true;
    await this.startAudioOutput();
    if (this.destroyed || !this.wantsPlayback) return;
    this.updatePlaybackBarrier();
  }

  async pause() {
    this.wantsPlayback = false;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState("paused");
  }

  async resume() {
    return this.play();
  }

  async seek(milliseconds, { preserveHlsBuffer = false } = {}) {
    const seconds = typeof milliseconds === "bigint"
      ? Number(milliseconds) / 1000
      : Number(milliseconds) / 1000;
    const target = clamp(seconds, this.firstTimestamp, this.duration || Infinity);
    this.seekRequestCount += 1;
    this.lastSeekTarget = target;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState("seeking");
    const applied = await this.restartProducers(target, {
      resetHlsBuffer: !preserveHlsBuffer,
      hlsSeekTarget: target,
    });
    if (!applied) {
      this.seekSupersededCount += 1;
      return false;
    }
    this.stallRunwaySeconds = null;
    if (this.wantsPlayback) this.enterBuffering("seek");
    else this.setState("paused");
    return true;
  }

  async stop() {
    this.wantsPlayback = false;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState("stopped");
  }

  // A paused player kept behind the home screen (player.js) does no work:
  // no frame is drawn, decoded, or fetched, and the audio output stops,
  // until wake(). What is decoded and buffered stays, within its bounds, so
  // the player goes on in place.
  suspend() {
    if (this.destroyed || this.suspension) return;
    let wake = null;
    this.suspension = { promise: new Promise((resolve) => { wake = resolve; }), wake };
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.hlsSegmentPrefetcher?.suspend();
    if (this.audioContext?.state === "running") void this.audioContext.suspend().catch(() => {});
  }

  // Called from the tap that shows the player again: the audio output
  // starts again inside the gesture, before anything is awaited.
  wake() {
    const suspension = this.suspension;
    if (!suspension || this.destroyed) return;
    this.suspension = null;
    if (this.audioContext?.state === "suspended" && !this.audioBlocked) void this.audioContext.resume().catch(() => {});
    suspension.wake();
    this.hlsSegmentPrefetcher?.resume();
    this.animationFrame = requestAnimationFrame(this.renderFrame);
  }

  get suspended() {
    return Boolean(this.suspension);
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.clearRecoveryTimers();
    this.producerRestarts.invalidate();
    cancelAnimationFrame(this.animationFrame);
    this.suspension?.wake();
    this.suspension = null;
    this.audioRing?.setRunning(false);
    await this.producerRestarts.idle();
    const videoIterator = this.videoIterator;
    const audioIterator = this.audioIterator;
    this.videoIterator = null;
    this.audioIterator = null;
    await Promise.allSettled([
      closeIterator(videoIterator),
      closeIterator(audioIterator),
    ].filter(Boolean));
    for (const input of this.inputs) input.dispose();
    this.inputs.length = 0;
    this.hlsSegmentPrefetcher?.destroy();
    this.hlsSegmentPrefetcher = null;
    try { this.audioNode?.disconnect(); } catch {}
    try { this.gainNode?.disconnect(); } catch {}
    try { this.compressorNode?.disconnect(); } catch {}
    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close();
    }
    this.canvas.remove();
  }

  renderFrame(now) {
    if (this.destroyed) return;
    this.animationFrame = requestAnimationFrame(this.renderFrame);

    // EOF is distinct from a temporary underrun: after the last audio frame
    // drains, video must keep advancing until its own end (also while muted).
    if (this.audioEnded && this.audioRing?.availableFrames === 0) {
      this.clock.useWallClock();
    }
    const mediaTime = this.clock.currentTime;
    const videoPresentationTime = this.getVideoPresentationTime(mediaTime);
    this.maybeTriggerScheduledFault(mediaTime);
    this.renderVideo(videoPresentationTime);
    const endReason = this.wantsPlayback ? getPlaybackEndReason({
      duration: this.duration,
      mediaTime,
      hasAudio: Boolean(this.audioTrack),
      hasVideo: Boolean(this.videoTrack),
      audioEnded: this.audioEnded,
      videoEnded: this.videoEnded,
      audioBufferedSeconds: this.audioSeconds,
      videoBufferedSeconds: this.videoSecondsAhead(videoPresentationTime),
      ignoreDurationBoundary: this.isLive,
    }) : null;
    if (endReason && this.state !== "ended") {
      this.finishPlayback(endReason);
      return;
    }

    this.updatePlaybackBarrier();
    if (now - this.lastTimeEventAt >= TIME_EVENT_INTERVAL_MS) {
      this.lastTimeEventAt = now;
      this.onTime(mediaTime);
    }

  }

  finishPlayback(reason) {
    this.wantsPlayback = false;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState("ended", { reason });
    this.onEnded();
  }

  renderVideo(mediaTime) {
    if (!this.videoTrack || !this.videoQueue.length) return;

    let selected = null;
    while (this.videoQueue.length && this.videoQueue[0].timestamp <= mediaTime + 0.001) {
      if (selected) this.videoDropCount += 1;
      selected = this.videoQueue.shift();
    }
    if (!selected && !this.firstVideoRendered) selected = this.videoQueue[0];
    if (!selected) return;

    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(selected.canvas, 0, 0, this.canvas.width, this.canvas.height);
    this.lastRenderedTimestamp = selected.timestamp;
    this.videoRenderCount += 1;
    if (!this.firstVideoRendered) {
      this.firstVideoRendered = true;
      this.onFirstVideo();
    }
  }

  updatePlaybackBarrier() {
    if (!this.wantsPlayback || this.destroyed || this.state === "ended" || this.state === "error") return;

    const mediaTime = this.clock.currentTime;
    if (this.state === "playing") {
      if (!this.hasPlaybackSafetyMargin(mediaTime)) {
        this.enterBuffering("queue-low");
      }
      return;
    }

    if (this.hasStartupBuffer(mediaTime)) {
      this.enterPlaying();
    } else {
      const reason = this.hasDecodedStartupBuffer(mediaTime)
        ? "building-network-buffer"
        : "waiting-for-both-tracks";
      this.enterBuffering(reason);
    }
  }

  // How much more media the decoded margins hold at this speed. Never NaN:
  // the decoded video queue's bound is computed from it.
  get marginScale() {
    return Math.max(1, this.playbackRate || 1);
  }

  hasDecodedStartupBuffer(mediaTime) {
    const videoPresentationTime = this.getVideoPresentationTime(mediaTime);
    const audioReady = !this.audioTrack
      || this.audioSeconds >= AUDIO_START_SECONDS * this.marginScale
      || this.audioEnded;
    const videoReady = !this.videoTrack
      || this.videoSecondsAhead(videoPresentationTime) >= VIDEO_START_SECONDS * this.marginScale
      // A high-frame-rate stream can hit the strict memory cap before reaching
      // the time target. A full queue is still enough decoded work to start.
      || this.videoQueue.length >= this.videoQueueCapacity
      || this.videoEnded;
    return audioReady && videoReady;
  }

  hasStartupBuffer(mediaTime) {
    return hasHlsStartupBuffer({
      decodedReady: this.hasDecodedStartupBuffer(mediaTime),
      network: this.hlsSegmentPrefetcher?.getStats() || null,
      mediaTime,
      duration: this.isLive ? 0 : this.duration,
      requiredStartSeconds: this.stallRunwaySeconds ?? (this.hlsStartSeconds || START_BUFFER_SECONDS),
    });
  }

  hasPlaybackSafetyMargin(mediaTime) {
    const videoPresentationTime = this.getVideoPresentationTime(mediaTime);
    const audioSafe = !this.audioTrack
      || this.audioSeconds >= AUDIO_REBUFFER_SECONDS * this.marginScale
      || this.audioEnded;
    const videoSafe = !this.videoTrack
      || this.videoSecondsAhead(videoPresentationTime) >= VIDEO_REBUFFER_SECONDS * this.marginScale
      || this.videoEnded
      // A picture decoder recovering in place: the sound plays on.
      || performance.now() < this.videoHoldUntil;
    const unexpectedAudioUnderrun = this.audioRing?.needsBuffering && !this.audioEnded;
    return audioSafe && videoSafe && !unexpectedAudioUnderrun;
  }

  enterPlaying() {
    if (this.state === "playing") return;
    this.stallRunwaySeconds = null;
    this.clock.start();
    this.audioRing?.setRunning(true);
    this.setState("playing");
  }

  enterBuffering(reason) {
    if (this.state === "buffering") return;
    if (reason.startsWith("video") || (reason === "queue-low" && this.videoTrack)) {
      this.videoStutterCount += 1;
    }
    if (this.state === "playing") {
      this.stallRunwaySeconds = stallRunwaySeconds({
        startSeconds: this.hlsStartSeconds || START_BUFFER_SECONDS,
        network: this.hlsSegmentPrefetcher?.getStats() || null,
      });
    }
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState("buffering", { reason });
  }

  videoSecondsAhead(mediaTime = this.clock.currentTime) {
    const last = this.videoQueue[this.videoQueue.length - 1];
    if (!last) return 0;
    return Math.max(0, last.timestamp + last.duration - mediaTime);
  }

  getAudioOutputLatencySeconds() {
    return estimateAudioOutputLatencySeconds(this.audioContext);
  }

  // The sound still on its way to the speakers is media the clock counted
  // but nobody heard yet; at a speed other than 1, that much more of it.
  getVideoPresentationTime(mediaTime = this.clock.currentTime) {
    return Math.max(
      this.firstTimestamp,
      mediaTime - this.getAudioOutputLatencySeconds() * this.playbackRate,
    );
  }

  get audioSeconds() {
    if (!this.audioRing || !this.audioContext) return 0;
    return this.audioRing.availableFrames / this.audioContext.sampleRate;
  }

  injectVideoStall(durationMs) {
    const duration = Math.max(0, Number(durationMs) || 0);
    this.videoFaultUntil = Math.max(this.videoFaultUntil, performance.now() + duration);
    console.warn("[mediabunny] Injecting video read stall", { durationMs: duration });
  }

  // The decodeErrorAt fault for in-car checks and tests: the next `count`
  // decoders of `track` that reach `atSeconds` fail there
  // (decoder-probe.js).
  injectDecodeError(atSeconds, { count = 1, track = "video" } = {}) {
    this.decodeFault = { atSeconds: Number(atSeconds) || 0, remaining: Math.max(1, Math.floor(Number(count) || 1)), track };
    console.warn("[mediabunny] Injecting decoder errors", this.decodeFault);
  }

  maybeTriggerScheduledFault(mediaTime) {
    if (this.scheduledFaultTriggered || !this.faultInjection) return;
    if (mediaTime < this.faultInjection.atSeconds) return;
    this.scheduledFaultTriggered = true;
    this.injectVideoStall(this.faultInjection.durationMs);
  }

  async waitForVideoFault(generation) {
    while (performance.now() < this.videoFaultUntil) {
      if (generation !== this.generation || this.destroyed) return;
      await wait(Math.min(50, this.videoFaultUntil - performance.now()));
    }
  }

  setState(state, detail = {}) {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    console.log("[mediabunny] state", { previous, state, ...detail });
    this.onStateChange(state, { previous, ...detail });
  }

  // `track` is the one whose reading or decoding threw, if it was one;
  // `failure`, the description of a decoder failure the recovery ladder
  // could not heal (decoder-recovery.js).
  fail(error, { track = null, failure = null } = {}) {
    const failed = error instanceof Error ? error : new Error(String(error));
    this.wantsPlayback = false;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.clearRecoveryTimers();
    try {
      this.failureDetail = failure ?? this.describeFailure(failed, track);
      this.failedWith = failed;
    } catch {
      this.failureDetail = null;
    }
    this.setState("error", { error: String(failed.message || failed.name || "").slice(0, 300), failure: this.failureDetail });
    this.onError(failed);
  }

  // What failed, for telemetry (Agent Note 2026-10-11-device-telemetry):
  // which track's reading or decoding threw, the error's name and code, the
  // first frame of its stack, that track's decoder, and in each playlist the
  // segment of its last packet. Small and bounded, and no URLs.
  describeFailure(error, track) {
    const decoder = track ? this.decoderProbes?.[track]?.describe() ?? null : null;
    const at = decoder?.lastPacketTimestamp ?? this.clock?.currentTime ?? null;
    return {
      track,
      name: String(error?.name || "Error").slice(0, 60),
      code: typeof error?.code === "string" ? error.code.slice(0, 60) : null,
      stack: firstStackFrame(error),
      decoder,
      segments: this.hlsSegmentPrefetcher?.describeSegmentsAt(at, this.firstTimestamp) ?? null,
    };
  }

  // The failure's description, when `error` is what this player failed with.
  getFailure(error) {
    return error && error === this.failedWith ? this.failureDetail : null;
  }

  updateGain() {
    if (this.gainNode) this.gainNode.gain.value = this.volume * this.audioGain;
  }

  setVolume(volume) {
    this.volume = clamp(Number(volume) || 0, 0, 1);
    this.updateGain();
  }

  setAudioGain(gain) {
    this.audioGain = Math.max(1, Number(gain) || 1);
    this.updateGain();
  }

  // The owner's speed (player.js). The audio output stretches the sound in
  // time and keeps its pitch, and its clock counts media frames, so the
  // picture, subtitles, danmaku, and positions follow without a change of
  // their own (audio-worklet-processor.js); without sound, the wall clock
  // runs at the speed. The encoded buffer stays in media seconds: at twice
  // the speed it covers half as long a dead spot.
  setPlaybackRate(rate) {
    this.playbackRate = clamp(Number(rate) || 1, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
    this.audioRing?.setPlaybackRate(this.playbackRate);
    this.clock.setRate(this.playbackRate);
  }

  resize() {}

  getDuration() {
    return BigInt(Math.round(this.duration * 1000));
  }

  getStatus() {
    return this.state;
  }

  // Video frames drawn so far: an overlay that draws when this changes
  // (danmaku.js) updates the page in the same frames as the picture.
  get presentedFrames() {
    return this.videoRenderCount;
  }

  getCurrentTime() {
    return this.clock.currentTime;
  }

  getLiveTimeline() {
    if (!this.isLive) return null;
    const stats = this.hlsSegmentPrefetcher?.getStats();
    if (!Number.isFinite(stats?.liveDvrStartTime) || !Number.isFinite(stats?.liveEdgeTime)) return null;
    return {
      startTime: stats.liveDvrStartTime,
      edgeTime: stats.liveEdgeTime,
      playStartTime: stats.livePlayStartTime,
    };
  }

  getSeekableRange() {
    return {
      start: this.firstTimestamp,
      end: this.duration > 0 ? this.duration : null,
    };
  }

  getStats() {
    const currentTimeMs = Math.round(this.clock.currentTime * 1000);
    const audioOutputLatencyMs = Math.round(this.getAudioOutputLatencySeconds() * 1000);
    const videoPresentationTime = this.getVideoPresentationTime();
    const hlsNetwork = this.hlsSegmentPrefetcher?.getStats() || null;
    return {
      audioFrameRenderCount: this.audioRing
        ? Math.floor(this.audioRing.consumedFrames / 128)
        : 0,
      audioCurrentTime: currentTimeMs,
      audibleAudioCurrentTime: currentTimeMs - audioOutputLatencyMs,
      audioOutputLatencyMs,
      audioNextTime: currentTimeMs + Math.round(this.audioSeconds * 1000),
      audioStutter: this.audioRing?.underrunCount || 0,
      audioDiscontinuities: this.audioDiscontinuityCount,
      videoFrameDecodeCount: this.videoDecodeCount,
      videoFrameRenderCount: this.videoRenderCount,
      videoFrameDropCount: this.videoDropCount,
      videoCurrentTime: Math.round(this.lastRenderedTimestamp * 1000),
      videoNextTime: Math.round(
        (videoPresentationTime + this.videoSecondsAhead(videoPresentationTime)) * 1000,
      ),
      videoStutter: this.videoStutterCount,
      seekRequestCount: this.seekRequestCount,
      seekSupersededCount: this.seekSupersededCount,
      iteratorCloseTimeoutCount: this.iteratorCloseTimeoutCount,
      lastSeekTarget: this.lastSeekTarget,
      audiocodec: this.audioCodec,
      videocodec: this.videoCodec,
      width: this.width,
      height: this.height,
      engine: "mediabunny",
      bandwidth: hlsNetwork?.throughputKbps ? hlsNetwork.throughputKbps * 1000 : null,
      hlsThroughputSampleCount: hlsNetwork?.sampleCount ?? null,
      hlsThroughputSampleAgeMs: hlsNetwork?.throughputSampleAgeMs ?? null,
      hlsAllRemainingSegmentsCached: hlsNetwork?.allRemainingSegmentsCached ?? null,
      audioBufferedMs: Math.round(this.audioSeconds * 1000),
      videoBufferedMs: Math.round(this.videoSecondsAhead(videoPresentationTime) * 1000),
      audioSourceEnded: this.audioEnded,
      videoSourceEnded: this.videoEnded,
      durationDistanceMs: this.duration > 0
        ? Math.round((this.duration - this.clock.currentTime) * 1000)
        : null,
      hlsBufferedAheadSeconds: hlsNetwork?.bufferedAheadSeconds ?? null,
      hlsBufferedBytes: hlsNetwork?.cachedBytes ?? null,
      hlsCachedSegments: hlsNetwork?.cachedSegments ?? null,
      hlsPendingSegments: hlsNetwork?.pendingSegments ?? null,
      hlsActiveDownloads: hlsNetwork?.activeDownloads ?? null,
      hlsQueuedSegments: hlsNetwork?.queuedSegments ?? null,
      hlsRetryWaitingSegments: hlsNetwork?.retryWaitingSegments ?? null,
      hlsOldestActiveDownloadMs: hlsNetwork?.oldestActiveDownloadMs ?? null,
      hlsNetworkRetryCount: hlsNetwork?.networkRetryCount ?? null,
      hlsTimeoutCount: hlsNetwork?.timeoutCount ?? null,
      hlsFailureCount: hlsNetwork?.failureCount ?? null,
      hlsLastFailure: hlsNetwork?.lastFailure ?? null,
      hlsBufferMaxBytes: hlsNetwork?.maxBytes ?? null,
      hlsBufferTargetSeconds: hlsNetwork?.targetAheadSeconds ?? null,
      hlsBufferCacheUtilization: hlsNetwork?.cacheUtilization ?? null,
      hlsPeakBufferedBytes: hlsNetwork?.peakCachedBytes ?? null,
      hlsPeakBufferedAheadSeconds: hlsNetwork?.peakBufferedAheadSeconds ?? null,
      hlsManagedBytesEstimate: hlsNetwork?.managedBytesEstimate ?? null,
      hlsPeakManagedBytesEstimate: hlsNetwork?.peakManagedBytesEstimate ?? null,
      hlsBufferByteCapHitCount: hlsNetwork?.byteCapHitCount ?? null,
      hlsEvictions: hlsNetwork?.evictions ?? null,
      hlsPlaylists: hlsNetwork?.playlists ?? null,
      hlsOrphanJobs: hlsNetwork?.orphanJobs ?? null,
      liveDvrStartTime: hlsNetwork?.liveDvrStartTime ?? null,
      liveEdgeTime: hlsNetwork?.liveEdgeTime ?? null,
      livePlayStartTime: hlsNetwork?.livePlayStartTime ?? null,
      liveLatencyMs: Number.isFinite(hlsNetwork?.liveEdgeTime)
        ? Math.max(0, Math.round((hlsNetwork.liveEdgeTime - this.clock.currentTime) * 1000))
        : null,
    };
  }
}
