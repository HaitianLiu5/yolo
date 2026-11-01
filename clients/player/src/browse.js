import { state } from "./state.js";
import { continueCandidates, share, subscribe } from "./store.js";
import { fmt, timeAgo } from "./utils.js";
import { cardElement, h, metaLine, runtime } from "./dom.js";
import { t } from "./i18n.js";
import { navigate, parseRoute, showPath } from "./router.js";
import { showLoading, showPlaybackError } from "./player-screens.js";
import { hideStatus, showStatus, statusShown } from "./status.js";
import { api } from "./api.js";
import { artworkImage, hydrateArtwork, landscapeArtwork } from "./artwork.js";
import { continueHere, playOnThisDevice, warmPlayback } from "./playback.js";
import { livePosition, playTarget } from "./play-target.js";
import { trackScrollEdges } from "./scroll-edges.js";
import { endLaunch } from "./launch.js";
import { createWelcomeWait, WAIT_TIMED_OUT, waitTimedOut } from "./welcome-wait.js";

// The home screen (queue, continue watching, playlists, libraries, search)
// and a show's episodes, over Yolo's /v1 API.

// Set by main.js: the mode (mode.js), the remote (remote.js), a short
// notice on the home screen, `remember(patch)`, which keeps what the rows
// show for the next start (home-cache.js), and `welcomed()`, which resolves
// once Yolo's Hub has welcomed this page: until then, rows shown from that
// cache are for looking only, and a tap waits for it.
const context = {
  mode: null, remote: null, notify: (text) => showStatus(text), remember: () => {}, welcomed: () => Promise.resolve(),
};
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
const takeoverSection = document.getElementById("takeover-section");
const takeoverList = document.getElementById("takeover-list");
const takeoverHanded = document.getElementById("takeover-handed");
const historyList = document.getElementById("history-list");
const moviesSection = document.getElementById("movies-section");
const moviesList = document.getElementById("movies-list");
const showsSection = document.getElementById("shows-section");
const showsList = document.getElementById("shows-list");
const episodesSection = document.getElementById("episodes-section");
const episodesList = document.getElementById("episodes-list");
const epsShowTitle = document.getElementById("eps-show-title");
const homeAlert = document.getElementById("home-alert");
const homeAlertText = document.getElementById("home-alert-text");
const homeEmpty = document.getElementById("home-empty");
const homeEmptyText = document.getElementById("home-empty-text");
const searchSection = document.getElementById("search-section");
const searchResults = document.getElementById("search-results");
const searchTitle = document.getElementById("search-title");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const searchClear = document.getElementById("search-clear");

const QUEUE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
const UNDO_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>';
const PLAYLIST_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 6h14v2H4V6zm0 5h14v2H4v-2zm0 5h10v2H4v-2zm16-7v10l-7-5 7-5z"/></svg>';

// A show's episodes, counted.
const episodeCount = (count) => (count === 1 ? t("1 episode") : t("{count} episodes", { count }));

// At its end: within the last minute (or 5%), the same rule as Yolo's history.
const isFinished = (position, duration) => duration > 0 && position >= duration - Math.min(60, duration * 0.05);

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
  // Its place in the row: the shimmer crosses the row card after card.
  el.style.setProperty("--skeleton-index", String(index));
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
  rendered.delete(container);
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
// The tap that waits for the page's welcome (startPlayback): the latest one only.
const tapWait = createWelcomeWait(() => context.welcomed());

/** Taps on items on this page so far, started or waiting (main.js: a tap before a welcome wins over resuming). */
export const tapsSoFar = () => playsStarted + (tapWait.waiting ? 1 : 0);

/** The tap that waits for the welcome goes without playing (the screen pairs again). */
export function dropWaitingTap() {
  tapWait.drop();
}

// What each row last drew, by its data: the same items again (the cache's
// rows confirmed by Yolo, a load that overlapped another) change nothing
// on screen, so nothing flickers or loads its artwork again.
const rendered = new WeakMap();
function unchanged(container, items, kind) {
  const signature = `${kind}:${JSON.stringify(items)}`;
  if (rendered.get(container) === signature) return true;
  rendered.set(container, signature);
  return false;
}

function revealHome() {
  // Shown already (a load after a reconnect): it stays where it is scrolled.
  const shown = !browseScreen.classList.contains("hidden") && !browseScreen.classList.contains("episodes-open")
    && !statusShown();
  browseScreen.classList.remove("episodes-open");
  if (!shown) browseScreen.scrollTop = 0;
  // The header (search, settings) shows even with nothing else to show.
  browseScreen.classList.remove("hidden");
  hideStatus();
  // Reset episodes view only when returning to the browse route. A stale
  // browse request must never hide an already-open show.
  episodesSection.classList.add("hidden");
  endLaunch();
}

