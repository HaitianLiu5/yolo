// What web engines as old as Chromium 85, a 2022 Samsung TV's, lack that the
// player uses (Agent Note 2026-10-26-tv-web-client). main.js imports this
// first, so every other module finds these. Each fill is set only where the
// engine has none, and the build lowers the CSS (old-engine-css.js); newer
// browsers run none of it.

function define(target, name, value) {
  if (!(name in target)) Object.defineProperty(target, name, { value, writable: true, configurable: true });
}

function replaceChildren(...nodes) {
  while (this.lastChild) this.removeChild(this.lastChild);
  this.append(...nodes);
}

function at(index) {
  const n = Math.trunc(index) || 0;
  const i = n < 0 ? this.length + n : n;
  return i < 0 || i >= this.length ? undefined : this[i];
}

function findLast(test, thisArg) {
  for (let i = this.length - 1; i >= 0; i--) if (test.call(thisArg, this[i], i, this)) return this[i];
  return undefined;
}

function findLastIndex(test, thisArg) {
  for (let i = this.length - 1; i >= 0; i--) if (test.call(thisArg, this[i], i, this)) return i;
  return -1;
}

/** Installs the fills on `win` where they are missing. */
export function fillOldEngine(win = globalThis) {
  for (const type of [win.Element, win.Document, win.DocumentFragment]) if (type) define(type.prototype, "replaceChildren", replaceChildren);
  const indexed = [win.Array, win.String, Object.getPrototypeOf(win.Int8Array ?? Object)];
  for (const type of indexed) if (type?.prototype) define(type.prototype, "at", at);
  define(win.Array.prototype, "findLast", findLast);
  define(win.Array.prototype, "findLastIndex", findLastIndex);
  define(win.Object, "hasOwn", (object, key) => Object.prototype.hasOwnProperty.call(object, key));
  // Only plain data is cloned in the player: what the Hub sent and settings.
  define(win, "structuredClone", (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value))));
  if (win.AbortSignal) {
    define(win.AbortSignal, "timeout", (ms) => {
      const controller = new win.AbortController();
      setTimeout(() => controller.abort(new win.DOMException("signal timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    define(win.AbortSignal, "any", (signals) => {
      const controller = new win.AbortController();
      for (const signal of signals) {
        if (signal.aborted) {
          controller.abort(signal.reason);
          break;
        }
        signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
      }
      return controller.signal;
    });
  }
}

// aspect-ratio (Chrome 88): the build writes each rule's ratio beside it as
// --yolo-aspect-ratio, which the engine keeps though it drops aspect-ratio.
// Each box a rule with it matches gets the height its width and the ratio
// that applies to it (its computed --yolo-aspect-ratio) give.
const RATIO = "--yolo-aspect-ratio";

function ratioSelectors(sheets, { media, supports }) {
  const selectors = [];
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.style?.getPropertyValue(RATIO)) selectors.push(rule.selectorText);
      else if (rule.media && rule.cssRules) {
        if (media(rule.media.mediaText)) walk(rule.cssRules);
      } else if (rule.conditionText !== undefined && rule.cssRules && supports(rule.conditionText)) walk(rule.cssRules);
    }
  };
  for (const sheet of sheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // Another origin's sheet (none today) cannot be read.
    }
  }
  return selectors;
}

export function sizeByRatio(win = window) {
  const doc = win.document;
  const sized = new WeakSet();
  const resize = new win.ResizeObserver((entries) => {
    for (const { target, contentRect } of entries) {
      const ratio = Number.parseFloat(win.getComputedStyle(target).getPropertyValue(RATIO));
      if (!(ratio > 0) || !contentRect.width) continue;
      const height = `${Math.round(contentRect.width / ratio)}px`;
      if (target.style.height !== height) target.style.height = height;
    }
  });
  let selectors = [];
  const collect = () => {
    selectors = ratioSelectors(doc.styleSheets, {
      media: (text) => !text || win.matchMedia(text).matches,
      supports: (text) => win.CSS.supports(text),
    });
  };
  const watch = () => {
    for (const selector of selectors) {
      for (const element of doc.querySelectorAll(selector)) {
        if (sized.has(element)) continue;
        sized.add(element);
        resize.observe(element);
      }
    }
  };
  let pending = false;
  const later = () => {
    if (pending) return;
    pending = true;
    win.requestAnimationFrame(() => {
      pending = false;
      watch();
    });
  };
  collect();
  watch();
  new win.MutationObserver(later).observe(doc.body, { childList: true, subtree: true });
  // Read the sheets again once they have all loaded, and when the window's
  // size changes which @media rules apply.
  for (const type of ["load", "resize"]) {
    win.addEventListener(type, () => {
      collect();
      later();
    });
  }
}

fillOldEngine();
if (typeof window !== "undefined" && !window.CSS?.supports?.("aspect-ratio", "1")) sizeByRatio();
