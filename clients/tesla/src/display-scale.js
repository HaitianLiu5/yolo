// Display size (Agent Note 2026-10-11-display-size). Tesla software 2026.26
// renders its browser at devicePixelRatio 1.53, which the owner finds too
// big; the community's <meta name="viewport" content="width=1183"> (1.0) is
// too small. So the car offers steps between them, as physical pixels per
// CSS pixel, applied with the viewport meta: width = round(physical width /
// scale). public/display-scale-boot.js applies the saved choice before the
// first layout and keeps the physical size measured before any change
// (window.__yoloDisplayBoot); this module picks the default, saves the
// owner's choice, reports what the browser did with it, and gives the
// player its physical viewport.
//
// Only the car offers a size (`eligible`: the car profile at a pixel ratio
// of 1.4 or more). Elsewhere the page keeps the browser's own scale and
// ignores a saved choice: a computer's or phone's browser zooms by itself,
// and a viewport width there would break the responsive layout.

export const DISPLAY_SCALES = Object.freeze([1.0, 1.15, 1.25, 1.35]);
// A car starts here until the owner picks a size.
export const TESLA_DEFAULT_SCALE = 1.25;
// Tesla software before 2026.26 renders at 1.0 and is left alone.
export const MIN_SCALED_DPR = 1.4;
export const CHOICE_KEY = "yolo.displayScale";
// The default for this device, or "native" where no size is offered; the
// boot script reads it to know whether a saved choice applies.
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

/** Whether this device offers a display size. */
export function isEligible({ car = false, devicePixelRatio = 1 } = {}) {
  return Boolean(car) && Number(devicePixelRatio) >= MIN_SCALED_DPR;
}

/**
 * The sizes to offer, the smallest look first: a smaller scale shows each
 * CSS pixel with fewer physical pixels. The largest is the browser's own.
 */
export function scaleSteps(devicePixelRatio) {
  const native = Number(devicePixelRatio) || 1;
  return [...DISPLAY_SCALES.filter((scale) => scale < native - 0.005), native];
}

/** "Smallest", "Smaller", "Default", "Larger", "Largest" around the default. */
export function sizeLabel(index, defaultIndex, count) {
  if (index === defaultIndex) return "Default";
  if (index < defaultIndex) return index === 0 ? "Smallest" : "Smaller";
  return index === count - 1 ? "Largest" : "Larger";
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
 * @param {boolean} [options.eligible]  whether this device offers a size (isEligible)
 * @param {(type: string, fields: object) => void} [options.record]  telemetry
 * @param {(reason: string) => void} [options.onChange]  after a new scale settled
 */
export function createDisplayScale({ win = globalThis, eligible: initiallyEligible = false, record = () => {}, onChange = () => {} } = {}) {
  const boot = bootState(win);
  const store = storage(win);
  const nativeDpr = boot.devicePixelRatio;
  let eligible = Boolean(initiallyEligible);
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

  // The owner's saved choice: a scale, "native", or null for none.
  function savedChoice() {
    const value = store.get(CHOICE_KEY);
    if (value === "native") return "native";
    return parseScale(value);
  }

  // Bring the page in line with `eligible`; `reason` is for the report.
  function settle(reason) {
    store.set(AUTO_KEY, eligible ? String(TESLA_DEFAULT_SCALE) : "native");
    if (boot.source === "query") {
      if (reason === "boot" && boot.scale) report("boot");
      return;
    }
    if (!eligible) {
      apply(null, "native", reason);
      return;
    }
    const choice = savedChoice();
    if (choice) apply(choice === "native" ? null : choice, "owner", reason);
    else apply(TESLA_DEFAULT_SCALE, "default", reason);
  }

  return {
    get eligible() {
      return eligible;
    },

    /** The sizes to offer, smallest look first, with their labels. */
    options() {
      const steps = scaleSteps(nativeDpr);
      const defaultIndex = Math.max(0, steps.findIndex((scale) => Math.abs(scale - TESLA_DEFAULT_SCALE) < 0.005));
      const active = boot.scale ?? nativeDpr;
      return steps.map((scale, index) => ({
        value: isNativeScale(scale, nativeDpr) ? "native" : scale,
        scale,
        label: sizeLabel(index, defaultIndex, steps.length),
        isDefault: index === defaultIndex,
        active: Math.abs(active - scale) < 0.005,
      }));
    },

    get state() {
      return { scale: boot.scale, width: boot.width, source: boot.source, nativeScale: nativeDpr, eligible };
    },

    // At startup: the owner's choice or the default on a device that offers
    // a size, remembered so the boot script applies it before the first
    // layout next time; the browser's own scale elsewhere. ?scale= wins for
    // this page.
    init() {
      settle("boot");
    },

    // The profile changed (Yolo said this device is, or is not, the car).
    setEligible(next) {
      if (Boolean(next) === eligible) return;
      eligible = Boolean(next);
      settle("eligibility");
    },

    /** The owner picked a size ("native" or a scale): save it and show it. */
    choose(value) {
      if (!eligible) return;
      const scale = value === "native" ? null : parseScale(value);
      store.set(CHOICE_KEY, scale ? String(scale) : "native");
      apply(scale, "owner", "owner");
    },

    physicalViewport: () => physicalViewport(win),
  };
}
