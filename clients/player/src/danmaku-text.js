import { fontAt, FONT_FAMILY, LINE_PROBE, measureLine, paintComment, REFERENCE_PX } from "./danmaku-paint.js";

// Widths and bitmaps of danmaku comments (Agent Note 2026-10-13-danmaku):
// from the text worker (danmaku-worker.js) where the browser can draw text
// in a worker, else on the main thread, measured once per character and
// drawn when asked.

const FAMILIES = new Set(["Noto Sans SC", "Noto Sans", "Noto Sans JP", "Noto Sans KR"]);
const GLYPH_WAIT_MS = 3_000;

// The page's @font-face rules for the caption fonts, with absolute URLs, for
// the worker, which does not see the page's stylesheets.
function captionFontFaces() {
  const faces = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
      const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
      if (!FAMILIES.has(family)) continue;
      const base = sheet.href || location.href;
      const src = rule.style.getPropertyValue("src")
        .replace(/url\((["']?)([^"')]+)\1\)/g, (_, quote, url) => `url("${new URL(url, base).href}")`);
      const descriptors = {};
      for (const [property, name] of [["unicode-range", "unicodeRange"], ["font-weight", "weight"], ["font-style", "style"], ["font-display", "display"]]) {
        const value = rule.style.getPropertyValue(property);
        if (value) descriptors[name] = value;
      }
      faces.push({ family, src, descriptors });
    }
  }
  return faces;
}

function workerSupported() {
  return typeof Worker === "function" && typeof OffscreenCanvas === "function"
    && typeof OffscreenCanvas.prototype.transferToImageBitmap === "function" && typeof FontFace === "function";
}

// A worker that fails (it did not load) rejects what it was asked and
// everything after, and the caller moves to the main thread.
function workerRenderer() {
  const worker = new Worker(new URL("./danmaku-worker.js", import.meta.url), { type: "module", name: "danmaku-text" });
  const pending = new Map();
  let nextId = 0;
  let failure = null;
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    pending.delete(data.id);
    request?.resolve(data);
  };
  worker.onerror = (event) => {
    failure = new Error(event.message || "The danmaku text worker failed");
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    worker.terminate();
  };
  worker.postMessage({ type: "fonts", faces: captionFontFaces() });
  const ask = (message) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id });
  });
  return {
    metrics: async () => (await ask({ type: "metrics" })).metrics,
    measure: async (texts) => (await ask({ type: "measure", texts })).widths,
    draw: async (spec) => (await ask({ type: "draw", ...spec })).bitmap,
  };
}

// The fallback: the page's fonts, loaded for the characters first, and
// each character measured once.
function mainThreadRenderer() {
  const measuring = document.createElement("canvas").getContext("2d");
  measuring.font = fontAt(REFERENCE_PX);
  const characters = new Map();
  async function glyphs(text) {
    if (!document.fonts?.load) return;
    const loaded = document.fonts.load(`16px ${FONT_FAMILY}`, text).catch(() => {});
    await Promise.race([loaded, new Promise((done) => setTimeout(done, GLYPH_WAIT_MS))]);
  }
  return {
    async metrics() {
      await glyphs(LINE_PROBE);
      return measureLine(measuring);
    },
    async measure(texts) {
      await glyphs(texts.join(""));
      measuring.font = fontAt(REFERENCE_PX);
      return Float32Array.from(texts, (text) => {
        let sum = 0;
        for (const character of text) {
          let width = characters.get(character);
          if (width == null) {
            width = measuring.measureText(character).width / REFERENCE_PX;
            characters.set(character, width);
          }
          sum += width;
        }
        return sum;
      });
    },
    async draw(spec) {
      const canvas = document.createElement("canvas");
      canvas.width = spec.width;
      canvas.height = spec.height;
      paintComment(canvas.getContext("2d"), spec);
      return canvas;
    },
  };
}

/**
 * `metrics()` resolves to the caption font's line ink in ems (danmaku-paint.js);
 * `measure(texts)` to each text's width in ems; `draw({ text, color, px,
 * width, height, metrics })` to an image `width` x `height` device pixels.
 */
export function createTextRenderer() {
  let fallback = null;
  let current = null;
  const onPage = () => {
    fallback ??= mainThreadRenderer();
    current = fallback;
    return fallback;
  };
  if (workerSupported()) {
    try {
      current = workerRenderer();
    } catch (error) {
      console.warn("[danmaku] No text worker, drawing on the page:", error?.message || error);
    }
  }
  current ??= onPage();
  const call = (name) => async (argument) => {
    const renderer = current;
    try {
      return await renderer[name](argument);
    } catch (error) {
      if (renderer === fallback) throw error;
      console.warn("[danmaku] The text worker failed, drawing on the page:", error?.message || error);
      return onPage()[name](argument);
    }
  };
  return { metrics: call("metrics"), measure: call("measure"), draw: call("draw") };
}
