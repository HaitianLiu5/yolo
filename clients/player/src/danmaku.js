import { DanmakuLayout, danmakuGeometry, spanOf } from "./danmaku-layout.js";
import { DEFAULT_METRICS, OUTLINE_PX } from "./danmaku-paint.js";
import { createTextRenderer } from "./danmaku-text.js";
import { requestJson } from "./network.js";
import { subtitlePictureBounds } from "./subtitle-layout.js";

// Danmaku over the picture (Agent Note 2026-10-13-danmaku): one <canvas>
// above either engine's picture and below the subtitles, drawn from the
// engine's own position, so it follows pause, seeks, the playback rate, and
// stream rebuilds without timers of its own.
//
// The car's canvas engine presents video frames on the page's main thread,
// so this layer keeps its work there small and even:
// - Text is measured and drawn in a worker (danmaku-text.js): each comment's
//   width once, when its window of comments arrives, and its picture once,
//   into an ImageBitmap, the first time it is on screen (it shows from the
//   next frame on). A frame is a clear and one drawImage per comment.
// - No DOM reads per frame: sizes are read when the window, the picture,
//   the display size, or the settings change.
// - The text size follows the picture's height and lanes are whole device
//   pixels tall: the caption font's ink at the text size, with its outline
//   and a gap (danmakuGeometry in danmaku-layout.js), at the device's pixel
//   ratio times the car's CSS zoom. A comment's bitmap is exactly its lanes'
//   height, so no comment draws into another's lane.
// - The animation frame runs only while comments are shown, the page is
//   visible, and the position moves; a pause draws one frame and stops it.
// - With an engine that counts the video frames it draws (the canvas
//   engine's `presentedFrames`), comments move when the picture does, so the
//   page still updates at the video's frame rate rather than the display's.
//
// Comments come from the media session's `comments` URL (the node's
// origin, or Yolo's own through the relay), a window of WINDOW_SECONDS at a
// time around the position.

export const WINDOW_SECONDS = 360;
// The next window is read this long before the position reaches it.
const PREFETCH_SECONDS = 30;
const RETRY_MS = 30_000;
const MAX_WINDOWS = 8;
const FETCH_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Bitmaps asked of the text worker and not back yet, at most.
const MAX_DRAWING = 48;
const MAX_BITMAPS = 300;
const MAX_BITMAP_PIXELS = 6_000_000;
// Backing pixels per CSS pixel at most: text stays sharp, and a phone's 3x
// screen does not fill three times the pixels.
const MAX_PIXEL_RATIO = 2;
// Frames without a new position before the loop stops (paused, buffering).
const IDLE_FRAMES = 20;
const MIN_STEP_SECONDS = 1 / 15;
// A draw longer than this counts as slow in the stats (a third of a 60 Hz frame).
const SLOW_FRAME_MS = 5;

function mergeByTime(left, right) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) out.push(left[i].t <= right[j].t ? left[i++] : right[j++]);
  while (i < left.length) out.push(left[i++]);
  while (j < right.length) out.push(right[j++]);
  return out;
}

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas  the layer, inside #app over #player-container
 * @param {HTMLElement} options.playerContainer
 * @param {() => number | null} options.getTime  the playing engine's position, or null
 * @param {() => number | null} [options.getFrames]  video frames the engine has drawn, or null when it does not count them
 * @param {{ get: () => object, subscribe: Function }} options.settings  danmaku-settings.js
 * @param {(available: boolean) => void} [options.onAvailability]  whether this item has comments
 */
