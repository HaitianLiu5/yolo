import { state } from "../state.js";
import { deviceEvents } from "./device-events.js";
import { bufferState, droppedFrames, readStats, summarizeStats } from "./engine-stats.js";
import { PageMemoryMonitor } from "./page-memory-monitor.js";
import { loggedStream, logPlayerEvent } from "./player-log.js";
import { describeCanvas, describeVideo, describeViewport } from "./screen.js";

// How each stream plays, in the runtime log (Agent Note
// 2026-10-11-device-telemetry), from begin() to end(); player.js imports
// the module as `telemetry`:
// - stalls (`stall_start`, `stall_end`), which the reports' `health` also
//   carries (playbackHealth);
// - a `stutter_report` every 30 seconds, and soon after a stall or a long
//   task, of the stalls, long tasks, and jumps in the JavaScript heap since
//   the last one;
// - a `health_heartbeat` every 30 seconds: the buffer, the heap and the
//   page's memory, dropped frames, and what the danmaku layer drew;
// - the decode path every 60 seconds (`decode_info`, `decode_path_change`);
// - and how long a wake took until the picture moved again
//   (`wake_to_playback`, device-events.js).

const STUTTER_REPORT_INTERVAL_MS = 30_000;
const STUTTER_EVENTS_KEPT = 100;
const STUTTER_FLUSH_IDLE_TIMEOUT_MS = 1_000;
const LONG_TASK_MS = 50;
const HEAP_SAMPLE_INTERVAL_MS = 15_000;
// A heap that grew this much since its last low counts as memory pressure.
const HEAP_GROWTH_BYTES = 8 * 1024 * 1024;
const HEAP_GROWTH_RATIO = 0.15;
const HEARTBEAT_INTERVAL_MS = 30_000;
const DECODE_HEALTH_INTERVAL_MS = 60_000;
const PAGE_MEMORY_INTERVAL_MS = 5 * 60_000;
// Stalls of the last half hour, across streams of the same item (a quality
// change or a recovery starts a new stream), for the reports' `health`.
const RECENT_STALLS_KEPT_MS = 30 * 60_000;

const CAPABILITIES = Object.freeze({
  platform: navigator.userAgentData?.platform || navigator.platform || "",
  userAgent: navigator.userAgent || "",
  hasVideoDecoder: typeof globalThis.VideoDecoder === "function",
  hasAudioDecoder: typeof globalThis.AudioDecoder === "function",
  hasAudioWorklet: typeof (globalThis.AudioContext || globalThis.webkitAudioContext) === "function" && typeof globalThis.AudioWorkletNode === "function",
  crossOriginIsolated: globalThis.crossOriginIsolated === true,
});

let fromPlayer = {
  position: () => 0,
  playbackState: () => "idle",
  engine: () => ({ name: "canvas", decodePath: null }),
  danmakuStats: () => null,
  container: null,
};

/**
 * `position()` is where playback is, `playbackState()` idle, buffering,
 * playing, or paused, `engine()` the engine playing ({ name, decodePath }),
 * `danmakuStats()` what the danmaku layer drew since it was last asked, and
 * `container` the element the engines draw into (player.js).
 */
export function init({ position, playbackState, engine, danmakuStats, container }) {
  fromPlayer = { position, playbackState, engine, danmakuStats, container };
}

// --- Stalls ------------------------------------------------------------------

const stalls = { count: 0, totalMs: 0, startedAt: 0, item: null, recent: [] };
const playingItem = () => (state.source ? `${state.source.plugin}:${state.source.id}` : null);

// This item's stalls of the last half hour; another item starts with none.
function recentStalls(now) {
  if (stalls.item !== playingItem()) {
    stalls.item = playingItem();
    stalls.recent = [];
  }
  stalls.recent = stalls.recent.filter((stall) => now - stall.startedAt < RECENT_STALLS_KEPT_MS);
  return stalls.recent;
}

const stalledMs = (now) => (stalls.startedAt ? now - stalls.startedAt : 0);

export function stallBegan() {
  if (stalls.startedAt) return;
  const now = performance.now();
  stalls.count += 1;
  stalls.startedAt = now;
  stalls.recent = [...recentStalls(now), { startedAt: now, endedAt: 0, at: Date.now(), position: fromPlayer.position() }].slice(-10);
  logPlayerEvent("stall_start", { buffer: bufferState(readStats(state.player)), memory: memoryForLog(false) });
}

