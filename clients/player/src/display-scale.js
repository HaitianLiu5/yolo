// Display size (Agent Note 2026-10-11-display-size). Tesla software 2026.26
// renders its browser at devicePixelRatio 1.53, which the owner finds too
// big; one CSS pixel per physical pixel (1.0) is too small. So the car
// offers steps between them, as physical pixels per CSS pixel, applied with
// CSS `zoom` on the root element: zoom = scale / the browser's own
// devicePixelRatio. The car's Chrome ignores <meta name="viewport">.
//
// Zoom changes neither innerWidth nor devicePixelRatio, so the window's
// physical size stays innerWidth x devicePixelRatio at every size. Inside
// the zoomed root a CSS pixel is `scale` physical pixels: the page lays out
// innerWidth / zoom CSS px wide (946 at 1.25 in a 773 px window), and the
// stylesheet sizes against #app with container units (cqw, cqh) because
// vw and vh still measure the unzoomed window. getBoundingClientRect() and
// pointer coordinates share the window's coordinates, so hit tests that
// compare them need no correction.
//
// public/display-scale-boot.js applies the saved choice before the first
// layout (window.__yoloDisplayBoot); this module picks the default, saves
// the owner's choice, and reports what the browser did with it.
//
// Only the car offers a size (`eligible`: the car profile at a pixel ratio
// of 1.4 or more). Elsewhere the page keeps the browser's own scale and
// ignores a saved choice: a computer's or phone's browser zooms by itself.

export const DISPLAY_SCALES = Object.freeze([1.0, 1.15, 1.25, 1.35]);
// A car starts here until the owner picks a size.
const CAR_DEFAULT_SCALE = 1.25;
// Tesla software before 2026.26 renders at 1.0 and is left alone.
export const MIN_SCALED_DPR = 1.4;
export const CHOICE_KEY = "yolo.displayScale";
// The default for this device, or "native" where no size is offered; the
// boot script reads it to know whether a saved choice applies.
export const AUTO_KEY = "yolo.displayScaleAuto";
const REPORT_SETTLE_MS = 400;

/** The root zoom that shows each CSS pixel with `scale` physical pixels. */
function zoomFor(scale, devicePixelRatio) {
  const dpr = Number(devicePixelRatio) || 1;
  if (isNativeScale(scale, dpr)) return 1;
  return Math.round((Number(scale) / dpr) * 10_000) / 10_000;
}

/** The CSS width the page lays out at `zoom` in a window `innerWidth` wide. */
function layoutWidthFor(innerWidth, zoom) {
  return Math.round(Number(innerWidth) / (Number(zoom) || 1));
}

/** No scale, or the browser's own: nothing to change. */
function isNativeScale(scale, devicePixelRatio) {
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
function scaleSteps(devicePixelRatio) {
  const native = Number(devicePixelRatio) || 1;
  return [...DISPLAY_SCALES.filter((scale) => scale < native - 0.005), native];
}

/** "Smallest", "Smaller", "Default", "Larger", "Largest" around the default. */
function sizeLabel(index, defaultIndex, count) {
  if (index === defaultIndex) return "Default";
  if (index < defaultIndex) return index === 0 ? "Smallest" : "Smaller";
  return index === count - 1 ? "Largest" : "Larger";
}

/**
 * The window in physical pixels, for Yolo's choice of resolution. Zoom
 * leaves innerWidth and devicePixelRatio alone, so this holds at every
 * display size and after the window changes size.
 */
export function physicalViewport(win = globalThis) {
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

// What the boot script applied; a fresh state when it did not run.
function bootState(win) {
  if (win.__yoloDisplayBoot) return win.__yoloDisplayBoot;
  win.__yoloDisplayBoot = {
    devicePixelRatio: Number(win.devicePixelRatio) || 1,
    scale: null,
    zoom: 1,
    width: null,
    source: "native",
  };
  return win.__yoloDisplayBoot;
}

/**
 * What the page's layout shows now: the zoom the browser applied (the body's
 * on-screen width over its CSS width) and the CSS size the page lays out at.
 */
function measureLayout(win = globalThis) {
  const root = win.document?.body ?? win.document?.documentElement;
  const cssWidth = Number(root?.clientWidth) || 0;
  const cssHeight = Number(root?.clientHeight) || 0;
  const screenWidth = Number(root?.getBoundingClientRect?.().width) || 0;
  const appliedZoom = cssWidth > 0 && screenWidth > 0 ? Math.round((screenWidth / cssWidth) * 1000) / 1000 : null;
  return { layoutWidth: cssWidth || null, layoutHeight: cssHeight || null, appliedZoom };
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

  function setZoom(zoom) {
    const style = win.document?.documentElement?.style;
    if (!style) return;
    if (zoom === 1) style.removeProperty("zoom");
    else style.setProperty("zoom", String(zoom));
  }

  // What the browser made of it, once the layout settled: `honoured` says
  // whether the page really lays out `width` CSS px wide.
  function report(reason) {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      const measured = measureLayout(win);
      const physical = physicalViewport(win);
      // The window may have changed size (fullscreen) since the zoom applied.
      boot.width = boot.zoom === 1 ? null : layoutWidthFor(win.innerWidth, boot.zoom);
      record("display_scale", {
        reason,
        method: "zoom",
        scale: boot.scale,
        nativeScale: nativeDpr,
        source: boot.source,
        zoom: boot.zoom,
        appliedZoom: measured.appliedZoom,
        width: boot.width,
        layoutWidth: measured.layoutWidth,
        layoutHeight: measured.layoutHeight,
        physicalWidth: physical.width,
        physicalHeight: physical.height,
        innerWidth: win.innerWidth,
        innerHeight: win.innerHeight,
        devicePixelRatio: Number(win.devicePixelRatio) || null,
        visualViewportScale: win.visualViewport?.scale ?? null,
        honoured: boot.width ? Math.abs(Number(measured.layoutWidth) - boot.width) <= 2 : null,
      });
      onChange(reason);
    }, REPORT_SETTLE_MS);
  }

  function apply(scale, source, reason) {
    const zoom = zoomFor(scale, nativeDpr);
    const changed = zoom !== boot.zoom;
    boot.scale = zoom === 1 ? null : Number(scale);
    boot.zoom = zoom;
    boot.width = zoom === 1 ? null : layoutWidthFor(win.innerWidth, zoom);
    boot.source = source;
    if (changed) setZoom(zoom);
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
    store.set(AUTO_KEY, eligible ? String(CAR_DEFAULT_SCALE) : "native");
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
    else apply(CAR_DEFAULT_SCALE, "default", reason);
  }

  return {
    get eligible() {
      return eligible;
    },

    /** The sizes to offer, smallest look first, with their labels. */
    options() {
      const steps = scaleSteps(nativeDpr);
      const defaultIndex = Math.max(0, steps.findIndex((scale) => Math.abs(scale - CAR_DEFAULT_SCALE) < 0.005));
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
      return { scale: boot.scale, zoom: boot.zoom, width: boot.width, source: boot.source, nativeScale: nativeDpr, eligible };
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
