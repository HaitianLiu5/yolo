// A storyboard's picture (Agent Note 2026-10-13-video-frames): tiles in a
// grid of RGB pixels, each labelled with its time. The labels use the small
// font below, so the node needs no font files and ffmpeg no text filter.

// 5×7 glyphs for clock times; "#" is ink.
const GLYPHS = {
  0: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  6: ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  9: [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  ":": [".", ".", "#", ".", "#", ".", "."],
  ".": [".", ".", ".", ".", ".", ".", "#"],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
};
const GLYPH_HEIGHT = 7;
const GAP = 2;
const BACKGROUND = [17, 17, 17];

// The grid for `count` tiles: enough columns that the whole sheet is about
// 16:9 (rounded up, so wider rather than taller), and tiles narrowed so the
// sheet is at most `maxWidth` wide.
export function storyboardLayout({ count, tileWidth, aspect = 16 / 9, maxWidth = 2400 }) {
  const columns = Math.max(1, Math.min(count, Math.ceil(Math.sqrt((count * 16) / 9 / aspect))));
  const rows = Math.ceil(count / columns);
  const even = (value) => Math.max(2, Math.floor(value / 2) * 2);
  const width = even(Math.min(tileWidth, (maxWidth - GAP * (columns + 1)) / columns));
  const height = even(width / aspect);
  return { columns, rows, tileWidth: width, tileHeight: height, width: columns * width + GAP * (columns + 1), height: rows * height + GAP * (rows + 1) };
}

function textWidth(text, scale) {
  return [...text].reduce((sum, char) => sum + ((GLYPHS[char]?.[0].length ?? 5) + 1) * scale, -scale);
}

// Darkens a box and writes `text` in white, at (x, y) of an RGB image `width` wide.
function label(pixels, width, x, y, text, scale) {
  const pad = 2 * scale;
  const boxWidth = textWidth(text, scale) + pad * 2;
  const boxHeight = GLYPH_HEIGHT * scale + pad * 2;
  for (let row = y; row < y + boxHeight; row += 1) {
    for (let column = x; column < x + boxWidth; column += 1) {
      const at = (row * width + column) * 3;
      for (let channel = 0; channel < 3; channel += 1) pixels[at + channel] = Math.round(pixels[at + channel] * 0.3);
    }
  }
  let left = x + pad;
  for (const char of text) {
    const glyph = GLYPHS[char] ?? GLYPHS["-"];
    glyph.forEach((line, glyphRow) => {
      [...line].forEach((ink, glyphColumn) => {
        if (ink !== "#") return;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const at = ((y + pad + glyphRow * scale + dy) * width + left + glyphColumn * scale + dx) * 3;
            pixels[at] = 255;
            pixels[at + 1] = 255;
            pixels[at + 2] = 255;
          }
        }
      });
    });
    left += (glyph[0].length + 1) * scale;
  }
}

// `tiles` are { rgb: Buffer of tileWidth × tileHeight × 3, or null for a
// tile with no picture, label }, in reading order.
export function composeStoryboard(layout, tiles) {
  const { columns, tileWidth, tileHeight, width, height } = layout;
  const pixels = Buffer.alloc(width * height * 3);
  for (let at = 0; at < pixels.length; at += 3) pixels.set(BACKGROUND, at);
  const scale = Math.max(1, Math.round(tileWidth / 160));
  tiles.forEach((tile, index) => {
    const x = GAP + (index % columns) * (tileWidth + GAP);
    const y = GAP + Math.floor(index / columns) * (tileHeight + GAP);
    if (tile.rgb) {
      for (let row = 0; row < tileHeight; row += 1) {
        tile.rgb.copy(pixels, ((y + row) * width + x) * 3, row * tileWidth * 3, (row + 1) * tileWidth * 3);
      }
    }
    const boxHeight = GLYPH_HEIGHT * scale + 4 * scale;
    if (textWidth(tile.label, scale) + 4 * scale <= tileWidth && boxHeight <= tileHeight) {
      label(pixels, width, x, y + tileHeight - boxHeight, tile.label, scale);
    }
  });
  return pixels;
}
