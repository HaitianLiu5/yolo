import { state } from "./state.js";
import { fmt, timeAgo, escHtml } from "./utils.js";
import { navigate, showPath } from "./router.js";
import { showStatus } from "./player.js";
import { api } from "./api.js";
import { artworkImage, hydrateArtwork } from "./artwork.js";
import { playOnThisDevice, setTracks } from "./playback.js";

// The home screen (queue, playlists, continue watching, libraries), a show's
// episodes, and the subtitle and audio menus, all over Yolo's /v1 API.

function escAttr(value) {
  return escHtml(String(value || "")).replace(/"/g, "&quot;");
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
const btnSubs = document.getElementById("btn-subs");
const subsPanel = document.getElementById("subs-panel");
const subsList = document.getElementById("subs-list");
const btnAudio = document.getElementById("btn-audio");
const audioPanel = document.getElementById("audio-panel");
const audioList = document.getElementById("audio-list");

const QUEUE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
const WATCHED_BADGE = '<div class="watched-badge"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>';

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
      showStatus("Nothing here yet. Ask your agent to play something.");
    }
    // Reset episodes view only when returning to the browse route. A stale
    // browse request must never hide an already-open show.
    episodesSection.classList.add("hidden");
  }

  return { shows };
}

// --- Playlist rendering ----------------------------------------------

function addPrimaryCardAction(element, { label, onActivate, className = "browse-card-primary" } = {}) {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onActivate);
  element.appendChild(button);
  return button;
}

