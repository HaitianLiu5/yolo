import { state } from "./state.js";
import { timeAgo, escHtml } from "./utils.js";
import { navigate, showPath } from "./router.js";
import { showLoading, showPlaybackError, showStatus } from "./player.js";
import { api } from "./api.js";
import { artworkImage, hydrateArtwork, landscapeArtwork } from "./artwork.js";
import { playOnThisDevice, setTracks, warmPlayback } from "./playback.js";
import { playTarget } from "./play-target.js";

// The home screen (queue, continue watching, playlists, libraries, search),
// a show's episodes, and the subtitle and audio menus, all over Yolo's /v1
// API.

// Set by main.js: the device profile, the remote (remote.js), and a short
// notice on the home screen.
const context = { profile: null, remote: null, notify: (text) => showStatus(text) };
export function setBrowseContext(next) {
  Object.assign(context, next);
}

// --- DOM elements ----------------------------------------------------

const browseScreen = document.getElementById("browse-screen");
const queueSection = document.getElementById("queue-section");
const queueList = document.getElementById("queue-list");
const queueClear = document.getElementById("queue-clear");
const playlistsSection = document.getElementById("playlists-section");
const playlistsList = document.getElementById("playlists-list");
const historySection = document.getElementById("history-section");
const historyList = document.getElementById("history-list");
const moviesSection = document.getElementById("movies-section");
const moviesList = document.getElementById("movies-list");
const showsSection = document.getElementById("shows-section");
const showsList = document.getElementById("shows-list");
const statusScreen = document.getElementById("status-screen");
const episodesSection = document.getElementById("episodes-section");
const episodesList = document.getElementById("episodes-list");
const epsShowTitle = document.getElementById("eps-show-title");
const homeEmpty = document.getElementById("home-empty");
const homeEmptyText = document.getElementById("home-empty-text");
const searchSection = document.getElementById("search-section");
const searchResults = document.getElementById("search-results");
const searchTitle = document.getElementById("search-title");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const searchClear = document.getElementById("search-clear");
const btnSubs = document.getElementById("btn-subs");
const subsPanel = document.getElementById("subs-panel");
const subsList = document.getElementById("subs-list");
const btnAudio = document.getElementById("btn-audio");
const audioPanel = document.getElementById("audio-panel");
const audioList = document.getElementById("audio-list");

const QUEUE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
const UNDO_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>';
const PLAYLIST_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 6h14v2H4V6zm0 5h14v2H4v-2zm0 5h10v2H4v-2zm16-7v10l-7-5 7-5z"/></svg>';
const WATCHED_BADGE = '<div class="watched-badge" role="img" aria-label="Watched"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>';

// Finished: within the last minute (or 5%), the same rule as Yolo's history.
const isFinished = (position, duration) => duration > 0 && position >= duration - Math.min(60, duration * 0.05);

// --- Subtitle selection UI -------------------------------------------

const subtitleLabel = (track) => `${track.name || track.language || "Unknown"}${track.auto ? " (auto)" : ""}`;

export function updateSubsUI() {
  const subtitles = state.tracks.subtitles || [];
  if (!subtitles.length) {
    btnSubs.classList.add("hidden");
    subsPanel.classList.add("hidden");
    return;
  }
  btnSubs.classList.remove("hidden");
  const selected = new Set(state.tracks.selected?.subtitles || []);
  btnSubs.classList.toggle("active", selected.size > 0);
  subsList.innerHTML = "";

  const offBtn = document.createElement("button");
  offBtn.textContent = "Off";
  if (!selected.size) offBtn.classList.add("active");
  offBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    chooseSubtitles([]);
  });
  subsList.appendChild(offBtn);

  // Text tracks can be shown together (two languages at once); a burned-in
  // track replaces whatever else is shown.
  for (const track of subtitles) {
    const btn = document.createElement("button");
    btn.innerHTML = `<span>${escHtml(subtitleLabel(track))}</span>`;
    if (selected.has(track.id)) btn.classList.add("active");
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const next = new Set(selected);
      if (track.delivery !== "vtt" || [...selected].some((id) => subtitles.find((t) => t.id === id)?.delivery !== "vtt")) {
        chooseSubtitles(selected.has(track.id) ? [] : [track.id]);
        return;
      }
      if (next.has(track.id)) next.delete(track.id);
      else next.add(track.id);
      chooseSubtitles([...next]);
    });
    subsList.appendChild(btn);
  }
}

let trackRequest = 0;

// The choice is Yolo's: it saves it for this item (and as the default for
// the next), then sends `tracks` (or a new stream when the picture changes).
async function chooseSubtitles(ids) {
  subsPanel.classList.add("hidden");
  const request = ++trackRequest;
  try {
    await setTracks({ subtitles: ids });
  } catch (error) {
    if (request !== trackRequest) return;
    showStatus(`Could not change subtitles: ${error.message}`);
  }
}

// --- Audio track selection -------------------------------------------