// A row's items came, or Yolo could not say: its skeleton goes. `settled`
// rows keep what they show on the next load.
function endSkeleton(section, list, { settled }) {
  section.classList.remove("loading");
  section.removeAttribute("aria-busy");
  if (list.querySelector(".skeleton-card:not(.paging)")) {
    list.replaceChildren();
    rendered.delete(list);
  }
  if (settled) settledRows.add(list);
}

/**
 * The rows this screen showed last time (home-cache.js), drawn at once on a
 * start, before Yolo answers: each takes its place as it was, and what
 * loadBrowseScreen() brings replaces it in place. `reveal: false` only
 * draws them, for a start that shows a show's episodes or the loading
 * screen first.
 */
export function showCachedHome(rows = {}, { reveal = true } = {}) {
  const shown = {};
  if (Array.isArray(rows.queue)) shown.queue = rows.queue;
  if (Array.isArray(rows.playlists)) shown.playlists = rows.playlists;
  share(shown, { remember: false });
  const cards = [[historySection, historyList, rows.history, "history"], [moviesSection, moviesList, rows.movies, "movie"], [showsSection, showsList, rows.shows, "show"]];
  for (const [section, list, items, type] of cards) {
    if (!Array.isArray(items)) continue;
    if (items.length) renderCardRow(list, items, { type });
    section.classList.toggle("hidden", items.length === 0);
    settledRows.add(list);
  }
  if (Array.isArray(rows.shows)) libraryCache.shows = rows.shows;
  if (!reveal) return;
  revealHome();
  homeEmpty.classList.add("hidden");
}

// The home screen's data from Yolo: the queue, playlists, history, and the
// libraries (`first`), then each library's items (`items`). Loads that
// overlap share one fetch; so do a start's, before the page's first
// welcome, and the one that welcome brings, the last to use it.
let homeFetch = null;
let startFetch = null;

function homeData() {
  if (!startFetch) return fetchHome();
  const loads = startFetch;
  if (state.welcomed) startFetch = null;
  return loads;
}

/**
 * The start's answers go unused: its welcome resumed an item or played a
 * tap instead of showing the home screen, or the screen pairs again. A
 * later load (Back from the player) asks Yolo again.
 */
export function dropStartData() {
  startFetch = null;
}

function fetchHome() {
  if (homeFetch) return homeFetch;
  const first = Promise.allSettled([
    api("/v1/queue", { label: "Queue" }),
    api("/v1/playlists", { label: "Playlists" }),
    api("/v1/history?limit=30", { label: "History" }),
    api("/v1/library", { label: "Libraries" }),
  ]);
  // The first page of every movie and show library.
  const items = first.then(([, , , libsRes]) => {
    const libs = libsRes.status === "fulfilled" ? libsRes.value?.libraries || [] : [];
    const movieLibs = libs.filter((library) => library.type === "movie");
    const showLibs = libs.filter((library) => library.type === "show");
    return Promise.all([
      Promise.allSettled(movieLibs.map((library) => libraryPage(library, 0))),
      Promise.allSettled(showLibs.map((library) => libraryPage(library, 0))),
    ]).then(([movieLibraryResults, showLibraryResults]) => ({ movieLibs, showLibs, movieLibraryResults, showLibraryResults }));
  });
  // When it was asked: the queue and playlists of a fetch asked before the
  // page's latest welcome are older than the welcome's own.
  const current = { first, items, askedAt: performance.now() };
  homeFetch = current;
  void items.finally(() => {
    if (homeFetch === current) homeFetch = null;
  });
  return current;
}

/**
 * What a start drew from a record it could not finish drawing goes from the
 * page's state (main.js), without share(): drawing it is what failed.
 */
export function forgetShownRows() {
  state.queue = [];
  state.playlists = [];
  libraryCache.shows = [];
}