export function renderPlaylists(playlists = []) {
  state.playlists = playlists;
  if (!playlistsSection || !playlistsList) return;
  playlistsList.innerHTML = "";
  const episodesOpen = episodesSection && !episodesSection.classList.contains("hidden");
  playlistsSection.classList.toggle("hidden", playlists.length === 0 || episodesOpen);

  for (const playlist of playlists) {
    const el = document.createElement("div");
    el.className = "browse-card playlist-card";
    const meta = [
      `${playlist.itemCount || 0} item${playlist.itemCount === 1 ? "" : "s"}`,
      playlist.duration ? fmt(playlist.duration) : null,
    ].filter(Boolean).join(" · ");
    el.innerHTML = `
      <div class="browse-card-thumb playlist-card-thumb">
        <div class="playlist-card-icon"><svg viewBox="0 0 24 24" fill="white" width="30" height="30"><path d="M4 6h14v2H4V6zm0 5h14v2H4v-2zm0 5h10v2H4v-2zm16-7v10l-7-5 7-5z"/></svg></div>
        <div class="playlist-play-badge">
          <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>
      <div class="browse-card-title">${escHtml(playlist.name)}</div>
      ${meta ? `<div class="browse-card-meta">${meta}</div>` : ""}
    `;
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

const sourceLabel = (source) => (source?.plugin ? source.plugin : "URL");

export function renderQueue(queue = []) {
  state.queue = queue;
  if (!queueSection || !queueList) return;
  queueList.innerHTML = "";
  queueClear?.classList.toggle("hidden", queue.length === 0);
  const episodesOpen = episodesSection && !episodesSection.classList.contains("hidden");
  queueSection.classList.toggle("hidden", queue.length === 0 || episodesOpen);

  queue.forEach((item, index) => {
    const el = document.createElement("div");
    el.className = "browse-card queue-card";
    const meta = [sourceLabel(item.source), item.duration ? fmt(item.duration) : null].filter(Boolean).join(" · ");
    el.innerHTML = `
      <div class="browse-card-thumb">
        ${artworkImage(item.thumbnail)}
        <div class="queue-position">${index + 1}</div>
        <button class="queue-remove" type="button" aria-label="Remove ${escAttr(item.title)} from queue">${CLOSE_ICON}</button>
      </div>
      <div class="browse-card-title">${escHtml(item.title)}</div>
      ${meta ? `<div class="browse-card-meta">${escHtml(meta)}</div>` : ""}
    `;
    el.querySelector(".queue-remove")?.addEventListener("click", (event) => {
      event.stopPropagation();
      removeQueueItem(item.id);
    });
    addPrimaryCardAction(el, { label: `Play ${item.title}`, onActivate: () => startPlayback({ queueItemId: item.id }) });
    queueList.appendChild(el);
  });
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

// --- Card rendering --------------------------------------------------

function renderCardRow(container, items, { type }) {
  container.innerHTML = "";
  const poster = type === "movie" || type === "show";
  for (const item of items) {
    const el = document.createElement("div");
    el.className = `browse-card${poster ? " poster" : ""}`;

    let meta = "";
    let progress = 0;
    let watched = false;
    if (type === "history") {
      meta = [item.duration ? fmt(item.duration) : null, timeAgo(item.updatedAt)].filter(Boolean).join(" · ");
      watched = isFinished(item.position, item.duration);
      progress = !watched && item.position > 0 && item.duration ? item.position / item.duration : 0;
    } else if (type === "movie") {
      meta = [item.year, item.duration ? `${Math.round(item.duration / 60)}min` : null].filter(Boolean).join(" · ");
      watched = Boolean(item.watched);
      progress = item.resumeAt && item.duration ? item.resumeAt / item.duration : 0;
    } else if (type === "show") {
      meta = `${item.episodes || 0} episodes`;
      watched = item.episodes > 0 && item.watchedEpisodes >= item.episodes;
    }
    const progressHtml = progress > 0
      ? `<div class="browse-card-progress-track"></div><div class="browse-card-progress" style="width:${Math.min(progress * 100, 100).toFixed(1)}%"></div>`
      : "";

    el.innerHTML = `
      <div class="browse-card-thumb">${artworkImage(item.thumbnail)}${watched ? WATCHED_BADGE : ""}${progressHtml}</div>
      <div class="browse-card-title">${escHtml(item.title)}</div>
      ${meta ? `<div class="browse-card-meta">${escHtml(meta)}</div>` : ""}
    `;

    const queueRef = type === "history" ? { source: item.source } : type === "movie" ? { itemId: item.id } : null;
    if (queueRef) {
      const queueBtn = document.createElement("button");
      queueBtn.className = "browse-card-queue";
      queueBtn.type = "button";
      queueBtn.setAttribute("aria-label", `Add ${item.title} to queue`);
      queueBtn.innerHTML = QUEUE_ICON;
      queueBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        addToQueue(queueRef);
      });
      el.querySelector(".browse-card-thumb").appendChild(queueBtn);
    }

    if (type === "history") {
      const delBtn = document.createElement("button");
      delBtn.className = "browse-card-delete";
      delBtn.type = "button";
      delBtn.setAttribute("aria-label", `Remove ${item.title} from history`);
      delBtn.innerHTML = CLOSE_ICON;
      delBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        el.classList.add("deleted");
        pendingDeletes.push({ item, el });
      });
      el.appendChild(delBtn);

      const undoBtn = document.createElement("button");
      undoBtn.className = "browse-card-undo";
      undoBtn.type = "button";
      undoBtn.setAttribute("aria-label", `Undo removing ${item.title}`);
      undoBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="white" width="24" height="24"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>`;
      undoBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        el.classList.remove("deleted");
        const index = pendingDeletes.findIndex((pending) => pending.el === el);
        if (index !== -1) pendingDeletes.splice(index, 1);
      });
      el.querySelector(".browse-card-thumb").appendChild(undoBtn);

      const primaryButton = addPrimaryCardAction(el, {
        label: `Resume ${item.title}`,
        onActivate: () => {
          if (historySection.classList.contains("edit-mode")) return;
          startPlayback({ source: item.source });
        },
      });
      // Long-press for edit mode
      let pressTimer = null;
      primaryButton.addEventListener("pointerdown", () => {
        pressTimer = setTimeout(() => enterHistoryEditMode(), 600);
      });
      primaryButton.addEventListener("pointerup", () => clearTimeout(pressTimer));
      primaryButton.addEventListener("pointerleave", () => clearTimeout(pressTimer));
      primaryButton.addEventListener("pointercancel", () => clearTimeout(pressTimer));
    } else {
      addPrimaryCardAction(el, {
        label: `${type === "show" ? "Open" : "Play"} ${item.title}`,
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

// --- History edit mode ------------------------------------------------

const pendingDeletes = [];

function enterHistoryEditMode() {
  if (historySection.classList.contains("edit-mode")) return;
  historySection.classList.add("edit-mode");
  const handler = (event) => {
    if (event.target.closest(".browse-card")) return;
    commitHistoryDeletes();
    historySection.classList.remove("edit-mode");
    document.removeEventListener("pointerdown", handler);
  };
  setTimeout(() => document.addEventListener("pointerdown", handler), 50);
}

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
  showStatus("Loading...");
  browseScreen.classList.add("hidden");
  statusScreen.style.display = "";
  playOnThisDevice(ref).catch((error) => {
    console.error("[playback] Play failed:", error);
    showStatus(`Playback error: ${error.message}`);
  });
}

// --- Episodes --------------------------------------------------------

export async function openEpisodes(show, { updateRoute = true, isCurrent = () => true } = {}) {
  if (updateRoute) navigate(showPath(show.id));
  if (!isCurrent()) return;
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
      const header = document.createElement("div");
      header.className = "season-header";
      header.textContent = `Season ${seasonNumber}`;
      episodesList.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "season-grid";

      for (const [episodeIndex, episode] of episodes.entries()) {
        const el = document.createElement("div");
        el.className = "episode-card";
        const title = episode.episodeTitle || episode.title;
        const progress = episode.resumeAt && episode.duration ? episode.resumeAt / episode.duration : 0;
        const progressHtml = progress > 0
          ? `<div class="browse-card-progress-track"></div><div class="browse-card-progress" style="width:${Math.min(progress * 100, 100).toFixed(1)}%"></div>`
          : "";
        const metaParts = [`E${episode.episode ?? episodeIndex + 1}`];
        if (episode.duration) metaParts.push(`${Math.round(episode.duration / 60)}min`);
        // Tesla Chromium can leave dynamically inserted lazy images dormant
        // when the episodes section was hidden during layout: load eagerly.
        el.innerHTML = `
          <div class="episode-card-thumb">${artworkImage(episode.thumbnail, { emptyClass: "browse-card-thumb-empty episode-thumb-empty", eager: true })}${episode.watched ? WATCHED_BADGE : ""}${progressHtml}</div>
          <div class="episode-card-title">${escHtml(title)}</div>
          <div class="episode-card-meta">${metaParts.join(" · ")}</div>
        `;
        const queueBtn = document.createElement("button");
        queueBtn.className = "browse-card-queue";
        queueBtn.type = "button";
        queueBtn.setAttribute("aria-label", `Add ${title} to queue`);
        queueBtn.innerHTML = QUEUE_ICON;
        queueBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          addToQueue({ itemId: episode.id });
        });
        el.querySelector(".episode-card-thumb").appendChild(queueBtn);

        addPrimaryCardAction(el, {
          label: `Play ${showTitle}, episode ${episode.episode ?? episodeIndex + 1}, ${title}`,
          onActivate: () => startPlayback({ itemId: episode.id }),
          className: "episode-card-primary",
        });
        grid.appendChild(el);
      }
      episodesList.appendChild(grid);
    }
    hydrateArtwork(episodesList);
  } catch (error) {
    if (!isCurrent()) return;
    console.error("[browse] Failed to load episodes:", error);
  }
}

export function showBrowseFromEpisodes() {
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

