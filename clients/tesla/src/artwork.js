import { authHeaders } from "./api.js";

// Library artwork comes from /v1/library/items/<id>/artwork, which needs the
// device credential; an <img> cannot send it. Such images are fetched when
// they scroll near the screen and shown from blob URLs (kept for reuse, the
// oldest released). Other thumbnails (web videos) load directly: the page's
// COEP is credentialless, so cross-origin images need no CORP header.

const MAX_CACHED = 200;
const cache = new Map(); // url → Promise<blob URL>

// Missing artwork: a quiet film-frame glyph, not a play button.
const PLACEHOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/></svg>';

export const needsCredential = (url) => typeof url === "string" && url.startsWith("/v1/");

// The same library artwork as a landscape image (a movie's background, an
// episode's still), for rows of 16:9 cards; other URLs are left alone.
export function landscapeArtwork(url) {
  if (!needsCredential(url) || !/\/artwork(\?|$)/.test(url)) return url;
  if (/[?&]variant=/.test(url)) return url.replace(/([?&]variant=)[^&]*/, "$1landscape");
  return `${url}${url.includes("?") ? "&" : "?"}variant=landscape`;
}

function blobUrl(url) {
  if (cache.has(url)) {
    const value = cache.get(url);
    cache.delete(url);
    cache.set(url, value);
    return value;
  }
  const value = fetch(url, { headers: authHeaders() }).then((response) => {
    if (!response.ok) throw new Error(`Artwork answered ${response.status}`);
    return response.blob();
  }).then((blob) => URL.createObjectURL(blob));
  value.catch(() => cache.delete(url));
  cache.set(url, value);
  while (cache.size > MAX_CACHED) {
    const [oldest, promise] = cache.entries().next().value;
    cache.delete(oldest);
    promise.then((object) => URL.revokeObjectURL(object), () => {});
  }
  return value;
}

/** A URL the browser can load by itself for this artwork (a blob URL for library artwork). */
export function artworkSource(url) {
  if (!url) return Promise.resolve(null);
  return needsCredential(url) ? blobUrl(url) : Promise.resolve(url);
}

function replaceWithPlaceholder(img) {
  const empty = document.createElement("div");
  empty.className = img.dataset.emptyClass || "browse-card-thumb-empty";
  empty.innerHTML = PLACEHOLDER;
  img.replaceWith(empty);
}

// Artwork starts loading a screen ahead vertically and two row widths ahead
// sideways. Cards sit inside scroll containers (the browse screen, each row),
// which clip them before the root's margin applies, so the same margin goes
// on those containers too; a browser without scrollMargin loads on sight.
const AHEAD = "100% 200%";
const observer = typeof IntersectionObserver === "function"
  ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      load(entry.target);
    }
  }, { rootMargin: AHEAD, scrollMargin: AHEAD })
  : null;

function load(img) {
  const url = img.dataset.artwork;
  if (!url) return;
  if (!needsCredential(url)) {
    img.src = url;
    return;
  }
  blobUrl(url).then((object) => {
    img.src = object;
  }, () => replaceWithPlaceholder(img));
}

// An <img> for `url` that hydrate() fills in; `eager` loads it at once.
export function artworkImage(url, { emptyClass = "browse-card-thumb-empty", eager = false } = {}) {
  if (!url) return `<div class="${emptyClass}">${PLACEHOLDER}</div>`;
  const escaped = String(url).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<img data-artwork="${escaped}" data-empty-class="${emptyClass}" alt=""${eager ? ' data-eager="1"' : ""}>`;
}

// Start loading the images artworkImage() put into `root`.
export function hydrateArtwork(root) {
  for (const img of root.querySelectorAll("img[data-artwork]:not([data-hydrated])")) {
    img.dataset.hydrated = "1";
    img.addEventListener("error", () => replaceWithPlaceholder(img), { once: true });
    if (img.dataset.eager || !observer) load(img);
    else observer.observe(img);
  }
}
