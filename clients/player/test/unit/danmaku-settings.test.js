import assert from "node:assert/strict";
import test from "node:test";

import { DANMAKU_DEFAULTS } from "@useyolo/core";
import { createDanmakuSettings, DANMAKU_KEY } from "../../src/danmaku-settings.js";

function browser(stored) {
  const values = new Map();
  if (stored !== undefined) values.set(DANMAKU_KEY, JSON.stringify(stored));
  return {
    values,
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
  };
}

test("a screen that never chose follows the defaults, and keeps only what it chooses", () => {
  const win = browser();
  const settings = createDanmakuSettings({ win });
  assert.deepEqual(settings.get(), DANMAKU_DEFAULTS);
  settings.update({ opacity: 0.6 });
  assert.deepEqual(JSON.parse(win.values.get(DANMAKU_KEY)), { version: 2, opacity: 0.6 });
  assert.deepEqual(createDanmakuSettings({ win }).get(), { ...DANMAKU_DEFAULTS, opacity: 0.6 });
});

test("settings kept by 0.6.0 keep their choices and take the new defaults for the rest", () => {
  // 0.6.0 kept every setting once one changed: here only `enabled` was a choice.
  const switchedOff = createDanmakuSettings({ win: browser({ enabled: false, density: "normal", opacity: 0.8, area: "full", fontSize: "normal" }) });
  assert.deepEqual(switchedOff.get(), { ...DANMAKU_DEFAULTS, enabled: false });
  const chosen = createDanmakuSettings({ win: browser({ enabled: true, density: "high", opacity: 1, area: "half", fontSize: "small" }) });
  assert.deepEqual(chosen.get(), { ...DANMAKU_DEFAULTS, density: "high", opacity: 1, area: "half", fontSize: "small" });
  // A choice made now of what 0.6.0's default was stays a choice.
  const full = createDanmakuSettings({ win: browser({ version: 2, area: "full" }) });
  assert.equal(full.get().area, "full");
});
