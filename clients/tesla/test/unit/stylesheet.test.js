import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The client's stylesheets as the car lays them out (Agent Notes
// 2026-07-13-in-car-design-principles and 2026-10-11-display-size).

const sheets = ["style.css", "player-overlays.css"].map((name) => ({
  name,
  css: readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
}));

const rule = (selector) => {
  const css = sheets.map((sheet) => sheet.css).join("\n");
  const match = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, `no rule for ${selector}`);
  return match[1];
};

test("no band is kept for the car's app dock: the browser window ends above it", () => {
  for (const { name, css } of sheets) assert.doesNotMatch(css, /dock/i, name);
  // The player's controls sit on the window's bottom edge, with only the
  // edge's own safe-area inset (a phone's home indicator) beneath them.
  assert.match(rule("#controls-bottom"), /padding:\s*var\(--space-6\) var\(--gutter\) calc\(var\(--safe-bottom\) \+ var\(--space-2\)\)/);
  assert.match(rule("#controls"), /justify-content:\s*space-between/);
  assert.match(rule(":root"), /--safe-bottom:\s*env\(safe-area-inset-bottom, 0px\)/);
  // The picture fills the whole window, centred, under the controls.
  assert.match(rule("#player-container"), /inset:\s*0/);
  assert.match(rule("#playback-error"), /top:\s*50%/);
});
