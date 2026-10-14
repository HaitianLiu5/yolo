import { fontAt, paintComment, REFERENCE_PX } from "./danmaku-paint.js";

// The danmaku layer's text worker (Agent Note 2026-10-13-danmaku): it
// measures comments and draws each into an ImageBitmap, so shaping and
// rasterizing text, which for an emoji or a font part used for the first
// time takes tens of milliseconds, never runs on the page's main thread,
// where the car's canvas engine presents video frames. The page's caption
// fonts are added here from the page's @font-face rules; the parts a text
// needs are loaded before it is measured or drawn.
//
// Messages: { type: "fonts", faces: [{ family, src, descriptors }] };
// { type: "measure", id, texts } → { id, widths } (Float32Array, ems);
// { type: "draw", id, text, color, px, width, height } → { id, bitmap }.

const measuring = new OffscreenCanvas(1, 1).getContext("2d");

async function glyphs(text) {
  try {
    await self.fonts.load(fontAt(16), text);
  } catch {
    // A part that does not load leaves the system's fallback font.
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === "fonts") {
    for (const face of data.faces) {
      try {
        self.fonts.add(new FontFace(face.family, face.src, face.descriptors));
      } catch {
        // An unusable rule is skipped.
      }
    }
    return;
  }
  if (data.type === "measure") {
    await glyphs(data.texts.join(""));
    measuring.font = fontAt(REFERENCE_PX);
    const widths = new Float32Array(data.texts.length);
    data.texts.forEach((text, index) => {
      widths[index] = measuring.measureText(text).width / REFERENCE_PX;
    });
    self.postMessage({ id: data.id, widths }, [widths.buffer]);
    return;
  }
  if (data.type === "draw") {
    await glyphs(data.text);
    const canvas = new OffscreenCanvas(data.width, data.height);
    paintComment(canvas.getContext("2d"), data);
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ id: data.id, bitmap }, [bitmap]);
  }
};