export function stallEnded() {
  if (!stalls.startedAt) return;
  const now = performance.now();
  const durationMs = now - stalls.startedAt;
  const stall = stalls.recent.at(-1);
  if (stall && !stall.endedAt) stall.endedAt = now;
  stalls.totalMs += durationMs;
  stalls.startedAt = 0;
  logPlayerEvent("stall_end", { durationMs: Math.round(durationMs), buffer: bufferState(readStats(state.player)), memory: memoryForLog(false) });
  if (stall) {
    noteStutter({ type: "buffering_stall", timestamp: Date.now(), playbackPosition: stall.position, startTime: stall.at, durationMs: Math.round(durationMs) });
    queueStutterReport("stall");
  }
}

/** The stalls the reports' `health` carries: this stream's, and this item's recent ones, newest first. */
export function playbackHealth(now = performance.now()) {
  const tenths = (ms) => Math.round(ms / 100) / 10;
  return {
    stalls: stalls.count,
    stallSeconds: tenths(stalls.totalMs + stalledMs(now)),
    recentStalls: recentStalls(now)
      .map((stall) => ({ ago: Math.round((now - stall.startedAt) / 1000), seconds: tenths((stall.endedAt || now) - stall.startedAt) }))
      .reverse()
      .slice(0, 5),
  };
}

// --- Memory ------------------------------------------------------------------

const heap = { sampledAt: 0, low: 0, snapshot: null };
const pageMemory = new PageMemoryMonitor({ intervalMs: PAGE_MEMORY_INTERVAL_MS });
const pageMemoryNotes = { unavailableLogged: false, lastError: null, stream: null, correlated: false };

// Chrome's JavaScript heap (performance.memory), at most every 15 seconds
// unless `force`; a jump from its last low is memory pressure.
function sampleHeap(force) {
  const now = performance.now();
  if (!force && now - heap.sampledAt < HEAP_SAMPLE_INTERVAL_MS) return heap.snapshot;
  heap.sampledAt = now;
  const memory = performance.memory;
  if (!memory) return null;
  const used = Number(memory.usedJSHeapSize) || 0;
  const growth = heap.low > 0 ? used - heap.low : 0;
  heap.snapshot = {
    timestamp: Date.now(),
    usedJSHeapSize: used,
    totalJSHeapSize: Number(memory.totalJSHeapSize) || 0,
    jsHeapSizeLimit: Number(memory.jsHeapSizeLimit) || 0,
    heapGrowthBytes: growth,
  };
  if (!heap.low || used < heap.low * 0.9) {
    heap.low = used;
  } else if (growth >= HEAP_GROWTH_BYTES && growth / heap.low >= HEAP_GROWTH_RATIO) {
    const { timestamp, ...sizes } = heap.snapshot;
    noteStutter({ type: "memory_pressure", timestamp, playbackPosition: fromPlayer.position(), ...sizes });
    heap.low = used;
  }
  return heap.snapshot;
}

function memoryForLog(force = true) {
  const snapshot = sampleHeap(force);
  const page = pageMemory.lastSample;
  if (!snapshot && !page && !pageMemory.supported) {
    return { pageMemorySupported: false, pageMemoryUnavailableReason: pageMemory.unavailableReason };
  }
  return {
    timestamp: snapshot?.timestamp ?? null,
    usedJSHeapSize: snapshot?.usedJSHeapSize ?? null,
    totalJSHeapSize: snapshot?.totalJSHeapSize ?? null,
    jsHeapSizeLimit: snapshot?.jsHeapSizeLimit ?? null,
    heapGrowthBytes: snapshot?.heapGrowthBytes ?? null,
    pageMemorySupported: pageMemory.supported,
    pageMemoryBytes: page?.bytes ?? null,
    pageMemoryMeasuredAt: page?.timestamp ?? null,
    pageMemorySampleAgeMs: page ? Math.max(0, Date.now() - page.timestamp) : null,
    pageMemoryMeasurementDurationMs: page?.durationMs ?? null,
    pageMemoryPlaybackSessionId: pageMemoryNotes.stream,
    pageMemoryCorrelationValid: page ? pageMemoryNotes.correlated && pageMemoryNotes.stream === loggedStream() : null,
  };
}

