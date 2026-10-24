import { api } from "./api.js";
import { artworkImage, hydrateArtwork, landscapeArtwork } from "./artwork.js";
import { cardElement, h, icons, metaLine, runtime } from "./dom.js";
import { trackScrollEdges } from "./scroll-edges.js";
import { state } from "./state.js";
import { sourceKeyOf, subscribe } from "./store.js";

// What plays next, on the player (Agent Note 2026-10-23-up-next): in an
// item's last seconds a card names what the Hub's state says plays next
// (the queue's head, or the item's run), with Play now and a dismiss that
// lets the item stop at its end. An item that ended here and stopped there
// (dismissed, or played to its end before the card could play anything)
// leaves the end screen: everything next would have played, in a row to
// choose from, and Play again; with nothing after it, the centre button
// plays it again under "Finished". In the car the card sits on the
// driver's side (style.css).

// The card shows this long before the end, on items at least this long.
const LEAD_SECONDS = 20;
const MIN_DURATION_SECONDS = 90;
// The end screen's placeholders while Yolo answers.
const SKELETON_CARDS = 4;
// How long an item's end waits for the Hub to start what is next before the
// screen stops showing it starting (the Hub may have failed to).
const ADVANCE_WAIT_MS = 30_000;

const REPLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>';

let actions = { playNow: () => {}, play: () => {}, playAgain: () => {}, starting: () => ({ cancel() {} }), finishedHere: () => false };
let card = null;
let note = null;
let endScreen = null;
// The stream whose next the owner dismissed: its `ended` says advance: false.
let declined = null;
// The last stream the Hub named something next for: its end screen has a row.
let hadNext = null;
// The stream the end screen was made for.
let endedFor = null;
// The stream whose end the Hub is going on from, shown starting on screen.
let advancing = null;

/**
 * `playNow` plays what is next (the player's Next); `play(ref, item)` plays
 * one of the end screen's items on this screen; `playAgain` plays the item
 * that ended again; `starting(item)` shows the screen starting an item
 * (beginStarting, player.js); `finishedHere()` says whether the stream on
 * screen played to its end here.
 */
export function initUpNext({ playNow, play, playAgain, starting, finishedHere }) {
  actions = { playNow, play, playAgain, starting, finishedHere };
  subscribe(["hub"], paintUpNext);
}

/** The `ended` message for a stream that played to its end here. */
export function endedMessage(sessionId) {
  return { type: "ended", sessionId, ...(declined && declined === sessionId ? { advance: false } : {}) };
}

/**
 * A stream played to its end here, and its `ended` went out: when the Hub
 * goes on to what it names next, which takes the node a few seconds, the
 * screen shows that item starting, as a press on Next would. Its `load`
 * ends the wait (player.js); the Hub stopping instead, or no stream within
 * ADVANCE_WAIT_MS, puts the screen back, to the end screen or "Finished".
 */
export function advanceAfterEnd(sessionId) {
  const upNext = state.hub?.sessionId && state.hub.sessionId === sessionId ? state.hub.upNext : null;
  if (!upNext?.item || declined === sessionId) return;
  const mine = { sessionId, started: actions.starting(upNext.item) };
  mine.timer = setTimeout(() => stopAdvancing(mine), ADVANCE_WAIT_MS);
  advancing = mine;
}

function stopAdvancing(wait) {
  if (advancing !== wait) return;
  clearTimeout(wait.timer);
  advancing = null;
  if (state.sessionId === wait.sessionId) wait.started.cancel();
  paintUpNext();
}

function buildCard() {
  const thumb = h("div", { class: "up-next-thumb" });
  const eyebrow = h("div", { class: "up-next-eyebrow" });
  const title = h("div", { class: "up-next-title" });
  const from = h("div", { class: "up-next-from" });
  const playNow = h("button", { type: "button", class: "browse-button primary", onclick: () => actions.playNow() },
    h("span", { html: icons.play }), h("span", { text: "Play now" }));
  const dismiss = h("button", {
    type: "button",
    class: "icon-button",
    "aria-label": "Don't play next",
    html: icons.close,
    onclick: () => {
      declined = state.sessionId;
      paintUpNext();
    },
  });
  card = h("section", { class: "up-next hidden", "aria-label": "Up next" },
    thumb, h("div", { class: "up-next-text" }, eyebrow, title, from), h("div", { class: "up-next-actions" }, playNow, dismiss));
  card.parts = { thumb, eyebrow, title, from };
  document.getElementById("app")?.append(card);
}

const FROM = {
  queue: () => "From your queue",
  history: () => "Next in your history",
  sequence: (upNext) => upNext.title || "",
};

function paintCard() {
  const upNext = state.hub?.sessionId && state.hub.sessionId === state.sessionId ? state.hub.upNext : null;
  if (upNext?.item) hadNext = state.sessionId;
  const remaining = (Number(state.duration) || 0) - (Number(state.currentTime) || 0);
  const shown = Boolean(state.player && upNext?.item && !state.isLive && state.duration >= MIN_DURATION_SECONDS
    && remaining > 0 && remaining <= LEAD_SECONDS && declined !== state.sessionId);
  if (!shown) {
    card?.classList.add("hidden");
    return;
  }
  if (!card) buildCard();
  const { thumb, eyebrow, title, from } = card.parts;
  eyebrow.textContent = `Up next in ${Math.ceil(remaining)} s`;
  title.textContent = upNext.item.title || upNext.item.label || "The next item";
  from.textContent = (FROM[upNext.from] ?? (() => ""))(upNext);
  const picture = upNext.item.thumbnail ?? null;
  if (thumb.dataset.picture !== String(picture)) {
    thumb.dataset.picture = String(picture);
    thumb.innerHTML = artworkImage(landscapeArtwork(picture));
    hydrateArtwork(thumb);
  }
  // Play now fills from the left as the item runs out.
  card.style.setProperty("--elapsed", `${Math.round((1 - remaining / LEAD_SECONDS) * 100)}%`);
  card.classList.remove("hidden");
}

