// Render Yolo's icons from the one hand-drawn line in
// service/core/src/brand.js: the Apple TV app's layered icons and Top Shelf
// images, the player's favicon, touch icon, and 512-pixel icon (the Samsung
// TV app's too), the website's favicon, and, where the checkout has the
// iPhone app, its light, dark, and tinted icons. The icon is a dark screen
// that has just come on with yolo written across it in light; favicon sizes
// keep only the y. It drives Google Chrome through
// Playwright (set CHROME_PATH for another Chrome or Chromium binary) and never
// downloads a browser.
//
//   node scripts/render-icons.js

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { YOLO_MARK_PATH as Y, YOLO_WORD_PATH as WORD } from "../service/core/src/brand.js";
import { isMainModule } from "./agent-note-tree.js";

const root = resolve(import.meta.dirname, "..");
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Cool on the left, warm on the right. */
const LIGHT = ["#5AD1FF", "#8B7BFF", "#FF6FB1", "#FFB547"];
/** The tinted icon is grey; the system colors it. */
const GREY = ["#FFFFFF", "#E6E6E6", "#CCCCCC", "#B3B3B3"];

/**
 * One icon as SVG, 100 units high and `aspect` times as wide. `glyph` is the
 * word or the y, `scale` its size against its own coordinates, and `stroke`
 * the line's width there.
 */
function icon({ aspect = 1, ground = true, line = true, glyph = "word", scale, stroke, glow = true, colors = LIGHT, rx = 0 }) {
  const width = 100 * aspect;
  const word = glyph === "word";
  const [cx, cy, x1, x2] = word ? [129, 80, 14, 244] : [52, 107, 14, 90];
  const d = word ? WORD : Y;
  const stops = colors.map((color, i) => `<stop offset="${i / (colors.length - 1)}" stop-color="${color}"/>`).join("");
  const parts = [];
  if (ground) parts.push(`<rect width="${width}" height="100" rx="${rx}" fill="url(#ground)"/>`);
  if (line) {
    const path = (attrs) => `<path d="${d}" fill="none" stroke-linecap="round" stroke-linejoin="round" ${attrs}/>`;
    const strokes = [];
    if (glow) strokes.push(path(`stroke="url(#line)" stroke-width="${stroke * 2.2}" opacity="0.5" filter="url(#glow)"`));
    strokes.push(path(`stroke="url(#line)" stroke-width="${stroke}"`));
    if (glow) strokes.push(path(`stroke="#FFFFFF" stroke-width="${stroke * 0.32}" opacity="0.35"`));
    parts.push(`<g transform="translate(${width / 2} 50) scale(${scale}) translate(${-cx} ${-cy})">${strokes.join("")}</g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${+width.toFixed(3)} 100">` +
    `<defs><linearGradient id="ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1A1A1E"/><stop offset="1" stop-color="#000000"/></linearGradient>` +
    `<linearGradient id="line" gradientUnits="userSpaceOnUse" x1="${x1}" y1="0" x2="${x2}" y2="0">${stops}</linearGradient>` +
    `<filter id="glow" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="${word ? 5 : 3}"/></filter></defs>` +
    parts.join("") + "</svg>";
}

/** The favicon: the y on a rounded dark square, crisp at 16 pixels. */
const FAVICON = icon({ glyph: "y", scale: 0.64, stroke: 14, glow: false, rx: 20, colors: LIGHT.slice(0, 3) });

const square = (opts) => icon({ scale: 0.316, stroke: 7, ...opts });
const tv = (opts) => icon({ aspect: 5 / 3, scale: 0.42, stroke: 6.5, ...opts });
const shelf = (aspect) => icon({ aspect, scale: 0.3, stroke: 6, glow: true });

const TV = "clients/apple/TV/Assets.xcassets/App Icon & Top Shelf Image.brandassets";
const IOS = "clients/apple/iOS/Assets.xcassets/AppIcon.appiconset";

/** Every PNG: its path, its size, its SVG, and whether it keeps transparency. */
function targets() {
  const list = [];
  const add = (file, width, height, svg, transparent = false) => list.push({ file, width, height, svg, transparent });
  for (const [stack, sizes] of [["App Icon.imagestack", [[400, 240, ""], [800, 480, "@2x"]]], ["App Icon - App Store.imagestack", [[1280, 768, ""]]]]) {
    for (const [width, height, suffix] of sizes) {
      add(`${TV}/${stack}/Back.imagestacklayer/Content.imageset/back${suffix}.png`, width, height, tv({ line: false }));
      add(`${TV}/${stack}/Front.imagestacklayer/Content.imageset/front${suffix}.png`, width, height, tv({ ground: false }), true);
    }
  }
  for (const [set, width] of [["Top Shelf Image.imageset", 1920], ["Top Shelf Image Wide.imageset", 2320]]) {
    add(`${TV}/${set}/shelf.png`, width, 720, shelf(width / 720));
    add(`${TV}/${set}/shelf@2x.png`, width * 2, 1440, shelf(width / 720));
  }
  add("clients/player/public/apple-touch-icon.png", 180, 180, square({ stroke: 8.5 }));
  add("clients/player/public/icon-512.png", 512, 512, square({}));
  if (existsSync(resolve(root, IOS))) {
    add(`${IOS}/icon.png`, 1024, 1024, square({}));
    add(`${IOS}/icon-dark.png`, 1024, 1024, square({ ground: false }), true);
    add(`${IOS}/icon-tinted.png`, 1024, 1024, square({ ground: false, colors: GREY, glow: false }), true);
  }
  return list;
}

async function render() {
  for (const file of ["clients/player/public/favicon.svg", "site/public/favicon.svg"]) writeFileSync(resolve(root, file), FAVICON + "\n");
  const executablePath = process.env.CHROME_PATH ?? (process.platform === "darwin" ? MAC_CHROME : undefined);
  const browser = await chromium.launch({ executablePath });
  try {
    for (const { file, width, height, svg, transparent } of targets()) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.setContent(`<html><body style="margin:0">${svg.replace("<svg ", `<svg width="${width}" height="${height}" style="display:block" `)}</body></html>`);
      writeFileSync(resolve(root, file), await page.screenshot({ omitBackground: transparent }));
      console.log(`${file}: ${width}x${height}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

if (isMainModule(import.meta.filename)) await render();