// The whole page's memory (measureUserAgentSpecificMemory, which needs
// cross-origin isolation), at most every 5 minutes. A measurement that
// outlived its stream says so, and the next is allowed sooner.
async function measurePageMemory() {
  if (!pageMemory.supported) {
    if (!pageMemoryNotes.unavailableLogged) {
      pageMemoryNotes.unavailableLogged = true;
      logPlayerEvent("page_memory_measurement_unavailable", {
        reason: pageMemory.unavailableReason,
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
      });
    }
    return;
  }
  const stream = loggedStream();
  const measured = state.player;
  try {
    const sample = await pageMemory.measure();
    if (!sample) return;
    const correlated = stream === loggedStream() && measured === state.player;
    Object.assign(pageMemoryNotes, { stream, correlated, lastError: null });
    if (!correlated) pageMemory.allowNextMeasurement();
    const stats = correlated ? readStats(measured) : null;
    logPlayerEvent("page_memory_measurement", {
      measurementPlaybackSessionId: stream,
      correlationValid: correlated,
      memory: sample,
      buffer: correlated ? bufferState(stats) : null,
      playerStats: correlated ? summarizeStats(stats) : null,
      totalStallCount: correlated ? stalls.count : null,
      totalStallDurationMs: correlated ? Math.round(stalls.totalMs) : null,
    });
  } catch (error) {
    const message = error?.message || String(error);
    if (message === pageMemoryNotes.lastError) return;
    pageMemoryNotes.lastError = message;
    logPlayerEvent("page_memory_measurement_failed", { error: message, measurementPlaybackSessionId: stream });
  }
}

// --- Stutter reports -----------------------------------------------------------

// Since the last report: the newest STUTTER_EVENTS_KEPT stalls, long tasks,
// and memory pressure, and the long tasks counted for the heartbeat.
const stutter = { startedAt: 0, events: [], longTasks: 0, longTasksAtHeartbeat: 0, queuedReason: null, queued: null };

function noteStutter(event) {
  stutter.events.push({ ...event, playbackPosition: Number((Number(event.playbackPosition) || 0).toFixed(3)) });
  if (stutter.events.length > STUTTER_EVENTS_KEPT) stutter.events.shift();
}

function flushStutter(reason) {
  if (!stutter.startedAt || (!stutter.events.length && !stalls.startedAt)) return;
  const now = performance.now();
  logPlayerEvent("stutter_report", {
    stutter: {
      reason,
      events: stutter.events,
      currentTime: fromPlayer.position(),
      duration: state.duration,
      memory: memoryForLog(true),
      buffer: bufferState(readStats(state.player)),
      totalStallCount: stalls.count,
      totalStallDurationMs: Math.round(stalls.totalMs + stalledMs(now)),
      timeSincePlaybackStartedMs: Math.round(Math.max(0, now - stutter.startedAt)),
    },
  });
  stutter.events = [];
}

function cancelQueuedStutterReport() {
  if (!stutter.queued) return;
  stutter.queued.cancel();
  stutter.queued = null;
  stutter.queuedReason = null;
}

// A report when the page is idle (within a second), for the most telling
// reason asked meanwhile: anything over the interval's own.
function queueStutterReport(reason) {
  if (!stutter.startedAt) return;
  if (reason !== "interval" || !stutter.queuedReason) stutter.queuedReason = reason;
  if (stutter.queued) return;
  const run = () => {
    const queued = stutter.queuedReason;
    stutter.queued = null;
    stutter.queuedReason = null;
    flushStutter(queued);
  };
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(run, { timeout: STUTTER_FLUSH_IDLE_TIMEOUT_MS });
    stutter.queued = { cancel: () => cancelIdleCallback(handle) };
  } else {
    const timer = setTimeout(run, 0);
    stutter.queued = { cancel: () => clearTimeout(timer) };
  }
}

let longTaskObserver = null;

function observeLongTasks() {
  if (longTaskObserver || typeof PerformanceObserver !== "function") return;
  if (Array.isArray(PerformanceObserver.supportedEntryTypes) && !PerformanceObserver.supportedEntryTypes.includes("longtask")) return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      const long = list.getEntries().filter((entry) => entry.duration >= LONG_TASK_MS);
      if (!long.length || !stutter.startedAt) return;
      for (const entry of long) {
        stutter.longTasks += 1;
        noteStutter({ type: "long_task", timestamp: Math.round(performance.timeOrigin + entry.startTime), playbackPosition: fromPlayer.position(), durationMs: Math.round(entry.duration) });
      }
      queueStutterReport("longtask");
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    longTaskObserver = null;
  }
}

// --- Heartbeat and decode health -------------------------------------------------

let decodePath = null;

