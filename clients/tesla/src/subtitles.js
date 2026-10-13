// --- VTT subtitle renderer -------------------------------------------

import { buildCueEndPrefix, parseVTT } from "./subtitle-cues.js";
import { activeSubtitleGroups, subtitleLineLanguage, subtitlePictureBounds } from "./subtitle-layout.js";
import { requestText } from "./network.js";

export { parseVTT } from "./subtitle-cues.js";

const subtitleOverlay = document.getElementById("subtitle-overlay");
const playerContainer = document.getElementById("player-container");
let subtitleTracks = []; // [{ lang, cues }]
let lastRenderedSubtitle = "";
const pendingTracks = new Map();

// The engine's picture: the canvas engine's canvas (its size is the decoded
// picture's) or the <video> engine's element (Agent Note 2026-10-12-two-playback-engines).
function pictureSize() {
  const picture = playerContainer.querySelector("[data-engine]");
  if (picture && "videoWidth" in picture) return { width: picture.videoWidth || 0, height: picture.videoHeight || 0 };
  return { width: picture?.width || 0, height: picture?.height || 0 };
}

function updateSubtitlePictureBounds() {
  const picture = pictureSize();
  const bounds = subtitlePictureBounds(playerContainer.clientWidth, playerContainer.clientHeight, picture.width, picture.height);
  subtitleOverlay.style.setProperty("--subtitle-picture-width", `${bounds.width}px`);
  subtitleOverlay.style.setProperty("--subtitle-picture-inset", `${bounds.bottom + Math.max(10, Math.min(24, bounds.height * 0.035))}px`);
}

// Geometry follows the actual contained image, including resize while paused.
// Observers avoid layout reads in the per-frame subtitle rendering path. A
// <video> element announces its picture size with events, which do not
// bubble but reach the container while capturing.
new ResizeObserver(updateSubtitlePictureBounds).observe(playerContainer);
new MutationObserver(updateSubtitlePictureBounds).observe(playerContainer, {
  childList: true, subtree: true, attributes: true, attributeFilter: ["width", "height"],
});
for (const type of ["loadedmetadata", "resize"]) playerContainer.addEventListener(type, updateSubtitlePictureBounds, true);
updateSubtitlePictureBounds();

function cancelPendingTrack(lang) {
  pendingTracks.get(lang)?.abort();
  pendingTracks.delete(lang);
}

function clearSubtitleOverlay() {
  if (!lastRenderedSubtitle && !subtitleOverlay.hasChildNodes()) return;
  subtitleOverlay.replaceChildren();
  lastRenderedSubtitle = "";
}

function renderSubtitleGroups(groups) {
  const nextRenderedSubtitle = JSON.stringify(groups);
  if (nextRenderedSubtitle === lastRenderedSubtitle) return;

  lastRenderedSubtitle = nextRenderedSubtitle;
  if (!groups.length) {
    subtitleOverlay.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    const track = document.createElement("div");
    track.className = "subtitle-track";
    track.lang = subtitleLineLanguage(group.lines.join(" "), group.lang);
    track.dataset.lang = group.lang;
    for (const line of group.lines) {
      const lineElement = document.createElement("span");
      lineElement.className = "subtitle-line";
      lineElement.lang = subtitleLineLanguage(line, group.lang);
      lineElement.textContent = line;
      track.append(lineElement);
    }
    fragment.append(track);
  }
  subtitleOverlay.replaceChildren(fragment);
}

export function renderSubtitle(time) {
  if (!subtitleTracks.length) {
    clearSubtitleOverlay();
    return;
  }

  renderSubtitleGroups(activeSubtitleGroups(subtitleTracks, time));
}

export async function loadSubtitleTrack(lang, url) {
  cancelPendingTrack(lang);
  const controller = new AbortController();
  pendingTracks.set(lang, controller);
  try {
    const absUrl = url.startsWith("/") ? `${location.origin}${url}` : url;
    const existingTrack = subtitleTracks.find((track) => track.lang === lang && track.url === absUrl);
    if (existingTrack) return true;
    const resp = await requestText(absUrl, { signal: controller.signal }, {
      label: "Subtitle",
      timeoutMs: 20_000,
      maxBytes: 20 * 1024 * 1024,
    });
    if (pendingTracks.get(lang) !== controller) return null;
    if (!resp.ok) throw new Error(`Subtitle fetch failed with ${resp.status}`);
    const cues = parseVTT(resp.text);
    subtitleTracks = subtitleTracks.filter((t) => t.lang !== lang);
    // Prefix maxima let lookup stop as soon as no earlier overlapping cue can still be active.
    subtitleTracks.push({ lang, url: absUrl, cues, cueEndPrefix: buildCueEndPrefix(cues) });
    clearSubtitleOverlay();
    console.log(`[subs] Loaded ${cues.length} cues for ${lang}`);
    return true;
  } catch (e) {
    if (controller.signal.aborted) return null;
    console.error("[subs] Failed to load subtitle:", e);
    return false;
  } finally {
    if (pendingTracks.get(lang) === controller) pendingTracks.delete(lang);
  }
}

export function disableExternalSubtitle() {
  for (const lang of pendingTracks.keys()) cancelPendingTrack(lang);
  subtitleTracks = [];
  clearSubtitleOverlay();
}

export function removeSubtitleTrack(lang) {
  cancelPendingTrack(lang);
  subtitleTracks = subtitleTracks.filter((t) => t.lang !== lang);
  if (!subtitleTracks.length) {
    clearSubtitleOverlay();
    return;
  }
  lastRenderedSubtitle = "";
}
