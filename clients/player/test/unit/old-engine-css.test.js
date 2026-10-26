import assert from "node:assert/strict";
import test from "node:test";
import postcss from "postcss";
import { oklchToRgb, oldEngineCss } from "../../old-engine-css.js";

// The build lowers the player's CSS for engines as old as Chromium 85, a
// 2022 Samsung TV's, without changing what newer browsers draw
// (Agent Note 2026-10-26-tv-web-client).

// Compared without the printer's spacing and last semicolons.
const norm = (css) => css.replace(/\s+/g, " ").replace(/;?\s*}\s*/g, " } ").replace(/\s*{\s*/g, " { ").trim();
const lower = async (css) => norm((await postcss([oldEngineCss()]).process(css, { from: "style.css" })).css);

test("oklch colors inside sRGB become the same rgb; others stay", async () => {
  assert.deepEqual([oklchToRgb("0% 0 0"), oklchToRgb("100% 0 0 / 0.9"), oklchToRgb("93% 0 0")], ["rgb(0 0 0)", "rgb(255 255 255 / 0.9)", "rgb(232 232 232)"]);
  assert.equal(oklchToRgb("70% 0.35 145"), null, "outside sRGB");
  assert.equal(oklchToRgb("var(--l) 0 0"), null);
  assert.equal(await lower(":root { --scrim: oklch(0% 0 0 / 0.6); color: oklch(100% 0 0); }"), norm(":root { --scrim: rgb(0 0 0 / 0.6); color: rgb(255 255 255); }"));
});

test("inset becomes its four sides, a calc() or var() kept whole", async () => {
  assert.equal(
    await lower("a { inset: auto var(--gutter) calc(var(--b) + 4px); }"),
    norm("a { top: auto; right: var(--gutter); bottom: calc(var(--b) + 4px); left: var(--gutter); }"),
  );
});

test("container units get viewport units where the engine has none, after the rule", async () => {
  assert.equal(
    await lower(":root { --gutter: clamp(24px, 3.2cqw, 40px); color: red; } b { width: min(42cqh, 280px); }"),
    norm(":root { --gutter: clamp(24px, 3.2cqw, 40px); color: red; } @supports not (width: 1cqw) { :root { --gutter: clamp(24px, 3.2vw, 40px) } } "
      + "b { width: min(42cqh, 280px); } @supports not (width: 1cqw) { b { width: min(42vh, 280px) } }"),
  );
});

test("a :focus-visible rule gets a :focus copy where the engine has no :focus-visible", async () => {
  assert.equal(
    await lower(".card:focus-visible { outline: 2px solid; }"),
    norm(".card:focus-visible { outline: 2px solid; } @supports not selector(:focus-visible) { .card:focus { outline: 2px solid; } }"),
  );
});

test("aspect-ratio carries its ratio for the old engines' sizing", async () => {
  assert.equal(
    await lower(".thumb { aspect-ratio: 16 / 9; } .poster .thumb { aspect-ratio: 2 / 3; }"),
    norm(".thumb { aspect-ratio: 16 / 9; --yolo-aspect-ratio: 1.7778; } .poster .thumb { aspect-ratio: 2 / 3; --yolo-aspect-ratio: 0.6667; }"),
  );
});

test("keyframes keep container units, which an @supports cannot sit in", async () => {
  assert.equal(await lower("@keyframes grow { to { width: 10cqw; } }"), norm("@keyframes grow { to { width: 10cqw; } }"));
});