function heartbeat() {
  const longTasks = stutter.longTasks - stutter.longTasksAtHeartbeat;
  stutter.longTasksAtHeartbeat = stutter.longTasks;
  void measurePageMemory();
  logPlayerEvent("health_heartbeat", {
    currentTime: fromPlayer.position(),
    viewport: describeViewport(),
    buffer: bufferState(readStats(state.player)),
    jankCountSinceLastHeartbeat: longTasks,
    memory: memoryForLog(true),
    decodePath,
    droppedFrames: droppedFrames(readStats(state.player)),
    // The danmaku layer since the last heartbeat: frames drawn, draw time, comments on screen.
    danmaku: fromPlayer.danmakuStats(),
  });
}

/** What decodes this stream (`decode_info`), and a change of path from the last (`decode_path_change`). */
export function noteDecodeInfo(decode) {
  if (decode?.path) {
    if (decodePath && decodePath !== decode.path) {
      logPlayerEvent("decode_path_change", { previousPath: decodePath, nextPath: decode.path, phase: decode.phase || null, buffer: bufferState(readStats(state.player)) });
    }
    decodePath = decode.path;
  }
  logPlayerEvent("decode_info", { decode });
}

// The engine's own decode path, its numbers, the picture, and the browser's
// decoders (`decode_info`).
function checkDecodeHealth(phase) {
  const engine = fromPlayer.engine();
  const stats = readStats(state.player);
  const buffer = bufferState(stats);
  const decode = {
    phase,
    path: engine.decodePath,
    playbackState: fromPlayer.playbackState(),
    currentTime: fromPlayer.position(),
    duration: state.duration,
    capabilities: CAPABILITIES,
    stats: summarizeStats(stats),
    bufferHealthSeconds: buffer.bufferHealthSeconds,
    droppedFrames: droppedFrames(stats),
    audio: { bufferedAudioMs: buffer.bufferedAudioMs, underrunCount: buffer.audioUnderrunCount },
    canvas: describeCanvas(fromPlayer.container),
    ...(engine.name === "native" ? { video: describeVideo(fromPlayer.container) } : {}),
    viewport: describeViewport(),
  };
  console.log("[player] Decode health:", decode);
  noteDecodeInfo(decode);
}

export const capabilities = () => CAPABILITIES;

// --- A stream's telemetry -----------------------------------------------------------

const timers = [];

function stopTimers() {
  for (const timer of timers.splice(0)) clearInterval(timer);
  cancelQueuedStutterReport();
}

/** A new stream: its counts start again, and nothing runs until start(). */
export function begin() {
  stopTimers();
  observeLongTasks();
  Object.assign(stalls, { count: 0, totalMs: 0, startedAt: 0 });
  Object.assign(heap, { sampledAt: 0, low: 0, snapshot: null });
  Object.assign(stutter, { startedAt: performance.now(), events: [], longTasks: 0, longTasksAtHeartbeat: 0 });
  decodePath = fromPlayer.engine().decodePath ?? null;
}

/** The stream plays, or a kept player shows again: the reports and checks run. */
export function start() {
  stopTimers();
  stutter.longTasksAtHeartbeat = stutter.longTasks;
  timers.push(
    setInterval(() => queueStutterReport("interval"), STUTTER_REPORT_INTERVAL_MS),
    setInterval(heartbeat, HEARTBEAT_INTERVAL_MS),
    setInterval(() => state.player && checkDecodeHealth("periodic-60s"), DECODE_HEALTH_INTERVAL_MS),
  );
}

/** The stream failed to start: nothing more runs for it. */
export function stop() {
  stopTimers();
}

/** The owner left the stream, or kept it behind the home screen: an open stall ends, and a last stutter report goes. */
export function end() {
  stallEnded();
  cancelQueuedStutterReport();
  flushStutter("stop");
  stopTimers();
}

// --- Wake to playback ------------------------------------------------------------

// The first report after a wake is the baseline; playback a second past it
// is the picture moving again.
let wakeBaseline = null;

/** Each progress report: whether playback is back after a wake (device-events.js). */
export function noteWakeProgress() {
  const events = deviceEvents();
  const wake = events.wakePending;
  if (!wake) {
    wakeBaseline = null;
    return;
  }
  const position = fromPlayer.position();
  if (!wakeBaseline || wakeBaseline.at !== wake.at) {
    wakeBaseline = { at: wake.at, position };
    return;
  }
  if (state.isPlaying && !state.isBuffering && position > wakeBaseline.position + 1) {
    events.markPlaybackRestored({ position: Number(position.toFixed(1)), baselinePosition: Number(wakeBaseline.position.toFixed(1)) });
    wakeBaseline = null;
  }
}