/** A start asks Yolo for the home screen's data now, before its welcome, for its loads until then and the welcome's. */
export function prefetchHome() {
  startFetch ??= fetchHome();
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

  // The home screen shows at once: rows that had items keep them until
  // new ones replace them in place, and the first load shows its rows as
  // skeletons (with a bar for the title, which rows will come is not known
  // yet), and fills each one as its items come.
  const startedPlays = playsStarted;
  const reveal = revealBrowse && isCurrent();
  const waiting = reveal ? HOME_ROWS.filter(([, list]) => !settledRows.has(list)) : [];
  if (reveal) revealHome();
  if (waiting.length) {
    homeEmpty.classList.add("hidden");
    for (const [section, list, shape] of waiting) {
      section.classList.remove("hidden");
      section.classList.add("loading");
      section.setAttribute("aria-busy", "true");
      fillSkeletons(list, shape);
    }
  }

  const loads = homeData();
  const [queueRes, playlistsRes, historyRes, libsRes] = await loads.first;
  if (!isCurrent()) return { shows: [] };

  const queue = queueRes.status === "fulfilled" ? queueRes.value : [];
  const playlists = playlistsRes.status === "fulfilled" ? playlistsRes.value : [];
  const history = historyRes.status === "fulfilled" ? historyRes.value : [];
  const failures = [queueRes, playlistsRes, historyRes, libsRes].filter((result) => result.status === "rejected");

  let hasContent = false;

  // A row Yolo could not give keeps what it shows; so do the queue and
  // playlists a welcome sent after these were asked for (newer, and kept
  // up to date by the Hub's broadcasts).
  const older = state.welcomedAt > loads.askedAt;
  const answered = {};
  if (queueRes.status === "fulfilled" && !older) answered.queue = queue;
  if (playlistsRes.status === "fulfilled" && !older) answered.playlists = playlists;
  share(answered);
  if (state.queue.length) hasContent = true;
  if (state.playlists.length) hasContent = true;

  if (historyRes.status === "fulfilled") {
    context.remember({ rows: { history } });
    if (history.length) renderCardRow(historyList, history, { type: "history" });
    historySection.classList.toggle("hidden", history.length === 0);
  }
  endSkeleton(historySection, historyList, { settled: historyRes.status === "fulfilled" });
  if (!historyList.querySelector(".browse-card")) historySection.classList.add("hidden");
  if (!historySection.classList.contains("hidden")) {
    hasContent = true;
    // The first cards are the likeliest taps: resolved ahead, they start
    // sooner. Another screen's session to continue goes first, where it
    // would start (Agent Note 2026-10-31-screen-sessions).
    const [handover] = takeoverCandidates();
    if (history.length && tapTarget().here) {
      void warmPlayback([...(handover ? [warmEntry(handover)] : []), ...history.slice(0, 3).map((entry) => entry.source)].slice(0, 3));
      warmedHandover = handover ? sessionKey(handover) : warmedHandover;
    }
  }

  // The libraries are known: a row that will come gets its title, one that
  // will not goes.
  const libs = libsRes.status === "fulfilled" ? libsRes.value?.libraries || [] : [];
  const comesMovies = libs.some((library) => library.type === "movie");
  const comesShows = libs.some((library) => library.type === "show");
  for (const [section, list, comes] of [[moviesSection, moviesList, comesMovies], [showsSection, showsList, comesShows]]) {
    if (!list.querySelector(".skeleton-card:not(.paging)")) continue;
    if (comes) {
      section.classList.remove("loading");
    } else {
      section.classList.add("hidden");
      endSkeleton(section, list, { settled: libsRes.status === "fulfilled" });
    }
  }

  const { movieLibs, showLibs, movieLibraryResults, showLibraryResults } = await loads.items;
  if (!isCurrent()) return { shows: [] };

  // Each row holds every library of its kind. A row Yolo could not give in
  // full keeps what it shows, or what of it came.
  const libraryRows = [
    [moviesSection, moviesList, "movie", movieLibs, movieLibraryResults],
    [showsSection, showsList, "show", showLibs, showLibraryResults],
  ];
  for (const [section, list, type, rowLibs, results] of libraryRows) {
    const known = libsRes.status === "fulfilled" && results.every((result) => result.status === "fulfilled");
    const pages = results.map((result) => (result.status === "fulfilled" ? result.value : null));
    const items = mergePages(pages);
    const shows = type === "show";
    if (known || items.length) {
      if (shows) libraryCache.shows = items;
      if (known) context.remember({ rows: { [shows ? "shows" : "movies"]: items } });
      if (!items.length) {
        pagers.get(list)?.stop();
      } else if (renderCardRow(list, items, { type }) || !pagers.has(list)) {
        const cursors = rowLibs.map((library, index) => (pages[index] ? libraryCursor(library, pages[index]) : null)).filter(Boolean);
        pageRow(list, { type, items, cursors, onPage: shows ? (added) => libraryCache.shows.push(...added) : undefined });
      }
      section.classList.toggle("hidden", items.length === 0);
    } else if (!list.querySelector(".browse-card")) {
      section.classList.add("hidden");
    }
    if (!section.classList.contains("hidden")) hasContent = true;
    endSkeleton(section, list, { settled: known });
  }

  // The home media node is offline: Yolo answered, but the libraries
  // could not come. Or Yolo itself did not answer. Either way the band
  // says so, with what still works, and Try again; rows kept stay under it.
  const nodeOffline = [libsRes, ...movieLibraryResults, ...showLibraryResults]
    .some((result) => result.status === "rejected" && result.reason?.code === "node_offline");
  const yoloDown = failures.length === 4;
  const trouble = yoloDown
    ? t("Could not load the home screen: {message}", { message: failures[0].reason?.message || t("Yolo did not answer") })
    : nodeOffline ? t("Your media node at home is offline, so your libraries cannot show and nothing can play until it is back. Your queue, playlists, and history are still here.") : "";
  homeAlertText.textContent = trouble;
  homeAlert.classList.toggle("hidden", !trouble);

  if (reveal && playsStarted === startedPlays) {
    // Nothing came back because Yolo could not be asked, not because the
    // library is empty: the band says so instead.
    homeEmpty.classList.toggle("hidden", hasContent || yoloDown);
    if (!hasContent) homeEmptyText.textContent = t("Nothing here yet. Search, paste a video link, or ask your agent to play something.");
  }

  return { shows: libraryCache.shows };
}

