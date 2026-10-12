import { readFingerprintInput, teslaFingerprint } from "./device-fingerprint.js";

// Display size (owner request, 2026-10-12). Tesla software 2026.26 renders
// its browser at devicePixelRatio 1.53, which the owner finds too big; the
// community's <meta name="viewport" content="width=1183"> (1.0) is too
// small. So the page offers steps between them, as physical pixels per CSS
// pixel, applied with the viewport meta: width = round(physical width /
// scale). public/display-scale-boot.js applies the saved choice before the
// first layout and keeps the physical size measured before any change
// (window.__yoloDisplayBoot); this module picks the default, saves the
// owner's choice, reports what the browser did with it, and gives the
// player its physical viewport.

export const DISPLAY_SCALES = Object.freeze([1.53, 1.35, 1.25, 1.15, 1.0]);
// A Tesla on 2026.26 or later starts here until the owner picks a size.
export const TESLA_DEFAULT_SCALE = 1.25;
export const CHOICE_KEY = "yolo.displayScale";
export const AUTO_KEY = "yolo.displayScaleAuto";
const NATIVE_META = "width=device-width, initial-scale=1.0";
const REPORT_SETTLE_MS = 400;

/** The viewport meta width that shows `physicalWidth` pixels at `scale`. */
export function viewportWidthFor(physicalWidth, scale) {
  return Math.round(Number(physicalWidth) / Number(scale));
}

/** No scale, or the browser's own: nothing to change. */
export function isNativeScale(scale, devicePixelRatio) {
  return !(Number(scale) > 0) || Math.abs(Number(scale) - Number(devicePixelRatio)) < 0.005;
}

/**
 * The scale a device starts at without an owner's choice: 1.25 for a Tesla
 * on 2026.26 or later (its devicePixelRatio is about 1.53; older software
 * renders at 1.0 and is left alone), else none (native).
 */
export function defaultScale(fingerprint, devicePixelRatio) {
  return fingerprint?.tesla && Number(devicePixelRatio) >= 1.4 ? TESLA_DEFAULT_SCALE : null;
}

/** How big a step looks next to the browser's own size, for its label. */
export function scaleLabel(scale, devicePixelRatio) {
  if (isNativeScale(scale, devicePixelRatio)) return "100%";
  return `${Math.round((Number(scale) / Number(devicePixelRatio)) * 100)}%`;
}

/**
 * The window in physical pixels, for Yolo's choice of resolution: with a
 * display scale applied, the size measured before it changed anything, so a
 * smaller scale (a wider CSS layout) never asks for a bigger picture than
 * the screen has.
 */
export function physicalViewport(win = globalThis) {
  const boot = win.__yoloDisplayBoot;
  if (boot?.scale) return { width: boot.physicalWidth, height: boot.physicalHeight };
  const dpr = Number(win.devicePixelRatio) || 1;
  return { width: Math.round((Number(win.innerWidth) || 0) * dpr), height: Math.round((Number(win.innerHeight) || 0) * dpr) };
}

const parseScale = (value) => {
  const number = Number(value);
  return value != null && value !== "" && number >= 0.75 && number <= 3 ? number : null;
};

function storage(win) {
  return {
    get(key) {
      try {
        return win.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        win.localStorage?.setItem(key, value);
      } catch {
        // Private mode or full: the choice lasts for this page only.
      }
    },
  };
}

// What the boot script measured; measured now when it did not run.
function bootState(win) {
  if (win.__yoloDisplayBoot) return win.__yoloDisplayBoot;
  const dpr = Number(win.devicePixelRatio) || 1;
  win.__yoloDisplayBoot = {
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    devicePixelRatio: dpr,
    physicalWidth: Math.round(win.innerWidth * dpr),
    physicalHeight: Math.round(win.innerHeight * dpr),
    scale: null,
    width: null,
    source: "native",
  };
  return win.__yoloDisplayBoot;
}

/**
 * @param {object} [options]
 * @param {Window} [options.win]
 * @param {(type: string, fields: object) => void} [options.record]  telemetry
 * @param {(reason: string) => void} [options.onChange]  after a new scale settled
 */
export function createDisplayScale({ win = globalThis, record = () => {}, onChange = () => {} } = {}) {
  const boot = bootState(win);
  const store = storage(win);
  const nativeDpr = boot.devicePixelRatio;
  let reportTimer = null;

  function setMeta(content) {
    const meta = win.document?.querySelector('meta[name="viewport"]');
    if (meta) meta.setAttribute("content", content);
  }

  // What the browser made of it, once the layout settled: only width=1183
  // is known to work in the car, so check the others really apply.
  function report(reason) {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      const clientWidth = win.document?.documentElement?.clientWidth ?? null;
      record("display_scale", {
        reason,
        scale: boot.scale,
        nativeScale: nativeDpr,
        source: boot.source,
        width: boot.width,
        physicalWidth: boot.physicalWidth,
        physicalHeight: boot.physicalHeight,
        innerWidth: win.innerWidth,
        innerHeight: win.innerHeight,
        clientWidth,
        devicePixelRatio: Number(win.devicePixelRatio) || null,
        visualViewportScale: win.visualViewport?.scale ?? null,
        honoured: boot.width ? Math.abs(Number(clientWidth) - boot.width) <= 2 : null,
      });
      onChange(reason);
    }, REPORT_SETTLE_MS);
  }

  function apply(scale, source, reason) {
    const native = isNativeScale(scale, nativeDpr) || !boot.physicalWidth;
    const width = native ? null : viewportWidthFor(boot.physicalWidth, scale);
    const changed = width !== boot.width;
    boot.scale = native ? null : Number(scale);
    boot.width = width;
    boot.source = source;
    if (changed) setMeta(native ? NATIVE_META : `width=${width}`);
    if (changed || (reason === "boot" && boot.scale)) report(reason);
  }

  return {
    /** The steps to offer, labelled by size next to the browser's own. */
    options() {
      const activeScale = boot.scale ?? nativeDpr;
      const steps = DISPLAY_SCALES.filter((scale) => !isNativeScale(scale, nativeDpr));
      return [
        { value: "native", label: scaleLabel(null, nativeDpr), active: boot.scale == null },
        ...steps.map((scale) => ({ value: scale, label: scaleLabel(scale, nativeDpr), active: boot.scale != null && Math.abs(activeScale - scale) < 0.005 })),
      ].sort((a, b) => (b.value === "native" ? nativeDpr : b.value) - (a.value === "native" ? nativeDpr : a.value));
    },

    get state() {
      return { scale: boot.scale, width: boot.width, source: boot.source, nativeScale: nativeDpr };
    },

    // At startup: the default for a device without the owner's choice (a
    // Tesla on 2026.26+ gets 1.25), remembered so the boot script applies
    // it before the first layout next time. ?scale= wins for this page.
    init() {
      const fingerprint = teslaFingerprint(readFingerprintInput(win));
      const auto = defaultScale(fingerprint, nativeDpr);
      store.set(AUTO_KEY, auto ? String(auto) : "native");
      if (boot.source === "query" || boot.source === "owner") {
        if (boot.scale) report("boot");
        return;
      }
      apply(auto, auto ? "default" : "native", "boot");
    },

    /** The owner picked a size ("native" or a scale): save it and show it. */
    choose(value) {
      const scale = value === "native" ? null : parseScale(value);
      store.set(CHOICE_KEY, scale ? String(scale) : "native");
      apply(scale, "owner", "owner");
    },

    physicalViewport: () => physicalViewport(win),
  };
}
