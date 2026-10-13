import { DEVICE_KINDS, REMOTE_CAPABILITIES, TESLA_CANVAS_CAPABILITIES, WEB_CANVAS_CAPABILITIES } from "@useyolo/core";
import { readFingerprintInput, teslaFingerprint } from "./device-fingerprint.js";
import { browserNativeProbe, displayMaxHeight, nativeCapabilities, nativeVideoSupport, playbackEngineFor } from "./engine/native-support.js";

// Which client this page is (Agent Note 2026-10-11-yolo-web-client). One app
// serves two profiles:
//
// - "car": Drive-In in the Tesla browser. A display size is offered, a tap
//   plays on this screen, and the canvas engine plays.
// - "web": Yolo Web in a computer's or phone's browser. The browser's own
//   zoom instead of a display size, a tap plays where playback is now
//   (play-target.js), so it doubles as a remote, and the browser's <video>
//   element plays (Agent Note 2026-10-12-two-playback-engines).
//
// The owner's type for this device (chosen when pairing, or later in
// settings) decides; until Yolo has said it, the Tesla fingerprint guesses.
// The profile is <html data-profile>, which the stylesheet keys on.
//
// One thing the owner's type never decides: a page the Tesla fingerprint
// recognizes plays with the canvas engine and announces the Tesla's canvas
// capabilities, also when its type says browser (Agent Note
// 2026-10-12-two-playback-engines).

export const KIND_KEY = "yolo.deviceKind";

/** Whether this browser can run the canvas engine. */
function canRunCanvas(win = globalThis) {
  return win.crossOriginIsolated === true
    && typeof win.SharedArrayBuffer === "function"
    && typeof win.VideoDecoder === "function"
    && typeof win.AudioDecoder === "function"
    && typeof win.AudioWorkletNode === "function";
}

/** "car" or "web" from the owner's device type, else from the fingerprint. */
export function profileFor({ kind = null, tesla = false } = {}) {
  if (DEVICE_KINDS.includes(kind)) return kind === "car" ? "car" : "web";
  return tesla ? "car" : "web";
}

/**
 * The capabilities this page announces in `hello`, for the engine it plays
 * with (engine/native-support.js).
 * @param {"car" | "web"} profile
 * @param {"canvas" | "native" | null} engine
 * @param {object | null} [native] nativeVideoSupport()
 * @param {boolean} [tesla] the Tesla fingerprint
 */
function capabilitiesFor(profile, engine, native = null, tesla = false, maxHeight = undefined) {
  if (engine === "native" && native) return nativeCapabilities(native, maxHeight);
  if (engine === "canvas") return profile === "car" || tesla ? TESLA_CANVAS_CAPABILITIES : WEB_CANVAS_CAPABILITIES;
  return REMOTE_CAPABILITIES;
}

function storage(win) {
  return {
    get: (key) => {
      try {
        return win.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        if (value == null) win.localStorage?.removeItem(key);
        else win.localStorage?.setItem(key, value);
      } catch {
        // Private mode: this page only.
      }
    },
  };
}

/**
 * @param {object} [options]
 * @param {Window} [options.win]
 * @param {(profile: string, previous: string) => void} [options.onChange]
 */
export function createProfile({ win = globalThis, onChange = () => {} } = {}) {
  const store = storage(win);
  const fingerprint = teslaFingerprint(readFingerprintInput(win));
  const canvas = canRunCanvas(win);
  const native = nativeVideoSupport(browserNativeProbe(win));
  let kind = store.get(KIND_KEY);
  let current = profileFor({ kind, tesla: fingerprint.tesla });
  const engine = () => playbackEngineFor({ profile: current, tesla: fingerprint.tesla, canvas, native });

  function apply() {
    const root = win.document?.documentElement;
    if (root) root.dataset.profile = current;
  }
  apply();

  return {
    get name() {
      return current;
    },
    get car() {
      return current === "car";
    },
    // "canvas", "native", or null: this browser is a remote.
    get engine() {
      return engine();
    },
    get canPlay() {
      return engine() !== null;
    },
    // What the browser's <video> element plays, or null.
    native,
    get kind() {
      return kind;
    },
    fingerprint,
    capabilities: () => capabilitiesFor(current, engine(), native, fingerprint.tesla, displayMaxHeight(win)),
    // Yolo said this device's type (the owner's choice): it wins over the
    // fingerprint, now and on the next visit.
    setKind(next) {
      if (!DEVICE_KINDS.includes(next) || next === kind) return;
      kind = next;
      store.set(KIND_KEY, next);
      const previous = current;
      current = profileFor({ kind, tesla: fingerprint.tesla });
      apply();
      if (previous !== current) onChange(current, previous);
    },
    // The device was forgotten: the next pairing guesses again.
    forget() {
      kind = null;
      store.set(KIND_KEY, null);
    },
  };
}
