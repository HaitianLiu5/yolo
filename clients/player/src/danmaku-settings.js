import { DANMAKU_DEFAULTS, danmakuSettingsPatch, normalizeDanmakuSettings } from "@useyolo/core";

// This screen's danmaku settings (Agent Note 2026-10-13-danmaku): kept in
// the browser, changed in the player's controls, the settings sheet, or by
// an agent (the Hub's `danmaku` message). Both profiles start from the same
// defaults.

export const DANMAKU_KEY = "yolo.danmaku";

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
 * @param {(settings: object, reason: string) => void} [options.onChange]
 */
export function createDanmakuSettings({ win = globalThis, onChange = () => {} } = {}) {
  const store = storage(win);
  let settings = normalizeDanmakuSettings(store.get(), DANMAKU_DEFAULTS);
  const listeners = new Set([onChange]);

  return {
    get: () => settings,

    /** Apply the valid fields of `patch` ("owner" from this screen, "agent" from the Hub). */
    update(patch, reason = "owner") {
      const changes = danmakuSettingsPatch(patch);
      if (!Object.keys(changes).length) return settings;
      settings = { ...settings, ...changes };
      store.set(settings);
      for (const listener of listeners) listener(settings, reason);
      return settings;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