// Audio renditions inside the stream itself (an HLS playlist's), which the
// <video> engine switches without a new stream; only when the source lists
// no audio tracks of its own (Agent Note 2026-10-12-two-playback-engines).
function updateRenditionUI(renditions) {
  btnAudio.classList.remove("hidden");
  audioList.innerHTML = "";
  for (const rendition of renditions) {
    const btn = document.createElement("button");
    btn.innerHTML = `<span>${escHtml(rendition.name || rendition.language || "Unknown")}</span>`;
    if (rendition.active) btn.classList.add("active");
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      audioPanel.classList.add("hidden");
      state.player?.selectAudioRendition?.(rendition.id);
      updateAudioUI();
    });
    audioList.appendChild(btn);
  }
}

export function updateAudioUI() {
  const tracks = state.tracks.audio || [];
  const hasTrackSelection = tracks.length > 1;
  const renditions = !tracks.length ? state.player?.audioRenditions?.() || [] : [];
  if (renditions.length > 1) {
    updateRenditionUI(renditions);
    return;
  }

  // The button opens a list to choose from: with one track there is nothing
  // to choose, so it stays hidden.
  if (!hasTrackSelection) {
    btnAudio.classList.add("hidden");
    audioPanel.classList.add("hidden");
    return;
  }
  btnAudio.classList.remove("hidden");

  audioList.innerHTML = "";

  const active = state.tracks.selected?.audio ?? tracks.find((track) => track.default)?.id ?? null;
  for (const track of tracks) {
    const btn = document.createElement("button");
    const label = track.name || track.language || "Unknown";
    btn.innerHTML = `<span>${escHtml(label)}</span>${track.detail ? `<small>${escHtml(track.detail)}</small>` : ""}`;
    if (String(active) === String(track.id)) btn.classList.add("active");
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      audioPanel.classList.add("hidden");
      setTracks({ audio: track.id }).catch((error) => showStatus(`Could not change audio: ${error.message}`));
    });
    audioList.appendChild(btn);
  }
}

// --- Skeletons ---------------------------------------------------------

// While a row waits for its items: cards of the real ones' size, grey where
// the artwork and the lines of text will be, so nothing moves when the
// items replace them in place. They pulse gently, except in the car, where
// they hold still (style.css), and go with the row's items.
const SKELETON_TITLE = [78, 62, 86, 70, 56, 82];
const SKELETON_META = [46, 36, 52, 40];
const MAX_SKELETONS = 12;

function skeletonCard(shape, index, titleLines) {
  const el = document.createElement("div");
  el.className = `skeleton-card ${shape}`;
  el.setAttribute("aria-hidden", "true");
  const bar = (width) => `<span class="skeleton skeleton-bar" style="width:${width}%"></span>`;
  const title = SKELETON_TITLE[index % SKELETON_TITLE.length];
  el.innerHTML = '<div class="browse-card-thumb skeleton"></div>'
    + `<div class="browse-card-title">${titleLines === 2 ? `${bar(92)} ${bar(title - 20)}` : bar(title)}</div>`
    + `<div class="browse-card-meta">${bar(SKELETON_META[index % SKELETON_META.length])}</div>`;
  return el;
}

// As many skeletons as fill the row's width, or `rows` rows of a grid,
// measured from the first one: no more than the screen shows, each one
// being a layer that pulses. A row is as tall as its tallest card, and in
// a row of many items one title almost always takes two lines (a web
// video's, a long movie's), so a row's skeletons have two; an episode's
// title is short, and a grid's rows each fit their own cards.
function fillSkeletons(container, shape, { rows = 1, titleLines = 2 } = {}) {
  const first = skeletonCard(shape, 0, titleLines);
  container.replaceChildren(first);
  const style = getComputedStyle(container);
  let count = 6;
  if (style.display === "grid") {
    count = style.gridTemplateColumns.split(" ").length * rows;
  } else if (first.offsetWidth > 0) {
    count = Math.ceil(container.clientWidth / (first.offsetWidth + (parseFloat(style.columnGap) || 0)));
  }
  for (let index = 1; index < Math.min(count, MAX_SKELETONS); index++) container.append(skeletonCard(shape, index, titleLines));
}

const skeletonBar = (width) => `<span class="skeleton skeleton-bar" style="width:${width}" aria-hidden="true"></span>`;

// --- Browse screen ---------------------------------------------------

const libraryCache = { shows: [] };

// The home screen's rows of library and history cards. A row whose items
// came once keeps them until new ones replace them; one that never had
// them (the first load) shows skeletons while they come.
const HOME_ROWS = [[historySection, historyList, "still"], [moviesSection, moviesList, "poster"], [showsSection, showsList, "poster"]];
const settledRows = new Set();
// Counts plays started on this screen: a home screen still loading must
// not show itself again over the player it started.
let playsStarted = 0;

function revealHome() {
  browseScreen.classList.remove("episodes-open");
  browseScreen.scrollTop = 0;
  // The header (search, settings) shows even with nothing else to show.
  browseScreen.classList.remove("hidden");
  statusScreen.style.display = "none";
  // Reset episodes view only when returning to the browse route. A stale
  // browse request must never hide an already-open show.
  episodesSection.classList.add("hidden");
}

