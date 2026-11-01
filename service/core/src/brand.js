// The visual vocabulary Yolo's own screens share: the player, in both
// modes, and the control plane's owner pages
// (Agent Note 2026-10-12-owner-web-pages). One mark, and one name and icon
// for each device type.

// The word in one hand-drawn stroke, as Yolo's icons write it
// (scripts/render-icons.js), in its own coordinates: about 236 by 160 units,
// centred on (129, 80).
export const YOLO_WORD_PATH = "M14 86 C20 72 27 61 33 61 C38 61 35 96 47 97 C58 98 63 74 66 61 C66 88 64 122 58 140 C54 152 45 155 45 145 C45 130 68 106 90 93 C94 83 101 64 112 62 C99 61 89 79 92 91 C95 103 115 102 119 87 C123 73 118 61 112 62 C118 66 128 68 140 62 C152 56 168 30 168 16 C168 4 156 6 154 20 C152 40 152 80 156 94 C160 102 172 100 182 88 C186 76 196 64 206 62 C192 60 182 80 186 92 C190 104 210 102 214 86 C218 72 212 60 206 62 C214 68 228 70 244 58";

// The Yolo mark: the word's first letter, the y alone, centred on (52, 107).
export const YOLO_MARK_PATH = "M14 86 C20 72 27 61 33 61 C38 61 35 96 47 97 C58 98 63 74 66 61 C66 88 64 122 58 140 C54 152 45 155 45 145 C45 130 68 106 90 93";

// The mark stroked in currentColor, in a square around the y.
export function yoloMarkSvg({ size = 24, title = null } = {}) {
  const label = title ? ` role="img" aria-label="${String(title).replace(/[&<>"']/g, "")}"` : ' aria-hidden="true"';
  return `<svg viewBox="0 55 104 104" width="${size}" height="${size}"${label}><path fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" d="${YOLO_MARK_PATH}"/></svg>`;
}

// What the owner calls each device type (DEVICE_KINDS in capabilities.js).
export const DEVICE_KIND_LABELS = Object.freeze({
  car: "Car",
  browser: "Browser",
  phone: "Phone",
  tv: "TV",
  other: "Other",
});

// One icon per device type (24-unit viewBox, filled with currentColor).
export const DEVICE_KIND_ICONS = Object.freeze({
  car: "M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z",
  browser: "M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z",
  phone: "M17 1.01L7 1c-1.1 0-1.99.9-1.99 2v18c0 1.1.89 2 1.99 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z",
  tv: "M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z",
  other: "M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
});

export function deviceKindIconSvg(kind, { size = 24 } = {}) {
  const path = DEVICE_KIND_ICONS[kind] ?? DEVICE_KIND_ICONS.other;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
}
