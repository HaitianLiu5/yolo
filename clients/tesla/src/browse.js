import { state } from "./state.js";
import { timeAgo, escHtml } from "./utils.js";
import { navigate, showPath } from "./router.js";
import { showPlaybackError, showStatus } from "./player.js";
import { api } from "./api.js";
import { artworkImage, hydrateArtwork, landscapeArtwork } from "./artwork.js";
import { playOnThisDevice, setTracks } from "./playback.js";

// The home screen (queue, continue watching, playlists, libraries), a show's
// episodes, and the subtitle and audio menus, all over Yolo's /v1 API.

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

export function updateAudioUI() {
  const tracks = state.tracks.audio || [];
  const hasTrackSelection = tracks.length > 1;
  const hasBoostControl = !!state.player;

  if (!hasTrackSelection && !hasBoostControl) {
    btnAudio.classList.add("hidden");
    audioPanel.classList.add("hidden");
    return;
  }
  btnAudio.classList.remove("hidden");

  audioList.innerHTML = "";
  if (!hasTrackSelection) return;

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
// --- Browse screen ---------------------------------------------------

const libraryCache = { shows: [] };

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
  } else {
    historySection.classList.add("hidden");
  }

  const movieLib = libs.find((library) => library.type === "movie");
  const showLibs = libs.filter((library) => library.type === "show");
  const libraryItems = (library) => api(`/v1/library/${encodeURIComponent(library.id)}/items?limit=200`, { label: `Library ${library.title}` });

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

  if (revealBrowse) {
    browseScreen.classList.remove("episodes-open");
    browseScreen.scrollTop = 0;
    if (hasContent) {
      browseScreen.classList.remove("hidden");
      statusScreen.style.display = "none";
    } else {
      browseScreen.classList.add("hidden");
      statusScreen.style.display = "";
      // Nothing came back because Yolo could not be asked, not because the
      // library is empty.
      showStatus(failures.length === 4
        ? `Could not load the home screen: ${failures[0].reason?.message || "Yolo did not answer"}`
        : "Nothing here yet. Ask your agent to play something.");
    }
    // Reset episodes view only when returning to the browse route. A stale
    // browse request must never hide an already-open show.
    episodesSection.classList.add("hidden");
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
let editing = null; // { section, handler }

function onLongPress(target, callback) {
  let timer = null;
  const cancel = () => clearTimeout(timer);
  target.addEventListener("pointerdown", () => {
    cancel();
    timer = setTimeout(callback, LONG_PRESS_MS);
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
    addPrimaryCardAction(el, { label: `Play ${item.title}`, section: queueSection, onActivate: () => startPlayback({ queueItemId: item.id }) });
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

      addPrimaryCardAction(el, { label: `Resume ${item.title}`, section, onActivate: () => startPlayback({ source: item.source }) });
    } else {
      addPrimaryCardAction(el, {
        label: `${type === "show" ? "Open" : "Play"} ${item.title}`,
        section: queueRef ? section : null,
        onActivate: () => {
          if (type === "movie") startPlayback({ itemId: item.id });
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

// Ask Yolo to play on this screen; the stream arrives as `load`. Without a
// start position, Yolo resumes where this item was left (or where the
// source itself left it).
export function startPlayback(ref) {
  exitEditMode();
  showStatus("Loading...");
  browseScreen.classList.add("hidden");
  statusScreen.style.display = "";
  playOnThisDevice(ref).catch((error) => {
    console.error("[playback] Play failed:", error);
    // One sentence and a way out, like any final playback error; the
    // details go to the device events and /diag.
    showPlaybackError(error, { retry: () => startPlayback(ref) });
  });
}

// --- Episodes --------------------------------------------------------

export async function openEpisodes(show, { updateRoute = true, isCurrent = () => true } = {}) {
  if (updateRoute) navigate(showPath(show.id));
  if (!isCurrent()) return;
  exitEditMode();
  browseScreen.classList.add("episodes-open");
  browseScreen.classList.remove("hidden");
  browseScreen.scrollTop = 0;
  statusScreen.style.display = "none";
  epsShowTitle.textContent = show.title || libraryCache.shows.find((candidate) => candidate.id === show.id)?.title || "";
  episodesList.innerHTML = "";
  episodesSection.classList.remove("hidden");
  queueSection.classList.add("hidden");
  playlistsSection.classList.add("hidden");
  historySection.classList.add("hidden");
  moviesSection.classList.add("hidden");
  showsSection.classList.add("hidden");

  try {
    const { parent, items = [] } = await api(`/v1/library/items/${encodeURIComponent(show.id)}/children`, { label: "Episodes" });
    if (!isCurrent()) return;
    if (parent?.title) epsShowTitle.textContent = parent.title;
    const showTitle = parent?.title || show.title || "";

    const seasons = new Map();
    for (const episode of items) {
      const season = episode.season || 1;
      if (!seasons.has(season)) seasons.set(season, []);
      seasons.get(season).push(episode);
    }

    for (const [seasonNumber, episodes] of seasons) {
      const header = document.createElement("h2");
      header.className = "season-header";
      header.textContent = `Season ${seasonNumber}`;
      episodesList.appendChild(header);

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
          onActivate: () => startPlayback({ itemId: episode.id }),
        });
        grid.appendChild(el);
      }
      episodesList.appendChild(grid);
    }
    hydrateArtwork(episodesList);
  } catch (error) {
    if (!isCurrent()) return;
    console.error("[browse] Failed to load episodes:", error);
    showEpisodesError(show, error, isCurrent);
  }
}

function showEpisodesError(show, error, isCurrent) {
  episodesList.innerHTML = "";
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

// --- Scroll arrows ---------------------------------------------------

document.querySelectorAll(".browse-arrow").forEach((btn) => {
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    const row = btn.closest(".browse-row-wrap").querySelector(".browse-row");
    const scrollAmount = row.clientWidth * 0.7;
    row.scrollBy({ left: btn.classList.contains("left") ? -scrollAmount : scrollAmount });
  });
});

document.getElementById("eps-back").addEventListener("click", () => {
  showBrowseFromEpisodes();
});