export function createDanmaku({ canvas, playerContainer, getTime, getFrames = () => null, settings, onAvailability = () => {} }) {
  const context = canvas.getContext("2d");
  const text = createTextRenderer();

  const item = { key: null, url: null, live: false, available: null, windows: new Map(), comments: [], controller: null };
  let subtitles = false;
  let geometry = null; // { left, top, width, height, ratio, fontPx, laneDevice, laneHeight, fraction }
  let metrics = DEFAULT_METRICS; // the caption font's line ink, once the text worker measured it
  let generation = 0; // goes up when the font size or the pixel ratio changes
  const bitmaps = new Map(); // key → { image, pixels } | { pending: true }
  let bitmapPixels = 0;
  let drawing = 0;
  let frame = 0;
  let parked = false; // the player is kept behind the home screen (hide)
  let idle = 0;
  let lastTime = null; // the position last drawn
  let seenTime = null; // the position last read
  let lastFrames = null;
  let dirty = true;
  let drawn = false;
  const stats = { frames: 0, drawMs: 0, maxDrawMs: 0, slowFrames: 0, maxOnScreen: 0, bitmapsDrawn: 0 };

  // A comment's width in CSS pixels, its outline included, from its width in
  // ems that the text worker measured when its window arrived.
  const measure = (comment) => Math.ceil((comment.em ?? [...comment.text].length) * geometry.fontPx * (comment.size || 1) + 2 * OUTLINE_PX);
  const layout = new DanmakuLayout({ measure });

  // A new font size or pixel ratio: every bitmap is wrong, and so are the
  // lanes' sizes.
  function clearBitmaps() {
    generation += 1;
    for (const entry of bitmaps.values()) entry.image?.close?.();
    bitmaps.clear();
    bitmapPixels = 0;
    layout.reset();
    dirty = true;
  }

  function keep(key, entry) {
    bitmaps.set(key, entry);
    bitmapPixels += entry.pixels;
    for (const [oldKey, old] of bitmaps) {
      if (bitmaps.size <= MAX_BITMAPS && bitmapPixels <= MAX_BITMAP_PIXELS) break;
      if (oldKey === key || old.pending) continue;
      old.image.close?.();
      bitmapPixels -= old.pixels;
      bitmaps.delete(oldKey);
    }
  }

  // The comment's bitmap, or null while the text worker draws it.
  function bitmapFor(comment) {
    const key = `${comment.text}\u0000${comment.color}\u0000${comment.size || 1}`;
    const known = bitmaps.get(key);
    if (known) {
      if (known.pending) return null;
      bitmaps.delete(key);
      bitmaps.set(key, known);
      return known.image;
    }
    if (drawing >= MAX_DRAWING) return null;
    const { ratio, fontPx, laneDevice } = geometry;
    const size = comment.size || 1;
    const width = Math.max(1, Math.ceil(measure(comment) * ratio));
    const height = spanOf(comment) * laneDevice;
    const asked = generation;
    bitmaps.set(key, { pending: true, pixels: 0 });
    drawing += 1;
    text.draw({ text: comment.text, color: comment.color || "#ffffff", px: fontPx * size * ratio, outline: OUTLINE_PX * ratio, width, height, metrics })
      .then((image) => {
        if (bitmaps.get(key)?.pending) bitmaps.delete(key);
        if (asked !== generation) {
          image.close?.();
          return;
        }
        keep(key, { image, pixels: width * height });
        stats.bitmapsDrawn += 1;
        dirty = true;
        wake();
      }, (error) => {
        if (bitmaps.get(key)?.pending) bitmaps.delete(key);
        console.warn("[danmaku] A comment could not be drawn:", error?.message || error);
      })
      .finally(() => {
        drawing -= 1;
      });
    return null;
  }

  // --- Geometry ------------------------------------------------------------

  const shown = () => settings.get().enabled && item.available === true && !item.live;

  function pictureSize() {
    const picture = playerContainer.querySelector("[data-engine]");
    if (picture && "videoWidth" in picture) return { width: picture.videoWidth || 0, height: picture.videoHeight || 0 };
    return { width: picture?.width || 0, height: picture?.height || 0 };
  }

  // Reads the layout: only when something changed size, never per frame.
  function measureGeometry() {
    const containerWidth = playerContainer.clientWidth;
    const containerHeight = playerContainer.clientHeight;
    if (!containerWidth || !containerHeight) {
      geometry = null;
      return;
    }
    const picture = pictureSize();
    const bounds = subtitlePictureBounds(containerWidth, containerHeight, picture.width, picture.height);
    // CSS zoom (the car's display size): the container's on-screen width over its CSS width.
    const zoom = playerContainer.getBoundingClientRect().width / containerWidth || 1;
    const ratio = Math.min(MAX_PIXEL_RATIO, (globalThis.devicePixelRatio || 1) * zoom);
    const width = Math.round(bounds.width);
    const height = Math.round(bounds.height);
    const { fontPx, laneDevice, laneHeight, fraction, areaHeight } = danmakuGeometry({ width, height, ratio, metrics, settings: settings.get(), subtitles });
    const next = {
      left: Math.round((containerWidth - bounds.width) / 2),
      top: Math.round((containerHeight - bounds.height) / 2),
      width,
      height,
      ratio,
      fontPx,
      laneDevice,
      laneHeight,
    };
    const changed = !geometry || ["left", "top", "width", "height", "ratio", "fontPx", "laneDevice"].some((key) => geometry[key] !== next[key]);
    if (!changed && geometry.fraction === fraction) return;
    if (!geometry || geometry.ratio !== next.ratio || geometry.fontPx !== next.fontPx || geometry.laneDevice !== next.laneDevice) {
      geometry = { ...next, fraction };
      clearBitmaps();
    } else {
      geometry = { ...next, fraction };
    }
    // The layer covers only the part of the picture comments use.
    canvas.style.left = `${next.left}px`;
    canvas.style.top = `${next.top}px`;
    canvas.style.width = `${next.width}px`;
    canvas.style.height = `${areaHeight}px`;
    canvas.width = Math.max(1, Math.round(next.width * ratio));
    canvas.height = Math.max(1, Math.ceil(areaHeight * ratio));
    // Bitmaps are drawn at whole device pixels and their own size.
    context.imageSmoothingEnabled = false;
    drawn = false;
    layout.setGeometry({ width: next.width, height: areaHeight, laneHeight });
    dirty = true;
  }

  // --- Drawing -------------------------------------------------------------

  function clearCanvas() {
    if (!drawn) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawn = false;
  }

  function draw(time) {
    const started = performance.now();
    const active = layout.update(time);
    clearCanvas();
    if (active.length) {
      const { ratio } = geometry;
      for (const entry of active) {
        // A comment that waits for a lane (high density) is not on screen yet.
        if (entry.t > time) continue;
        const x = layout.x(entry, time);
        if (x >= geometry.width || x + entry.width <= 0) continue;
        const image = bitmapFor(entry.comment);
        if (image) context.drawImage(image, Math.round(x * ratio), entry.lane * geometry.laneDevice);
      }
      drawn = true;
    }
    const elapsed = performance.now() - started;
    stats.frames += 1;
    stats.drawMs += elapsed;
    stats.maxDrawMs = Math.max(stats.maxDrawMs, elapsed);
    if (elapsed > SLOW_FRAME_MS) stats.slowFrames += 1;
    stats.maxOnScreen = Math.max(stats.maxOnScreen, active.length);
  }

  function drawAt(time, frames) {
    ensureWindows(time);
    draw(time);
    lastTime = time;
    lastFrames = frames;
    dirty = false;
  }

  function tick() {
    frame = 0;
    if (!shown() || document.visibilityState === "hidden" || !geometry) {
      clearCanvas();
      return;
    }
    const time = getTime();
    if (time == null || !Number.isFinite(time)) {
      if (++idle < IDLE_FRAMES) frame = requestAnimationFrame(tick);
      return;
    }
    if (time !== seenTime || dirty) {
      seenTime = time;
      idle = 0;
      // Between two video frames the picture holds still, and so do the
      // comments; without frames (audio only, a stall) they move at least
      // MIN_STEP_SECONDS apart.
      const frames = getFrames();
      if (dirty || frames == null || frames !== lastFrames || lastTime == null || time < lastTime || time - lastTime >= MIN_STEP_SECONDS) {
        drawAt(time, frames);
      }
    } else if (++idle >= IDLE_FRAMES) {
      // Still: show exactly where the position stopped, and rest.
      if (time !== lastTime) drawAt(time, getFrames());
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  // Run the loop again after something changed: a new position, a state
  // change, a setting, a size.
  function wake() {
    if (parked) return;
    canvas.hidden = !shown();
    idle = 0;
    if (frame || !shown()) {
      if (!shown()) clearCanvas();
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  // --- Comments --------------------------------------------------------------

  function setAvailable(available) {
    if (item.available === available) return;
    item.available = available;
    onAvailability(available);
    if (available && !geometry) measureGeometry();
    wake();
  }

  function rebuildComments() {
    let merged = [];
    for (const index of [...item.windows.keys()].sort((a, b) => a - b)) {
      const entry = item.windows.get(index);
      if (entry.comments?.length) merged = mergeByTime(merged, entry.comments);
    }
    item.comments = merged;
    layout.setComments(merged);
    dirty = true;
  }

  async function fetchWindow(index) {
    const key = item.key;
    const entry = { state: "loading", at: Date.now(), comments: item.windows.get(index)?.comments ?? [] };
    item.windows.set(index, entry);
    const url = new URL(item.url);
    url.searchParams.set("start", String(index * WINDOW_SECONDS));
    url.searchParams.set("end", String((index + 1) * WINDOW_SECONDS));
    try {
      const { ok, status, data } = await requestJson(url.href, { signal: item.controller.signal }, {
        label: "Comments", timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES,
      });
      if (item.key !== key) return;
      if (!ok) throw new Error(`Comments answered ${status}`);
      if (data?.available === false) {
        entry.state = "done";
        setAvailable(false);
        return;
      }
      const comments = Array.isArray(data?.comments) ? data.comments : [];
      // Widths first (the text worker loads the fonts they need), so the
      // layout never measures text in a frame.
      const ems = await text.measure(comments.map((comment) => comment.text));
      if (item.key !== key) return;
      comments.forEach((comment, position) => {
        comment.em = ems[position];
      });
      entry.comments = comments;
      entry.state = data?.complete === false ? "failed" : "done";
      entry.at = Date.now();
      rebuildComments();
      setAvailable(true);
    } catch (error) {
      if (item.key !== key || item.controller.signal.aborted) return;
      entry.state = "failed";
      entry.at = Date.now();
      console.warn("[danmaku] Comments failed:", error?.message || error);
    }
  }

  function ensureWindows(time) {
    if (!item.url || item.live || item.available === false) return;
    const index = Math.floor(Math.max(0, time) / WINDOW_SECONDS);
    const last = time - index * WINDOW_SECONDS > WINDOW_SECONDS - PREFETCH_SECONDS ? index + 1 : index;
    for (let want = index; want <= last; want += 1) {
      const known = item.windows.get(want);
      if (known && (known.state !== "failed" || Date.now() - known.at < RETRY_MS)) continue;
      void fetchWindow(want);
    }
    if (item.windows.size > MAX_WINDOWS) {
      const far = [...item.windows.keys()].sort((a, b) => Math.abs(b - index) - Math.abs(a - index));
      for (const old of far.slice(0, item.windows.size - MAX_WINDOWS)) item.windows.delete(old);
      rebuildComments();
    }
  }

  // --- Wiring ----------------------------------------------------------------

  new ResizeObserver(() => {
    measureGeometry();
    wake();
  }).observe(playerContainer);
  // The picture's size arrives with the engine's element or its metadata.
  new MutationObserver(() => {
    measureGeometry();
    wake();
  }).observe(playerContainer, { childList: true, subtree: true, attributes: true, attributeFilter: ["width", "height"] });
  for (const type of ["loadedmetadata", "resize"]) {
    playerContainer.addEventListener(type, () => {
      measureGeometry();
      wake();
    }, true);
  }
  document.addEventListener("visibilitychange", wake);
  // The layer's opacity: the compositor applies it once, so each comment is
  // a plain copy.
  const applySettings = () => {
    layout.setDensity(settings.get().density);
    canvas.style.opacity = String(settings.get().opacity);
  };
  settings.subscribe(() => {
    applySettings();
    measureGeometry();
    dirty = true;
    wake();
  });
  applySettings();

  // The caption font's line, measured once: lanes and bitmaps follow it.
  void text.metrics().then((measured) => {
    metrics = measured;
    geometry = null;
    measureGeometry();
    wake();
  }, (error) => console.warn("[danmaku] The caption font could not be measured:", error?.message || error));

  return {
    /**
     * A stream started at `start` seconds: `url` is its comments URL
     * (absolute), or null when its source has none.
     */
    load({ key, url, live = false, start = 0 }) {
      parked = false;
      if (key !== item.key) {
        item.controller?.abort();
        item.controller = new AbortController();
        item.key = key;
        item.windows = new Map();
        item.comments = [];
        layout.setComments([]);
        // Comments from before the stream's start never show.
        layout.restart(Number(start) || 0);
        lastTime = null;
        if (item.available !== null) {
          item.available = null;
          onAvailability(false);
        }
      }
      // The same item in a new stream (a seek, a recovery, another quality)
      // keeps its comments; failed windows are asked again at the new URL.
      item.url = url;
      item.live = live;
      if (!url || live) setAvailable(false);
      const time = getTime();
      if (url && !live) ensureWindows(Number.isFinite(time) ? time : Number(start) || 0);
      measureGeometry();
      wake();
    },

    /**
     * The player is kept behind the home screen: nothing is drawn, and the
     * item's comments stay for when it shows again (sync wakes it).
     */
    hide() {
      parked = true;
      cancelAnimationFrame(frame);
      frame = 0;
      clearCanvas();
      canvas.hidden = true;
    },

    /** Playback left: forget the item. */
    unload() {
      parked = false;
      item.controller?.abort();
      item.controller = null;
      item.key = null;
      item.url = null;
      item.windows = new Map();
      item.comments = [];
      layout.setComments([]);
      layout.restart();
      lastTime = null;
      if (item.available !== null) {
        item.available = null;
        onAvailability(false);
      }
      clearCanvas();
      canvas.hidden = true;
    },

    /** The position moved or the playback state changed. */
    sync(time) {
      parked = false;
      if (Number.isFinite(time)) ensureWindows(time);
      wake();
    },

    /** Subtitles show at the bottom of the picture: keep that band free. */
    setSubtitles(active) {
      if (subtitles === Boolean(active)) return;
      subtitles = Boolean(active);
      measureGeometry();
      wake();
    },

    resize() {
      measureGeometry();
      wake();
    },

    get available() {
      return item.available === true;
    },

    get running() {
      return frame !== 0;
    },

    /**
     * What the last frame showed, for diagnostics: each comment's text, mode,
     * and box (x, y, width, height) in CSS pixels of the picture.
     */
    onScreen() {
      if (!drawn || lastTime == null || !geometry) return [];
      return layout.active
        .filter((entry) => entry.t <= lastTime)
        .map((entry) => ({ text: entry.comment.text, mode: entry.mode, ...layout.position(entry, lastTime), width: entry.width, height: entry.span * geometry.laneHeight }))
        .filter((entry) => entry.x < geometry.width && entry.x + entry.width > 0);
    },

    /** The layer's rectangle in its container's CSS pixels, and the lanes' area. */
    get geometry() {
      return geometry ? { ...geometry, lanes: layout.laneCount } : null;
    },

    /** For telemetry: what the layer did since the last call. */
    stats() {
      const snapshot = {
        enabled: settings.get().enabled,
        available: item.available === true,
        comments: item.comments.length,
        frames: stats.frames,
        avgDrawMs: stats.frames ? Math.round((stats.drawMs / stats.frames) * 100) / 100 : 0,
        maxDrawMs: Math.round(stats.maxDrawMs * 100) / 100,
        slowFrames: stats.slowFrames,
        bitmapsDrawn: stats.bitmapsDrawn,
        maxOnScreen: stats.maxOnScreen,
        bitmaps: bitmaps.size,
      };
      Object.assign(stats, { frames: 0, drawMs: 0, maxDrawMs: 0, slowFrames: 0, maxOnScreen: 0, bitmapsDrawn: 0 });
      return snapshot;
    },
  };
}