// A row's items came, or Yolo could not say: its skeleton goes. `settled`
// rows keep what they show on the next load.
function endSkeleton(section, list, { settled }) {
  section.classList.remove("loading");
  section.removeAttribute("aria-busy");
  if (list.querySelector(".skeleton-card")) list.replaceChildren();
  if (settled) settledRows.add(list);
}

export async function loadBrowseScreen({
  isCurrent = () => true,
  revealBrowse = true,
} = {}) {
  // Removals marked in edit mode are sent before history is read again.
  exitEditMode();
  if (!revealBrowse && isCurrent()) {
    browseScreen.classList.add("episodes-open");
    browseScreen.scrollTop = 0;
  }

  // The first load shows the home screen at once, its rows as skeletons
  // (with a bar for the title, which rows will come is not known yet), and
  // fills each row in place as its items come.
  const startedPlays = playsStarted;
  const waiting = revealBrowse && isCurrent() ? HOME_ROWS.filter(([, list]) => !settledRows.has(list)) : [];
  if (waiting.length) {
    revealHome();
    homeEmpty.classList.add("hidden");
    for (const [section, list, shape] of waiting) {
      section.classList.remove("hidden");
      section.classList.add("loading");
      section.setAttribute("aria-busy", "true");
      fillSkeletons(list, shape);
    }
  }

  const [queueRes, playlistsRes, historyRes, libsRes] = await Promise.allSettled([
    api("/v1/queue", { label: "Queue" }),
    api("/v1/playlists", { label: "Playlists" }),
    api("/v1/history?limit=30", { label: "History" }),
    api("/v1/library", { label: "Libraries" }),
  ]);
  if (!isCurrent()) return { shows: [] };

  const queue = queueRes.status === "fulfilled" ? queueRes.value : [];
  const playlists = playlistsRes.status === "fulfilled" ? playlistsRes.value : [];
  const history = historyRes.status === "fulfilled" ? historyRes.value : [];
  const libs = libsRes.status === "fulfilled" ? libsRes.value?.libraries || [] : [];
  const failures = [queueRes, playlistsRes, historyRes, libsRes].filter((result) => result.status === "rejected");

  let hasContent = false;

  renderQueue(queue);
  if (queue.length) hasContent = true;
  renderPlaylists(playlists);
  if (playlists.length) hasContent = true;

  if (history.length) {
    renderCardRow(historyList, history, { type: "history" });
    historySection.classList.remove("hidden");
    hasContent = true;
    // The first cards are the likeliest taps: resolved ahead, they start sooner.
    if (tapTarget().here) void warmPlayback(history.slice(0, 3).map((entry) => entry.source));
  } else {
    historySection.classList.add("hidden");
  }
  endSkeleton(historySection, historyList, { settled: historyRes.status === "fulfilled" });

  const movieLib = libs.find((library) => library.type === "movie");
  const showLibs = libs.filter((library) => library.type === "show");
  const libraryItems = (library) => api(`/v1/library/${encodeURIComponent(library.id)}/items?limit=200`, { label: `Library ${library.title}` });

  // The libraries are known: a row that will come gets its title, one that
  // will not goes.
  for (const [section, list, comes] of [[moviesSection, moviesList, Boolean(movieLib)], [showsSection, showsList, showLibs.length > 0]]) {
    if (!list.querySelector(".skeleton-card")) continue;
    if (comes) {
      section.classList.remove("loading");
    } else {
      section.classList.add("hidden");
      endSkeleton(section, list, { settled: libsRes.status === "fulfilled" });
    }
  }

  const [moviesRes, ...showLibraryResults] = await Promise.allSettled([
    movieLib ? libraryItems(movieLib) : Promise.resolve(null),
    ...showLibs.map(libraryItems),
  ]);
  if (!isCurrent()) return { shows: [] };

  if (moviesRes.status === "fulfilled" && moviesRes.value?.items?.length) {
    renderCardRow(moviesList, moviesRes.value.items, { type: "movie" });
    moviesSection.classList.remove("hidden");
    hasContent = true;
  } else {
    moviesSection.classList.add("hidden");
  }
  endSkeleton(moviesSection, moviesList, { settled: libsRes.status === "fulfilled" && moviesRes.status === "fulfilled" });

  const shows = [];
  const seen = new Set();
  for (const result of showLibraryResults) {
    if (result.status !== "fulfilled") continue;
    for (const show of result.value?.items || []) {
      if (seen.has(show.id)) continue;
      seen.add(show.id);
      shows.push(show);
    }
  }
  libraryCache.shows = shows;
  if (shows.length) {
    renderCardRow(showsList, shows, { type: "show" });
    showsSection.classList.remove("hidden");
    hasContent = true;
  } else {
    showsSection.classList.add("hidden");
  }
  endSkeleton(showsSection, showsList, {
    settled: libsRes.status === "fulfilled" && showLibraryResults.every((result) => result.status === "fulfilled"),
  });

  if (revealBrowse && playsStarted === startedPlays) {
    if (!waiting.length) revealHome();
    homeEmpty.classList.toggle("hidden", hasContent);
    // Nothing came back because Yolo could not be asked, not because the
    // library is empty.
    if (!hasContent) {
      homeEmptyText.textContent = failures.length === 4
        ? `Could not load the home screen: ${failures[0].reason?.message || "Yolo did not answer"}`
        : "Nothing here yet. Search, paste a video link, or ask your agent to play something.";
    }
  }

  return { shows };
}