// --- Cards -----------------------------------------------------------

// The card's whole area plays or opens it. A long press puts its row into
// edit mode, where the row's secondary actions show.
function addPrimaryCardAction(element, { label, onActivate, section = null, className = "browse-card-primary" } = {}) {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", (event) => {
    if (section?.classList.contains("edit-mode")) return;
    pressedCard = element;
    try {
      onActivate(event);
    } finally {
      pressedCard = null;
    }
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

// Drawn from the store (store.js); `remember: false` for rows drawn from
// the cache itself.
subscribe(["playlists"], drawPlaylists);

function drawPlaylists({ remember = true } = {}) {
  const playlists = state.playlists || [];
  if (!playlistsSection || !playlistsList) return;
  const episodesOpen = episodesSection && !episodesSection.classList.contains("hidden");
  playlistsSection.classList.toggle("hidden", playlists.length === 0 || episodesOpen);
  if (unchanged(playlistsList, playlists, "playlists")) return;
  if (remember) context.remember({ rows: { playlists } });
  playlistsList.replaceChildren();

  for (const playlist of playlists) {
    const count = playlist.itemCount || 0;
    const el = cardElement({
      shape: "still",
      className: "playlist-card",
      artwork: `<div class="playlist-card-art">${PLAYLIST_ICON}</div>`,
      title: playlist.name,
      meta: metaLine(count === 1 ? t("1 item") : t("{count} items", { count }), runtime(playlist.duration)),
    });
    addPrimaryCardAction(el, { label: t("Queue playlist {name}", { name: playlist.name }), onActivate: () => enqueuePlaylist(playlist.id) });
    playlistsList.appendChild(el);
  }
}

async function enqueuePlaylist(id) {
  try {
    const result = await api(`/v1/playlists/${encodeURIComponent(id)}/enqueue`, { method: "POST", body: { position: "end" }, label: "Enqueue playlist" });
    if (result.queue) share({ queue: result.queue });
  } catch (error) {
    console.error("[playlist] Enqueue failed:", error);
  }
}

// --- Queue rendering -------------------------------------------------

subscribe(["queue"], drawQueue);

function drawQueue({ remember = true } = {}) {
  const queue = state.queue || [];
  if (!queueSection || !queueList) return;
  queueClear?.classList.toggle("hidden", queue.length === 0);
  const episodesOpen = episodesSection && !episodesSection.classList.contains("hidden");
  queueSection.classList.toggle("hidden", queue.length === 0 || episodesOpen);
  if (!queue.length && editing?.section === queueSection) exitEditMode();
  if (unchanged(queueList, queue, "queue")) return;
  if (remember) context.remember({ rows: { queue } });
  queueList.replaceChildren();

  for (const item of queue) {
    const el = cardElement({
      shape: "still",
      artwork: artworkImage(landscapeArtwork(item.thumbnail)),
      title: item.title,
      meta: runtime(item.duration),
    });
    addCardAction(el, { kind: "remove", label: t("Remove {title} from queue", { title: item.title }), icon: CLOSE_ICON, onActivate: () => removeQueueItem(item.id) });
    addPrimaryCardAction(el, { label: t("Play {title}", { title: item.title }), section: queueSection, onActivate: () => startPlayback({ queueItemId: item.id }, { artwork: item.thumbnail }) });
    queueList.appendChild(el);
  }
  hydrateArtwork(queueList);
}

async function removeQueueItem(id) {
  const current = state.queue.slice();
  share({ queue: current.filter((item) => item.id !== id) });
  try {
    await api(`/v1/queue/${encodeURIComponent(id)}`, { method: "DELETE", label: "Remove queue item" });
  } catch {
    share({ queue: current });
  }
}

queueClear?.addEventListener("click", async (event) => {
  event.stopPropagation();
  const current = state.queue.slice();
  share({ queue: [] });
  try {
    await api("/v1/queue", { method: "DELETE", label: "Clear queue" });
  } catch {
    share({ queue: current });
  }
});

async function addToQueue(body) {
  try {
    const result = await api("/v1/queue", { method: "POST", body: { ...body, position: "end" }, label: "Add to queue" });
    if (result.queue) share({ queue: result.queue });
  } catch (error) {
    console.error("[queue] Add failed:", error);
  }
}

// --- Rows of library and history cards ---------------------------------

// Continue Watching is a row of 16:9 stills (a movie shows its background
// art, not its poster); Movies and TV Shows are rows of posters.
// True when it drew them, false when the row showed these items already.
function renderCardRow(container, items, { type }) {
  if (unchanged(container, items, type)) return false;
  container.replaceChildren();
  appendCards(container, items, { type });
  return true;
}

// Cards for `items` at a row's end: the row's items, or a library's next page.
function appendCards(container, items, { type }) {
  const section = container.closest(".browse-section");
  for (const item of items) {
    let meta = "";
    let progress = 0;
    let watched = false;
    if (type === "history") {
      meta = metaLine(runtime(item.duration), timeAgo(item.updatedAt));
      // Yolo keeps the mark; a watched item played again shows how far.
      watched = Boolean(item.watched);
      progress = !isFinished(item.position, item.duration) && item.position > 0 && item.duration ? item.position / item.duration : 0;
    } else if (type === "movie") {
      meta = metaLine(item.year, runtime(item.duration));
      watched = Boolean(item.watched);
      progress = item.resumeAt && item.duration ? item.resumeAt / item.duration : 0;
    } else if (type === "show") {
      meta = item.episodes ? episodeCount(item.episodes) : "";
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
      addCardAction(el, { kind: "queue", label: t("Add {title} to queue", { title: item.title }), icon: QUEUE_ICON, onActivate: () => addToQueue(queueRef) });
    }

    if (type === "history") {
      addCardAction(el, {
        kind: "remove",
        label: t("Remove {title} from history", { title: item.title }),
        icon: CLOSE_ICON,
        onActivate: () => {
          el.classList.add("deleted");
          pendingDeletes.push({ item, el });
        },
      });

      const undoBtn = document.createElement("button");
      undoBtn.className = "browse-card-undo";
      undoBtn.type = "button";
      undoBtn.setAttribute("aria-label", t("Undo removing {title}", { title: item.title }));
      undoBtn.innerHTML = UNDO_ICON;
      undoBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        el.classList.remove("deleted");
        const index = pendingDeletes.findIndex((pending) => pending.el === el);
        if (index !== -1) pendingDeletes.splice(index, 1);
      });
      el.querySelector(".browse-card-thumb").appendChild(undoBtn);

      addPrimaryCardAction(el, { label: t("Resume {title}", { title: item.title }), section, onActivate: () => startPlayback({ source: item.source }, { artwork: item.thumbnail }) });
    } else {
      addPrimaryCardAction(el, {
        label: type === "show" ? t("Open {title}", { title: item.title }) : t("Play {title}", { title: item.title }),
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

// --- Library rows, page by page ------------------------------------------

// Movies and TV Shows each hold every library of their kind: the first page
// of each comes with the home screen, and the next page, a library at a
// time in Yolo's order, as the row nears its end. A page that fails leaves
// a Try again at the row's end.
const LIBRARY_PAGE = 100;
const MORE_SKELETONS = 3;
const pagers = new Map();

const libraryPage = (library, offset) => api(
  `/v1/library/${encodeURIComponent(library.id)}/items?offset=${offset}&limit=${LIBRARY_PAGE}`,
  { label: `Library ${library.title}` },
);

// Where each library goes on from its first page: done when Yolo said how
// many there are and all came, or when a page came short.
function libraryCursor(library, page) {
  const items = page?.items || [];
  const next = (Number(page?.offset) || 0) + items.length;
  const total = Number.isFinite(page?.total) ? page.total : null;
  return { library, next, done: items.length === 0 || (total != null ? next >= total : items.length < LIBRARY_PAGE) };
}

// The items of every library's page in one row, each item once.
function mergePages(pages, seen = new Set()) {
  const items = [];
  for (const page of pages) {
    for (const item of page?.items || []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

/**
 * The row in `list` goes on past `items`, the first pages of `cursors`'
 * libraries, as it scrolls; a row drawn again from new first pages starts
 * over. `onPage(items)` hears each page added.
 */
function pageRow(list, { type, items, cursors, onPage = () => {} }) {
  pagers.get(list)?.stop();
  const seen = new Set(items.map((item) => item.id));
  let loading = false;
  let stopped = false;
  const observer = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void more();
    }, { root: list, rootMargin: "0px 100% 0px 0px" })
    : null;

  function watchEnd() {
    observer?.disconnect();
    const cards = list.querySelectorAll(".browse-card");
    if (cursors.some((cursor) => !cursor.done) && cards.length) observer?.observe(cards[cards.length - 1]);
  }

  async function more() {
    const cursor = cursors.find((candidate) => !candidate.done);
    if (loading || stopped || !cursor) return;
    loading = true;
    list.querySelector(".row-more")?.remove();
    const skeletons = Array.from({ length: MORE_SKELETONS }, (_, index) => skeletonCard("poster", index, 2));
    for (const skeleton of skeletons) skeleton.classList.add("paging");
    list.append(...skeletons);
    try {
      const page = await libraryPage(cursor.library, cursor.next);
      if (stopped) return;
      Object.assign(cursor, libraryCursor(cursor.library, page));
      for (const skeleton of skeletons) skeleton.remove();
      const added = mergePages([page], seen);
      if (added.length) {
        appendCards(list, added, { type });
        onPage(added);
      }
      loading = false;
      watchEnd();
      // A page with nothing new (all seen): the next one at once.
      if (!added.length) void more();
    } catch (error) {
      if (stopped) return;
      console.warn(`[browse] ${cursor.library.title} page failed:`, error);
      // Only the owner's Try again asks again, not the row moving.
      observer?.disconnect();
      for (const skeleton of skeletons) skeleton.remove();
      loading = false;
      const retry = h("button", { type: "button", class: "browse-button row-more", onclick: () => void more() }, t("Try again"));
      list.append(retry);
    }
  }

  const pager = {
    stop() {
      stopped = true;
      if (pagers.get(list) === pager) pagers.delete(list);
      observer?.disconnect();
      list.querySelector(".row-more")?.remove();
      for (const skeleton of list.querySelectorAll(".skeleton-card.paging")) skeleton.remove();
    },
  };
  pagers.set(list, pager);
  watchEnd();
}

// --- History deletes ---------------------------------------------------

const pendingDeletes = [];

function commitHistoryDeletes() {
  for (const { item, el } of pendingDeletes) {
    api("/v1/history", { method: "DELETE", body: { sourceKey: item.sourceKey }, label: "Delete history item" }).catch(() => {});
    el.remove();
  }
  pendingDeletes.length = 0;
  rendered.delete(historyList);
  if (historyList.children.length === 0) historySection.classList.add("hidden");
}

// --- Play items ------------------------------------------------------

// Play an item where a tap plays (play-target.js): on this screen, where the
// stream arrives as `load`, or on the device that plays now. Without a start
// position, Yolo resumes where this item was left (or where the source
// itself left it). Playing here, it returns the request, settled either way;
// the item's `artwork` shows under the spinner until its picture moves.
const tapTarget = () => (context.mode
  ? playTarget({ canPlay: context.mode.canPlay, devices: state.devices || [], self: state.deviceId })
  : { here: true });

// The card whose button is being pressed, while its click runs
// (addPrimaryCardAction): a tap that waits marks it.
let pressedCard = null;

// A card whose tap waits for the welcome stays pressed, and past the
// loading ring's delay shows it over its artwork, until it plays or the
// wait ends.
function markWaiting(card) {
  if (!card) return () => {};
  const ring = document.createElement("span");
  ring.className = "loading-ring on card-waiting-ring";
  ring.setAttribute("aria-hidden", "true");
  card.classList.add("waiting");
  card.setAttribute("aria-busy", "true");
  card.querySelector(".browse-card-thumb")?.append(ring);
  return () => {
    card.classList.remove("waiting");
    card.removeAttribute("aria-busy");
    ring.remove();
  };
}

export function startPlayback(ref, { artwork = null } = {}) {
  exitEditMode();
  // Before the welcome, where a tap plays is not known yet (another device
  // may be playing): the latest tap waits for it, once (welcome-wait.js).
  // The car always plays on itself, so it shows the item at once; its
  // request waits for the welcome anyway.
  if (!state.welcomed && !(context.mode?.car && context.mode.canPlay)) {
    return tapWait.later(() => (state.welcomed ? playTapped(ref, { artwork }) : undefined), {
      onEnd: markWaiting(pressedCard),
      onFail: (error) => {
        if (waitTimedOut(error)) context.notify(WAIT_TIMED_OUT);
      },
    });
  }
  return playTapped(ref, { artwork });
}

function playTapped(ref, { artwork }) {
  const target = tapTarget();
  if (target.deviceId) {
    void playElsewhere(ref, target.deviceId);
    return;
  }
  if (target.choose) {
    if (!target.choose.length) context.notify(t("Nothing can play right now. Open Yolo in the car or on a computer."));
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

// A remote's tap plays on another screen; when someone else is watching
// there, the owner is asked first (screen_busy), and only a confirm plays.
async function playElsewhere(ref, deviceId, { replace = false } = {}) {
  const name = (state.devices || []).find((device) => device.id === deviceId)?.name ?? t("the other screen");
  context.notify(t("Playing on {device}", { device: name }));
  try {
    await api("/v1/playback/play", { method: "POST", body: { ...ref, deviceId, replace }, timeoutMs: 90_000, retries: 0, label: "Play" });
  } catch (error) {
    if (error.code === "screen_busy" && !replace && context.remote?.confirmBusy) {
      if (await context.remote.confirmBusy(error.details)) await playElsewhere(ref, deviceId, { replace: true });
      return;
    }
    context.notify(error.message);
  }
}

// --- Continue from another screen (Agent Note 2026-10-31-screen-sessions) --

// The top of home: up to three other screens' sessions this screen may
// continue (store.js continueCandidates()), each with its screen, its
// picture and title, the position, and how long ago; one tap continues it
// here with its whole context, and the other screen pauses. When another
// screen continued this one's own session, that one goes first, under
// "Continued on …". A remote, which cannot play, has no card.
const sessionKey = (session) => `${session.deviceId}:${session.sessionId}`;
const warmEntry = (session) => ({ source: session.item.source, startTime: livePosition(session) });
let warmedHandover = null;

function takeoverCandidates() {
  if (context.mode && !context.mode.canPlay) return [];
  const candidates = continueCandidates();
  const handedTo = state.hub?.handedTo?.deviceId;
  const at = handedTo ? candidates.findIndex((session) => session.deviceId === handedTo) : -1;
  return at > 0 ? [candidates[at], ...candidates.slice(0, at), ...candidates.slice(at + 1)] : candidates;
}

const screenName = (deviceId) => (state.devices || []).find((device) => device.id === deviceId)?.name ?? t("another screen");

function drawTakeover() {
  const candidates = takeoverCandidates();
  takeoverSection.classList.toggle("hidden", !candidates.length);
  const handedTo = state.hub?.handedTo?.deviceId;
  const handed = Boolean(handedTo) && candidates[0]?.deviceId === handedTo;
  takeoverHanded.classList.toggle("hidden", !handed);
  takeoverHanded.textContent = handed ? t("Continued on {device}", { device: screenName(handedTo) }) : "";
  takeoverList.replaceChildren(...candidates.map((session) => {
    const position = livePosition(session);
    const duration = Number(session.item.duration) || 0;
    const profile = session.profile && session.profile.id !== "owner" ? session.profile.name : null;
    const el = cardElement({
      shape: "still",
      artwork: artworkImage(landscapeArtwork(session.item.thumbnail)),
      progress: duration > 0 && !session.item.isLive ? position / duration : 0,
      title: session.item.title || t("Playing"),
      meta: metaLine(screenName(session.deviceId), profile, session.item.isLive ? t("Live") : fmt(position), timeAgo(session.updatedAt)),
      className: "takeover-card",
    });
    addPrimaryCardAction(el, {
      label: t("Continue {title} here", { title: session.item.title || t("Playing") }),
      onActivate: () => continueOnThisScreen(session),
    });
    return el;
  }));
  hydrateArtwork(takeoverList);
  // The first one is the likeliest tap: resolved ahead where it would start.
  const [first] = candidates;
  if (first && state.welcomed && sessionKey(first) !== warmedHandover) {
    warmedHandover = sessionKey(first);
    void warmPlayback([warmEntry(first)]);
  }
}

/** Continues `session` (another screen's) on this one, at once. */
export function continueOnThisScreen(session) {
  exitEditMode();
  browseScreen.classList.add("hidden");
  playsStarted += 1;
  showLoading({ artwork: session.item?.thumbnail ?? null });
  return continueHere(session.deviceId).catch((error) => {
    console.error("[playback] Continue here failed:", error);
    showPlaybackError(error, { retry: () => continueOnThisScreen(session) });
  });
}

subscribe(["hub", "sessions"], drawTakeover);

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
    ? (item.episodes ? episodeCount(item.episodes) : t("Series"))
    : kind === "episode"
      ? metaLine(item.season != null && item.episode != null ? `${t("S{season}", { season: item.season })} · ${t("E{episode}", { episode: item.episode })}` : null, runtime(item.duration))
      : metaLine(item.year, runtime(item.duration));
  const el = cardElement({
    shape: still ? "still" : "poster",
    artwork: artworkImage(still ? landscapeArtwork(item.thumbnail) : item.thumbnail),
    watched: Boolean(item.watched),
    progress: item.resumeAt && item.duration ? item.resumeAt / item.duration : 0,
    title: item.episodeTitle || item.title,
    meta,
  });
  if (!opens) addCardAction(el, { kind: "queue", label: t("Add {title} to queue", { title: item.title }), icon: QUEUE_ICON, onActivate: () => addToQueue({ itemId: item.id }) });
  addPrimaryCardAction(el, {
    label: opens ? t("Open {title}", { title: item.title }) : t("Play {title}", { title: item.title }),
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
  play.textContent = t("Play link");
  play.addEventListener("click", () => startPlayback({ url }));
  const queue = document.createElement("button");
  queue.type = "button";
  queue.className = "browse-button";
  queue.textContent = t("Add to queue");
  queue.addEventListener("click", () => void addToQueue({ url }).then(() => context.notify(t("Added to the queue"))));
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
    searchTitle.textContent = t("Link");
    searchResults.replaceChildren(linkResult(text));
    return;
  }
  searchTitle.textContent = t("Results for “{query}”", { query: text });
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
      empty.textContent = t("Nothing in your libraries matches “{query}”.", { query: text });
      searchResults.replaceChildren(empty);
    } else {
      searchResults.replaceChildren(...results.map(searchCard));
      hydrateArtwork(searchResults);
    }
  } catch (error) {
    if (request !== searchRequest) return;
    const failed = document.createElement("p");
    failed.className = "browse-empty";
    failed.textContent = t("Search failed: {message}", { message: error.message });
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

// The show whose episodes show or are on their way: a start on /show/<id>
// opens it before its welcome, and the welcome's route then keeps it.
let openShow = null;

/**
 * `again: false` keeps the show's episodes when they are on screen or on
 * their way already (main.js, after a start opened them).
 */
export async function openEpisodes(show, { updateRoute = true, isCurrent = () => true, again = true } = {}) {
  if (updateRoute) navigate(showPath(show.id));
  if (!isCurrent()) return;
  if (!again && openShow?.id === show.id && browseScreen.classList.contains("episodes-open")) return openShow.loading;
  exitEditMode();
  clearSearch();
  browseScreen.classList.add("episodes-open");
  browseScreen.classList.remove("hidden");
  browseScreen.scrollTop = 0;
  hideStatus();
  endLaunch();
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

  const request = api(`/v1/library/items/${encodeURIComponent(show.id)}/children`, { label: "Episodes" });
  const mine = { id: show.id, loading: request.then(() => {}, () => {}) };
  openShow = mine;
  try {
    const { parent, items = [] } = await request;
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
      header.textContent = t("Season {season}", { season: seasonNumber });
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
          meta: metaLine(t("E{episode}", { episode: number }), runtime(episode.duration)),
        });
        addCardAction(el, { kind: "queue", label: t("Add {title} to queue", { title }), icon: QUEUE_ICON, onActivate: () => addToQueue({ itemId: episode.id }) });
        addPrimaryCardAction(el, {
          label: t("Play {show}, episode {number}, {title}", { show: showTitle, number, title }),
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
    // A failed show is opened again, not kept.
    if (openShow === mine) openShow = null;
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
  text.textContent = t("Could not load episodes: {message}", { message: error.message });
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "browse-button";
  retry.textContent = t("Try again");
  retry.addEventListener("click", () => void openEpisodes(show, { updateRoute: false, isCurrent }));
  box.append(text, retry);
  episodesList.appendChild(box);
}

export function showBrowseFromEpisodes() {
  exitEditMode();
  openShow = null;
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

// The band's Try again asks Yolo afresh, not for a start's answers.
const homeAlertRetry = document.getElementById("home-alert-retry");
homeAlertRetry.addEventListener("click", () => {
  dropStartData();
  homeAlertRetry.disabled = true;
  void loadBrowseScreen({ isCurrent: () => parseRoute().view === "browse" })
    .catch((error) => console.error("[browse] Home screen failed again:", error))
    .finally(() => {
      homeAlertRetry.disabled = false;
    });
});

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
  // The edges with more cards behind them, for the fades and arrows.
  trackScrollEdges(row, { marked: wrap });
  dragToScroll(row);
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
