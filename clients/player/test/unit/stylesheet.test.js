import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The client's stylesheets under the display size's zoom (Agent Note
// 2026-10-11-display-size).

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

test("sizes that follow the window measure #app, which the display size zooms, not the viewport", () => {
  // Under the root's zoom, vw and vh measure the unzoomed window: 100vw is
  // only 82% of the window at the car's default size.
  for (const { name, css } of sheets) assert.doesNotMatch(css, /\d(?:\.\d+)?(?:vw|vh|dvh|svh|lvh)\b/, name);
  assert.match(rule("#app"), /container-type:\s*size/);
});