// --- The end of an item ---------------------------------------------------

// One of the items next would have played, as a home screen card that plays
// it here: a queue item from the queue, anything else directly (which
// gives it its own run).
function endCard({ from, queueItemId = null, item }) {
  const title = item.title || item.label || "Untitled";
  const meta = metaLine(item.title ? item.label : null, from === "queue" ? "In your queue" : null, runtime(item.duration));
  const element = cardElement({ shape: "still", artwork: artworkImage(landscapeArtwork(item.thumbnail ?? null)), title, meta });
  const ref = from === "queue" && queueItemId ? { queueItemId } : { source: item.source };
  element.append(h("button", {
    type: "button",
    class: "browse-card-primary",
    "aria-label": `Play ${title}`,
    onclick: () => actions.play(ref, { ...item, title }),
  }));
  return element;
}

const skeletonCard = () => h("div", { class: "skeleton-card still", "aria-hidden": "true" },
  h("div", { class: "browse-card-thumb skeleton" }),
  h("div", { class: "browse-card-title" }, h("span", { class: "skeleton skeleton-bar", style: "width:80%" })),
  h("div", { class: "browse-card-meta" }, h("span", { class: "skeleton skeleton-bar", style: "width:40%" })));

function buildEndScreen() {
  const heading = h("h2", { class: "end-screen-title", text: "Up next" });
  const row = h("div", { class: "browse-row" });
  const wrap = h("div", { class: "browse-row-wrap" }, row);
  const replay = h("button", { type: "button", class: "browse-button", onclick: () => actions.playAgain() },
    h("span", { html: REPLAY_ICON }), h("span", { text: "Play again" }));
  endScreen = h("section", { class: "end-screen hidden", "aria-label": "Finished" },
    h("header", { class: "end-screen-head" },
      h("div", { class: "end-screen-heading" }, h("p", { class: "end-screen-eyebrow", text: "Finished" }), heading),
      replay),
    wrap);
  endScreen.parts = { heading, row };
  trackScrollEdges(row, { marked: wrap });
  document.getElementById("app")?.append(endScreen);
}

// The row for the stream that ended: placeholders at once, then what Yolo
// says next would have played; with nothing there after all, "Finished".
async function fillEndScreen(sessionId, key) {
  if (!endScreen) buildEndScreen();
  const { heading, row } = endScreen.parts;
  heading.textContent = "Up next";
  row.replaceChildren(...Array.from({ length: SKELETON_CARDS }, skeletonCard));
  row.scrollLeft = 0;
  let list = null;
  try {
    list = await api(`/v1/playback/up-next?after=${encodeURIComponent(key)}`, { label: "Up next", retries: 1 });
  } catch {
    // Without the list, "Finished" alone.
  }
  if (endedFor !== sessionId) return;
  const items = Array.isArray(list?.items) ? list.items : [];
  if (!items.length) {
    hadNext = null;
    paintUpNext();
    return;
  }
  heading.textContent = list.title ? `More from ${list.title}` : "Up next";
  row.replaceChildren(...items.map(endCard));
  hydrateArtwork(row);
}

// Ended here, and the Hub went idle: nothing followed it.
function paintFinished() {
  // The next stream came (its `load` ended the wait), or the Hub stopped.
  if (advancing && (state.sessionId !== advancing.sessionId || !state.hub?.sessionId)) stopAdvancing(advancing);
  const finished = Boolean(state.player && actions.finishedHere() && state.hub && !state.hub.sessionId);
  const withRow = finished && hadNext === state.sessionId;
  const app = document.getElementById("app");
  app?.classList.toggle("finished", finished && !withRow);
  app?.classList.toggle("end-screen-shown", withRow);
  if (withRow && endedFor !== state.sessionId) {
    endedFor = state.sessionId;
    void fillEndScreen(state.sessionId, sourceKeyOf(state.source));
  }
  if (!withRow) endedFor = null;
  endScreen?.classList.toggle("hidden", !withRow);
  if (!finished || withRow) {
    note?.classList.add("hidden");
    return;
  }
  if (!note) {
    note = h("div", { class: "finished-note hidden", role: "status" },
      h("strong", { text: "Finished" }), h("span", { text: "Nothing else is up next" }));
    app?.append(note);
  }
  note.classList.remove("hidden");
  document.getElementById("btn-center-play")?.setAttribute("aria-label", "Play again");
}

/** Redraws the card and the end of an item from `state`: the player's time updates and every Hub state. */
export function paintUpNext() {
  paintCard();
  paintFinished();
}

/** The centre button plays the item again while "Finished" shows. */
export const showingFinished = () => Boolean(note && !note.classList.contains("hidden"));