// --- Cards -----------------------------------------------------------

// Runtimes read the same everywhere: "1h 58m", "49m".
function runtime(seconds) {
  const minutes = Math.round(Number(seconds) / 60);
  if (!(minutes > 0)) return null;
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes}m`;
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

const metaLine = (...parts) => parts.filter(Boolean).join(" · ");

function progressHtml(fraction) {
  if (!(fraction > 0)) return "";
  const percent = Math.min(fraction * 100, 100).toFixed(1);
  return `<div class="card-progress" aria-hidden="true"><div class="card-progress-fill" style="width:${percent}%"></div></div>`;
}

// One card: artwork (with its watched mark and progress), then a title and
// one line of metadata. `shape` is "still" (16:9) or "poster" (2:3).
function cardElement({ shape, artwork, artworkOptions, watched = false, progress = 0, title, meta, className = "" }) {
  const el = document.createElement("div");
  el.className = `browse-card ${shape}${className ? ` ${className}` : ""}`;
  el.innerHTML = `
    <div class="browse-card-thumb">${artwork ?? artworkImage(null)}${watched ? WATCHED_BADGE : ""}${progressHtml(progress)}</div>
    <div class="browse-card-title">${escHtml(title)}</div>
    ${meta ? `<div class="browse-card-meta">${escHtml(meta)}</div>` : ""}
  `;
  return el;
}

// The card's whole area plays or opens it. A long press puts its row into
// edit mode, where the row's secondary actions show.
function addPrimaryCardAction(element, { label, onActivate, section = null, className = "browse-card-primary" } = {}) {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", (event) => {
    if (section?.classList.contains("edit-mode")) return;
    onActivate(event);
  });
  if (section) onLongPress(button, () => enterEditMode(section));
  element.appendChild(button);
  return button;
}

// A secondary action on a card (add to queue, remove). Hidden until its row
// is in edit mode or the card has keyboard focus, so a tap on the artwork
// never lands on an action the viewer cannot see.
function addCardAction(element, { kind, label, icon, onActivate }) {
  const button = document.createElement("button");
  button.className = `card-action card-action-${kind}`;
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.innerHTML = icon;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onActivate(event);
  });
  element.querySelector(".browse-card-thumb").appendChild(button);
  return button;
}

// --- Edit mode ---------------------------------------------------------

const LONG_PRESS_MS = 600;
// A mouse that moves this far drags its row: no click, no long press.
const DRAG_SLOP = 6;
let editing = null; // { section, handler }

function onLongPress(target, callback) {
  let timer = null;
  let start = null;
  const cancel = () => clearTimeout(timer);
  target.addEventListener("pointerdown", (event) => {
    cancel();
    start = { x: event.clientX, y: event.clientY };
    timer = setTimeout(callback, LONG_PRESS_MS);
  });
  target.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse" && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_SLOP) cancel();
  });
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) target.addEventListener(type, cancel);
}

function enterEditMode(section) {
  if (editing?.section === section) return;
  exitEditMode();
  section.classList.add("edit-mode");
  // A tap anywhere but a card or the Done button leaves edit mode.
  const handler = (event) => {
    if (event.target.closest(".browse-card, .section-done")) return;
    exitEditMode();
  };
  editing = { section, handler };
  setTimeout(() => {
    if (editing?.handler === handler) document.addEventListener("pointerdown", handler);
  }, 50);
}

function exitEditMode() {
  if (!editing) return;
  const { section, handler } = editing;
  editing = null;
  document.removeEventListener("pointerdown", handler);
  section.classList.remove("edit-mode");
  if (section === historySection) commitHistoryDeletes();
}

document.querySelectorAll(".section-done").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    exitEditMode();
  });
});

// A long press must not open the browser's context menu on the artwork.
browseScreen.addEventListener("contextmenu", (event) => {
  if (event.target.closest(".browse-card")) event.preventDefault();
});

// --- Playlist rendering ----------------------------------------------

export function renderPlaylists(playlists = []) {
  state.playlists = playlists;
  if (!playlistsSection || !playlistsList) return;
  playlistsList.innerHTML = "";
  const episodesOpen = episodesSection && !episodesSection.classList.contains("hidden");
  playlistsSection.classList.toggle("hidden", playlists.length === 0 || episodesOpen);

  for (const playlist of playlists) {
    const count = playlist.itemCount || 0;
    const el = cardElement({
      shape: "still",
      className: "playlist-card",
      artwork: `<div class="playlist-card-art">${PLAYLIST_ICON}</div>`,
      title: playlist.name,
      meta: metaLine(`${count} item${count === 1 ? "" : "s"}`, runtime(playlist.duration)),
    });
    addPrimaryCardAction(el, { label: `Queue playlist ${playlist.name}`, onActivate: () => enqueuePlaylist(playlist.id) });
    playlistsList.appendChild(el);
  }
}

async function enqueuePlaylist(id) {
  try {
    const result = await api(`/v1/playlists/${encodeURIComponent(id)}/enqueue`, { method: "POST", body: { position: "end" }, label: "Enqueue playlist" });
    if (result.queue) renderQueue(result.queue);
  } catch (error) {
    console.error("[playlist] Enqueue failed:", error);
  }
}

// --- Queue rendering -------------------------------------------------

export function renderQueue(queue = []) {
  state.queue = queue;
  if (!queueSection || !queueList) return;
  queueList.innerHTML = "";
  queueClear?.classList.toggle("hidden", queue.length === 0);
  const episodesOpen = episodesSection && !episodesSection.classList.contains("hidden");
  queueSection.classList.toggle("hidden", queue.length === 0 || episodesOpen);
  if (!queue.length && editing?.section === queueSection) exitEditMode();

  for (const item of queue) {
    const el = cardElement({
      shape: "still",
      artwork: artworkImage(landscapeArtwork(item.thumbnail)),
      title: item.title,
      meta: runtime(item.duration),
    });
    addCardAction(el, { kind: "remove", label: `Remove ${item.title} from queue`, icon: CLOSE_ICON, onActivate: () => removeQueueItem(item.id) });
    addPrimaryCardAction(el, { label: `Play ${item.title}`, section: queueSection, onActivate: () => startPlayback({ queueItemId: item.id }, { artwork: item.thumbnail }) });
    queueList.appendChild(el);
  }
  hydrateArtwork(queueList);
}

async function removeQueueItem(id) {
  const current = state.queue.slice();
  renderQueue(current.filter((item) => item.id !== id));
  try {
    await api(`/v1/queue/${encodeURIComponent(id)}`, { method: "DELETE", label: "Remove queue item" });
  } catch {
    renderQueue(current);
  }
}

queueClear?.addEventListener("click", async (event) => {
  event.stopPropagation();
  const current = state.queue.slice();
  renderQueue([]);
  try {
    await api("/v1/queue", { method: "DELETE", label: "Clear queue" });
  } catch {
    renderQueue(current);
  }
});

async function addToQueue(body) {
  try {
    const result = await api("/v1/queue", { method: "POST", body: { ...body, position: "end" }, label: "Add to queue" });
    if (result.queue) renderQueue(result.queue);
  } catch (error) {
    console.error("[queue] Add failed:", error);
  }
}

// --- Rows of library and history cards ---------------------------------

// Continue Watching is a row of 16:9 stills (a movie shows its background
// art, not its poster); Movies and TV Shows are rows of posters.
function renderCardRow(container, items, { type }) {
  container.innerHTML = "";
  const section = container.closest(".browse-section");
  for (const item of items) {
    let meta = "";
    let progress = 0;
    let watched = false;
    if (type === "history") {
      meta = metaLine(runtime(item.duration), timeAgo(item.updatedAt));
      watched = isFinished(item.position, item.duration);
      progress = !watched && item.position > 0 && item.duration ? item.position / item.duration : 0;
    } else if (type === "movie") {
      meta = metaLine(item.year, runtime(item.duration));
      watched = Boolean(item.watched);
      progress = item.resumeAt && item.duration ? item.resumeAt / item.duration : 0;
    } else if (type === "show") {
      meta = item.episodes ? `${item.episodes} episodes` : "";
      watched = item.episodes > 0 && item.watchedEpisodes >= item.episodes;
    }
    const still = type === "history";
    const el = cardElement({
      shape: still ? "still" : "poster",
      artwork: artworkImage(still ? landscapeArtwork(item.thumbnail) : item.thumbnail),
      watched,
      progress,
      title: item.title,
      meta,
    });

    const queueRef = type === "history" ? { source: item.source } : type === "movie" ? { itemId: item.id } : null;
    if (queueRef) {
      addCardAction(el, { kind: "queue", label: `Add ${item.title} to queue`, icon: QUEUE_ICON, onActivate: () => addToQueue(queueRef) });
    }

    if (type === "history") {
      addCardAction(el, {
        kind: "remove",
        label: `Remove ${item.title} from history`,
        icon: CLOSE_ICON,
        onActivate: () => {
          el.classList.add("deleted");
          pendingDeletes.push({ item, el });
        },
      });

      const undoBtn = document.createElement("button");
      undoBtn.className = "browse-card-undo";
      undoBtn.type = "button";
      undoBtn.setAttribute("aria-label", `Undo removing ${item.title}`);
      undoBtn.innerHTML = UNDO_ICON;
      undoBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        el.classList.remove("deleted");
        const index = pendingDeletes.findIndex((pending) => pending.el === el);
        if (index !== -1) pendingDeletes.splice(index, 1);
      });
      el.querySelector(".browse-card-thumb").appendChild(undoBtn);

      addPrimaryCardAction(el, { label: `Resume ${item.title}`, section, onActivate: () => startPlayback({ source: item.source }, { artwork: item.thumbnail }) });
    } else {
      addPrimaryCardAction(el, {
        label: `${type === "show" ? "Open" : "Play"} ${item.title}`,
        section: queueRef ? section : null,
        onActivate: () => {
          if (type === "movie") startPlayback({ itemId: item.id }, { artwork: item.thumbnail });
          else openEpisodes(item);
        },
      });
    }
    container.appendChild(el);
  }
  hydrateArtwork(container);
}

// --- History deletes ---------------------------------------------------

const pendingDeletes = [];

function commitHistoryDeletes() {
  for (const { item, el } of pendingDeletes) {
    api("/v1/history", { method: "DELETE", body: { sourceKey: item.sourceKey }, label: "Delete history item" }).catch(() => {});
    el.remove();
  }
  pendingDeletes.length = 0;
  if (historyList.children.length === 0) historySection.classList.add("hidden");
}

// --- Play items ------------------------------------------------------

// Play an item where a tap plays (play-target.js): on this screen, where the
// stream arrives as `load`, or on the device that plays now. Without a start
// position, Yolo resumes where this item was left (or where the source
// itself left it). Playing here, it returns the request, settled either way;
// the item's `artwork` shows under the spinner until its picture moves.
const tapTarget = () => (context.profile
  ? playTarget({ profile: context.profile.name, canPlay: context.profile.canPlay, hub: state.hub, devices: state.devices || [], self: state.deviceId })
  : { here: true });

export function startPlayback(ref, { artwork = null } = {}) {
  exitEditMode();
  const target = tapTarget();
  if (target.deviceId) {
    void playElsewhere(ref, target.deviceId);
    return;
  }
  if (target.choose) {
    if (!target.choose.length) context.notify("Nothing can play right now. Open Yolo in the car or on a computer.");
    else context.remote?.pickForPlay(target.choose, (deviceId) => playElsewhere(ref, deviceId));
    return;
  }
  browseScreen.classList.add("hidden");
  playsStarted += 1;
  showLoading({ artwork });
  return playOnThisDevice(ref).catch((error) => {
    console.error("[playback] Play failed:", error);
    // One sentence and a way out, like any final playback error; the
    // details go to the device events and /diag.
    showPlaybackError(error, { retry: () => startPlayback(ref, { artwork }) });
  });
}

async function playElsewhere(ref, deviceId) {
  const name = (state.devices || []).find((device) => device.id === deviceId)?.name ?? "the other screen";
  context.notify(`Playing on ${name}`);
  try {
    await api("/v1/playback/play", { method: "POST", body: { ...ref, deviceId }, timeoutMs: 90_000, retries: 0, label: "Play" });
  } catch (error) {
    context.notify(error.message);
  }
}

// --- Search ------------------------------------------------------------

// Search the libraries as the owner types; a pasted http(s) link offers to
// play it or queue it (a source plugin claims it when it plays).
const SEARCH_DELAY_MS = 300;
const isLink = (text) => /^https?:\/\/\S+$/i.test(text);
let searchTimer = null;
let searchRequest = 0;

function searchCard(item) {
  const kind = item.kind || item.type;
  const opens = kind === "show" || kind === "season";
  const still = kind === "episode";
  const meta = kind === "show"
    ? (item.episodes ? `${item.episodes} episodes` : "Series")
    : kind === "episode"
      ? metaLine(item.season != null && item.episode != null ? `S${item.season} · E${item.episode}` : null, runtime(item.duration))
      : metaLine(item.year, runtime(item.duration));
  const el = cardElement({
    shape: still ? "still" : "poster",
    artwork: artworkImage(still ? landscapeArtwork(item.thumbnail) : item.thumbnail),
    watched: Boolean(item.watched),
    progress: item.resumeAt && item.duration ? item.resumeAt / item.duration : 0,
    title: item.episodeTitle || item.title,
    meta,
  });
  if (!opens) addCardAction(el, { kind: "queue", label: `Add ${item.title} to queue`, icon: QUEUE_ICON, onActivate: () => addToQueue({ itemId: item.id }) });
  addPrimaryCardAction(el, {
    label: `${opens ? "Open" : "Play"} ${item.title}`,
    section: opens ? null : searchSection,
    onActivate: () => (opens ? openEpisodes(item) : startPlayback({ itemId: item.id }, { artwork: item.thumbnail })),
  });
  return el;
}

function linkResult(url) {
  const box = document.createElement("div");
  box.className = "link-result";
  const text = document.createElement("p");
  text.className = "link-result-url";
  text.textContent = url;
  const actions = document.createElement("div");
  actions.className = "link-result-actions";
  const play = document.createElement("button");
  play.type = "button";
  play.className = "browse-button primary";
  play.textContent = "Play link";
  play.addEventListener("click", () => startPlayback({ url }));
  const queue = document.createElement("button");
  queue.type = "button";
  queue.className = "browse-button";
  queue.textContent = "Add to queue";
  queue.addEventListener("click", () => void addToQueue({ url }).then(() => context.notify("Added to the queue")));
  actions.append(play, queue);
  box.append(text, actions);
  return box;
}

async function runSearch(query) {
  const text = query.trim();
  const request = ++searchRequest;
  if (!text) {
    clearSearch({ keepInput: true });
    return;
  }
  browseScreen.classList.add("searching");
  searchSection.classList.remove("hidden");
  searchClear?.classList.remove("hidden");
  if (isLink(text)) {
    searchTitle.textContent = "Link";
    searchResults.replaceChildren(linkResult(text));
    return;
  }
  searchTitle.textContent = `Results for “${text}”`;
  searchResults.setAttribute("aria-busy", "true");
  // Skeletons until the first results come; results already shown stay
  // while a longer query refines them.
  if (!searchResults.querySelector(".browse-card")) fillSkeletons(searchResults, "poster", { rows: 2 });
  try {
    const { results = [] } = await api(`/v1/library/search?q=${encodeURIComponent(text)}`, { label: "Search", retries: 0 });
    if (request !== searchRequest) return;
    if (!results.length) {
      const empty = document.createElement("p");
      empty.className = "browse-empty";
      empty.textContent = `Nothing in your libraries matches “${text}”.`;
      searchResults.replaceChildren(empty);
    } else {
      searchResults.replaceChildren(...results.map(searchCard));
      hydrateArtwork(searchResults);
    }
  } catch (error) {
    if (request !== searchRequest) return;
    const failed = document.createElement("p");
    failed.className = "browse-empty";
    failed.textContent = `Search failed: ${error.message}`;
    searchResults.replaceChildren(failed);
  } finally {
    if (request === searchRequest) searchResults.removeAttribute("aria-busy");
  }
}

export function clearSearch({ keepInput = false } = {}) {
  clearTimeout(searchTimer);
  searchRequest += 1;
  if (!keepInput && searchInput) searchInput.value = "";
  searchClear?.classList.toggle("hidden", !searchInput?.value);
  browseScreen.classList.remove("searching");
  searchSection?.classList.add("hidden");
  searchResults?.replaceChildren();
}

searchForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  void runSearch(searchInput.value);
  // Close the on-screen keyboard (the car's, a phone's) to show the results.
  if (matchMedia("(pointer: coarse)").matches) searchInput.blur();
});
searchInput?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const text = searchInput.value.trim();
  searchClear?.classList.toggle("hidden", !searchInput.value);
  if (!text) {
    clearSearch({ keepInput: true });
    return;
  }
  if (text.length < 2 && !isLink(text)) return;
  searchTimer = setTimeout(() => void runSearch(searchInput.value), SEARCH_DELAY_MS);
});
searchInput?.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && searchInput.value) {
    event.preventDefault();
    clearSearch();
  }
});
searchClear?.addEventListener("click", () => {
  clearSearch();
  searchInput.focus();
});

// --- Episodes --------------------------------------------------------

export async function openEpisodes(show, { updateRoute = true, isCurrent = () => true } = {}) {
  if (updateRoute) navigate(showPath(show.id));
  if (!isCurrent()) return;
  exitEditMode();
  clearSearch();
  browseScreen.classList.add("episodes-open");
  browseScreen.classList.remove("hidden");
  browseScreen.scrollTop = 0;
  statusScreen.style.display = "none";
  const knownTitle = show.title || libraryCache.shows.find((candidate) => candidate.id === show.id)?.title || "";
  epsShowTitle.textContent = knownTitle;
  // A show opened by its address has no title until its episodes come.
  if (!knownTitle) epsShowTitle.innerHTML = skeletonBar("9em");
  episodesSection.classList.remove("hidden");
  queueSection.classList.add("hidden");
  playlistsSection.classList.add("hidden");
  historySection.classList.add("hidden");
  moviesSection.classList.add("hidden");
  showsSection.classList.add("hidden");

  // A season of skeletons until the episodes come.
  const skeletonHeader = document.createElement("h2");
  skeletonHeader.className = "season-header";
  skeletonHeader.innerHTML = skeletonBar("5em");
  const skeletonGrid = document.createElement("div");
  skeletonGrid.className = "season-grid";
  episodesList.replaceChildren(skeletonHeader, skeletonGrid);
  episodesList.setAttribute("aria-busy", "true");
  fillSkeletons(skeletonGrid, "still", { rows: 3, titleLines: 1 });

  try {
    const { parent, items = [] } = await api(`/v1/library/items/${encodeURIComponent(show.id)}/children`, { label: "Episodes" });
    if (!isCurrent()) return;
    epsShowTitle.textContent = parent?.title || knownTitle;
    const showTitle = parent?.title || show.title || "";

    const seasons = new Map();
    for (const episode of items) {
      const season = episode.season || 1;
      if (!seasons.has(season)) seasons.set(season, []);
      seasons.get(season).push(episode);
    }

    // Built aside, then put in the skeletons' place in one step.
    const seasonLists = [];
    for (const [seasonNumber, episodes] of seasons) {
      const header = document.createElement("h2");
      header.className = "season-header";
      header.textContent = `Season ${seasonNumber}`;
      seasonLists.push(header);

      const grid = document.createElement("div");
      grid.className = "season-grid";

      for (const [episodeIndex, episode] of episodes.entries()) {
        const title = episode.episodeTitle || episode.title;
        const number = episode.episode ?? episodeIndex + 1;
        const progress = episode.resumeAt && episode.duration ? episode.resumeAt / episode.duration : 0;
        // Tesla Chromium can leave dynamically inserted lazy images dormant
        // when the episodes section was hidden during layout: load eagerly.
        const el = cardElement({
          shape: "still",
          className: "episode-card",
          artwork: artworkImage(episode.thumbnail, { eager: true }),
          watched: Boolean(episode.watched),
          progress,
          title,
          meta: metaLine(`E${number}`, runtime(episode.duration)),
        });
        addCardAction(el, { kind: "queue", label: `Add ${title} to queue`, icon: QUEUE_ICON, onActivate: () => addToQueue({ itemId: episode.id }) });
        addPrimaryCardAction(el, {
          label: `Play ${showTitle}, episode ${number}, ${title}`,
          section: episodesSection,
          onActivate: () => startPlayback({ itemId: episode.id }, { artwork: episode.thumbnail }),
        });
        grid.appendChild(el);
      }
      seasonLists.push(grid);
    }
    episodesList.replaceChildren(...seasonLists);
    episodesList.removeAttribute("aria-busy");
    hydrateArtwork(episodesList);
  } catch (error) {
    if (!isCurrent()) return;
    console.error("[browse] Failed to load episodes:", error);
    if (!knownTitle) epsShowTitle.textContent = "";
    showEpisodesError(show, error, isCurrent);
  }
}

function showEpisodesError(show, error, isCurrent) {
  episodesList.innerHTML = "";
  episodesList.removeAttribute("aria-busy");
  const box = document.createElement("div");
  box.className = "browse-message";
  const text = document.createElement("p");
  text.textContent = `Could not load episodes: ${error.message}`;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "browse-button";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => void openEpisodes(show, { updateRoute: false, isCurrent }));
  box.append(text, retry);
  episodesList.appendChild(box);
}

export function showBrowseFromEpisodes() {
  exitEditMode();
  browseScreen.classList.remove("episodes-open");
  browseScreen.scrollTop = 0;
  episodesSection.classList.add("hidden");
  queueSection.classList.toggle("hidden", state.queue.length === 0);
  playlistsSection.classList.toggle("hidden", state.playlists.length === 0);
  historySection.classList.remove("hidden");
  moviesSection.classList.remove("hidden");
  showsSection.classList.remove("hidden");
  navigate("/");
}

// --- Rows: arrows, edge fades, mouse drag ----------------------------

for (const wrap of document.querySelectorAll(".browse-row-wrap")) {
  const row = wrap.querySelector(".browse-row");
  for (const btn of wrap.querySelectorAll(".browse-arrow")) {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const scrollAmount = row.clientWidth * 0.7;
      row.scrollBy({ left: btn.classList.contains("left") ? -scrollAmount : scrollAmount });
    });
  }
  trackRowEdges(wrap, row);
  dragToScroll(row);
}

// Marks the edges with more cards behind them, for the fades and arrows.
// Rows fill after load and resize with the window.
function trackRowEdges(wrap, row) {
  const update = () => {
    const end = row.scrollWidth - row.clientWidth;
    // Slack for the fractional scroll positions a zoomed page leaves.
    wrap.classList.toggle("more-left", row.scrollLeft > 2);
    wrap.classList.toggle("more-right", row.scrollLeft < end - 2);
  };
  row.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe(row);
  new MutationObserver(update).observe(row, { childList: true });
}

// A mouse drags a row as a finger swipes it; touch keeps the browser's own
// scrolling. The click that ends a drag does not play the card under it.
function dragToScroll(row) {
  let drag = null;
  row.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    // Pointer moves are in window px; under the display size's zoom the
    // row scrolls in its own.
    const scale = row.getBoundingClientRect().width / row.offsetWidth || 1;
    drag = { id: event.pointerId, x: event.clientX, left: row.scrollLeft, scale, moved: false };
  });
  row.addEventListener("pointermove", (event) => {
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) <= DRAG_SLOP) return;
      drag.moved = true;
      row.setPointerCapture(event.pointerId);
      row.classList.add("dragging");
    }
    row.scrollLeft = drag.left - dx / drag.scale;
  });
  const end = (event) => {
    if (drag?.id !== event.pointerId) return;
    const { moved } = drag;
    drag = null;
    if (!moved) return;
    row.classList.remove("dragging");
    // Capture already sends the click that ends a drag to the row, not the
    // card; this drops it where a browser does not. It comes in the same
    // task as the pointerup.
    const swallow = (click) => {
      click.preventDefault();
      click.stopPropagation();
    };
    row.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => row.removeEventListener("click", swallow, { capture: true }));
  };
  row.addEventListener("pointerup", end);
  row.addEventListener("pointercancel", end);
  // Artwork and titles are not dragged out of the page.
  row.addEventListener("dragstart", (event) => event.preventDefault());
}

document.getElementById("eps-back").addEventListener("click", () => {
  showBrowseFromEpisodes();
});
