import { DANMAKU_DEFAULTS, danmakuSettingsPatch, normalizeDanmakuSettings } from "@useyolo/core";

// This screen's danmaku settings (Agent Note 2026-10-13-danmaku): kept in
// the browser, changed in the player's controls, the settings sheet, or by
// an agent (the Hub's `danmaku` message). Both profiles start from the same
// defaults.
//
// The browser keeps only the choices made on this screen, with `version: 2`,
// so a screen follows the defaults for everything it never chose. Yolo 0.6.0
// kept every setting, chosen or not, without a version: from those, a value
// other than 0.6.0's default was a choice and is kept, and a value equal to
// it gives way to the current default.

export const DANMAKU_KEY = "yolo.danmaku";
const VERSION = 2;
const DEFAULTS_0_6_0 = Object.freeze({ enabled: true, density: "normal", opacity: 0.8, area: "full", fontSize: "normal" });

/** The choices a stored value holds. */
export function storedChoices(value) {
  const choices = danmakuSettingsPatch(value);
  if (value?.version === VERSION) return choices;
  for (const [key, old] of Object.entries(DEFAULTS_0_6_0)) if (choices[key] === old) delete choices[key];
  return choices;
}

function storage(win) {
  return {
    get() {
      try {
        return JSON.parse(win.localStorage?.getItem(DANMAKU_KEY) ?? "null");
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        win.localStorage?.setItem(DANMAKU_KEY, JSON.stringify(value));
      } catch {
        // Private mode or full: the settings last for this page only.
      }
    },
  };
}

/**
 * @param {object} [options]
 * @param {Window} [options.win]
 * @param {(settings: object, reason: string, changes: object) => void} [options.onChange]
 *   also what `subscribe` listeners hear; `changes` are the settings that changed
 */
export function createDanmakuSettings({ win = globalThis, onChange = () => {} } = {}) {
  const store = storage(win);
  let choices = storedChoices(store.get());
  let settings = normalizeDanmakuSettings(choices, DANMAKU_DEFAULTS);
  const listeners = new Set([onChange]);

  return {
    get: () => settings,

    /** Apply the valid fields of `patch` ("owner" from this screen, "agent" from the Hub). */
    update(patch, reason = "owner") {
      const changes = danmakuSettingsPatch(patch);
      if (!Object.keys(changes).length) return settings;
      choices = { ...choices, ...changes };
      settings = { ...settings, ...changes };
      store.set({ version: VERSION, ...choices });
      for (const listener of listeners) listener(settings, reason, changes);
      return settings;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
