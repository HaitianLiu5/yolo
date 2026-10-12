// The visual vocabulary Yolo's own screens share: the clients (Drive-In and
// Yolo Web) and the control plane's owner pages
// (Agent Note 2026-10-12-owner-web-pages). One mark, and one name and icon
// for each device type.

// The Yolo mark: a rounded square with a play triangle cut out of it, drawn
// in currentColor (24-unit viewBox, even-odd fill).
export const YOLO_MARK_PATH = "M8 1.5h8A6.5 6.5 0 0 1 22.5 8v8a6.5 6.5 0 0 1-6.5 6.5H8A6.5 6.5 0 0 1 1.5 16V8A6.5 6.5 0 0 1 8 1.5zM9.9 7.4v9.2l7.3-4.6z";

export function yoloMarkSvg({ size = 24, title = null } = {}) {
  const label = title ? ` role="img" aria-label="${String(title).replace(/[&<>"']/g, "")}"` : ' aria-hidden="true"';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"${label}><path fill="currentColor" fill-rule="evenodd" d="${YOLO_MARK_PATH}"/></svg>`;
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
