// Render the README's architecture diagram from its source,
// .github/readme/architecture.html, to the four PNGs the README pair shows:
// English and Chinese, light and dark, at twice the 830-pixel README width.
// It drives Google Chrome through Playwright (set CHROME_PATH for another
// Chrome or Chromium binary) and never downloads a browser, then stores each
// screenshot as a 256-color PNG, about a third of Chrome's size.
//
//   node scripts/render-readme-diagram.js

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { chromium } from "playwright";
import { isMainModule } from "./agent-note-tree.js";

const dir = resolve(import.meta.dirname, "../.github/readme");
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** One PNG per language and color scheme. */
const VARIANTS = [
  { lang: "en", scheme: "light" },
  { lang: "en", scheme: "dark" },
  { lang: "zh", scheme: "light" },
  { lang: "zh", scheme: "dark" },
];

/** Decode a screenshot from Chrome: an 8-bit, non-interlaced RGBA PNG. */
function decodeRgba(png) {
  let offset = 8;
  let header;
  const data = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = body;
    if (type === "IDAT") data.push(body);
    offset += length + 12;
  }
  if (header[8] !== 8 || header[9] !== 6 || header[12] !== 0) throw new Error("expected an 8-bit, non-interlaced RGBA PNG");
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[row + x - 4] : 0;
      const b = y > 0 ? pixels[row - stride + x] : 0;
      const c = x >= 4 && y > 0 ? pixels[row - stride + x - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[row + x] = (raw[source + x] + predictor) & 255;
    }
  }
  return { width, height, pixels };
}

/** Split `colors` (RGBA arrays) into at most `count` boxes and return each box's mean. */
function medianCut(colors, count) {
  const boxes = [colors];
  const spread = (box, channel) => {
    let low = 255, high = 0;
    for (const color of box) {
      low = Math.min(low, color[channel]);
      high = Math.max(high, color[channel]);
    }
    return (high - low) * Math.sqrt(box.length);
  };
  while (boxes.length < count) {
    let best = 0, at = -1, along = 0;
    boxes.forEach((box, index) => {
      for (let channel = 0; box.length > 1 && channel < 4; channel++) {
        const score = spread(box, channel);
        if (score > best) [best, at, along] = [score, index, channel];
      }
    });
    if (at < 0) break;
    const box = boxes[at].sort((p, q) => p[along] - q[along]);
    boxes.splice(at, 1, box.slice(0, box.length >> 1), box.slice(box.length >> 1));
  }
  return boxes.map((box) => [0, 1, 2, 3].map((channel) => Math.round(box.reduce((sum, color) => sum + color[channel], 0) / box.length)));
}

function chunk(type, body) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([head, typed, crc]);
}

/**
 * Re-encode a screenshot with a 256-color palette: the 64 most frequent
 * colors (the fills, borders, and text) exactly, the rarer antialiasing
 * shades by median cut, each pixel mapped to its nearest entry.
 */
function palettize(png) {
  const { width, height, pixels } = decodeRgba(png);
  const counts = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    const key = pixels.readUInt32BE(i);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const colors = [...counts].sort((p, q) => q[1] - p[1]).map(([key]) => [key >>> 24, (key >>> 16) & 255, (key >>> 8) & 255, key & 255]);
  const palette = colors.length <= 256 ? colors : [...colors.slice(0, 64), ...medianCut(colors.slice(64), 192)];
  const entry = new Map();
  for (const color of colors) {
    let nearest = 0, distance = Infinity;
    palette.forEach((candidate, index) => {
      const d = candidate.reduce((sum, value, channel) => sum + (value - color[channel]) ** 2, 0);
      if (d < distance) [nearest, distance] = [index, d];
    });
    entry.set(((color[0] << 24) | (color[1] << 16) | (color[2] << 8) | color[3]) >>> 0, nearest);
  }
  const rows = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rows[y * (width + 1) + 1 + x] = entry.get(pixels.readUInt32BE((y * width + x) * 4));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 3;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("PLTE", Buffer.from(palette.flatMap(([r, g, b]) => [r, g, b]))),
    chunk("tRNS", Buffer.from(palette.map(([, , , alpha]) => alpha))),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function render() {
  const executablePath = process.env.CHROME_PATH ?? (process.platform === "darwin" ? MAC_CHROME : undefined);
  const browser = await chromium.launch({ executablePath });
  try {
    for (const { lang, scheme } of VARIANTS) {
      const page = await browser.newPage({ viewport: { width: 830, height: 1200 }, deviceScaleFactor: 2, colorScheme: scheme });
      await page.goto(`${pathToFileURL(resolve(dir, "architecture.html")).href}?lang=${lang}`);
      await page.waitForFunction(() => document.body.dataset.ready === "1");
      const png = palettize(await page.locator("#canvas").screenshot({ omitBackground: true }));
      const file = `architecture-${lang}-${scheme}.png`;
      writeFileSync(resolve(dir, file), png);
      console.log(`${file}: ${Math.round(png.length / 1024)} KB`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

if (isMainModule(import.meta.filename)) await render();
