import { api } from "./api.js";
import { artworkImage, hydrateArtwork, landscapeArtwork } from "./artwork.js";
import { cardElement, h, icons, metaLine, runtime } from "./dom.js";
import { trackScrollEdges } from "./scroll-edges.js";
import { state } from "./state.js";
import { sourceKeyOf, subscribe, upNextFor } from "./store.js";

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

let actions = { playNow: () => {}, play: () => {}, playAgain: () => {}, starting: () => ({ cancel() {} }), finishedHere: () => false };
// The parts drawn so far, each made the first time it shows.
let card = null;
let endScreen = null;
let note = null;
let noteShown = false;
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
  const upNext = upNextFor(sessionId);
  if (!upNext?.item || declined === sessionId) return;
  const wait = { sessionId, started: actions.starting(upNext.item) };
  wait.timer = setTimeout(() => {
    if (stopAdvancing(wait)) paintUpNext();
  }, ADVANCE_WAIT_MS);
  advancing = wait;
}

// Ends `wait` if it is still the one under way: the screen leaves the item
// starting, unless its `load` already took over. Says whether it did.
function stopAdvancing(wait) {
  if (advancing !== wait) return false;
  clearTimeout(wait.timer);
  advancing = null;
  wait.started.cancel();
  return true;
}

// A button of the card or the end screen: its icon, then its words.
const labelledButton = (icon, text, onclick, { primary = false } = {}) => h("button", {
  type: "button",
  class: primary ? "browse-button with-icon primary" : "browse-button with-icon",
  onclick,
}, h("span", { html: icon }), h("span", { text }));

// --- The card before the end ------------------------------------------------

function buildCard() {
  const thumb = h("div", { class: "up-next-thumb" });
  const eyebrow = h("div", { class: "up-next-eyebrow" });
  const title = h("div", { class: "up-next-title" });
  const from = h("div", { class: "up-next-from" });
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
  const root = h("section", { class: "up-next hidden", "aria-label": "Up next" },
    thumb,
    h("div", { class: "up-next-text" }, eyebrow, title, from),
    h("div", { class: "up-next-actions" }, labelledButton(icons.play, "Play now", () => actions.playNow(), { primary: true }), dismiss));
  document.getElementById("app")?.append(root);
  return { root, thumb, eyebrow, title, from };
}

const FROM = {
  queue: () => "From your queue",
  history: () => "Next in your history",
  sequence: (upNext) => upNext.title || "",
};

function paintCard() {
  const upNext = upNextFor();
  if (upNext?.item) hadNext = state.sessionId;
  const remaining = (Number(state.duration) || 0) - (Number(state.currentTime) || 0);
  const shown = Boolean(state.player && upNext?.item && !state.isLive && state.duration >= MIN_DURATION_SECONDS
    && remaining > 0 && remaining <= LEAD_SECONDS && declined !== state.sessionId);
  if (!shown) {
    card?.root.classList.add("hidden");
    return;
  }
  card ??= buildCard();
  card.eyebrow.textContent = `Up next in ${Math.ceil(remaining)} s`;
  card.title.textContent = upNext.item.title || upNext.item.label || "The next item";
  card.from.textContent = (FROM[upNext.from] ?? (() => ""))(upNext);
  const picture = upNext.item.thumbnail ?? null;
  if (card.thumb.dataset.picture !== String(picture)) {
    card.thumb.dataset.picture = String(picture);
    card.thumb.innerHTML = artworkImage(landscapeArtwork(picture));
    hydrateArtwork(card.thumb);
  }
  // Play now fills from the left as the item runs out.
  card.root.style.setProperty("--elapsed", `${Math.round((1 - remaining / LEAD_SECONDS) * 100)}%`);
  card.root.classList.remove("hidden");
}

// --- The end of an item -----------------------------------------------------

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
  const root = h("section", { class: "end-screen hidden", "aria-label": "Finished" },
    h("header", { class: "end-screen-head" },
      h("div", { class: "end-screen-heading" }, h("p", { class: "end-screen-eyebrow", text: "Finished" }), heading),
      labelledButton(icons.replay, "Play again", () => actions.playAgain())),
    wrap);
  trackScrollEdges(row, { marked: wrap });
  document.getElementById("app")?.append(root);
  return { root, heading, row };
}

// The row for the stream that ended: placeholders at once, then what Yolo
// says next would have played; with nothing there after all, "Finished".
async function fillEndScreen(sessionId, key) {
  endScreen ??= buildEndScreen();
  const { heading, row } = endScreen;
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

function paintEndScreen(shown) {
  if (!shown) endedFor = null;
  else if (endedFor !== state.sessionId) {
    endedFor = state.sessionId;
    void fillEndScreen(state.sessionId, sourceKeyOf(state.source));
  }
  endScreen?.root.classList.toggle("hidden", !shown);
}

function paintFinishedNote(shown) {
  noteShown = shown;
  if (!shown) {
    note?.classList.add("hidden");
    return;
  }
  if (!note) {
    note = h("div", { class: "finished-note hidden", role: "status" },
      h("strong", { text: "Finished" }), h("span", { text: "Nothing else is up next" }));
    document.getElementById("app")?.append(note);
  }
  note.classList.remove("hidden");
  document.getElementById("btn-center-play")?.setAttribute("aria-label", "Play again");
}

// Ended here, and the Hub went idle: the end screen when the Hub had named
// something next for it, else "Finished".
function paintFinished() {
  // The next stream came (its `load` ended the wait), or the Hub stopped.
  if (advancing && (state.sessionId !== advancing.sessionId || !state.hub?.sessionId)) stopAdvancing(advancing);
  const finished = Boolean(state.player && actions.finishedHere() && state.hub && !state.hub.sessionId);
  const withRow = finished && hadNext === state.sessionId;
  const app = document.getElementById("app");
  app?.classList.toggle("finished", finished && !withRow);
  app?.classList.toggle("end-screen-shown", withRow);
  paintEndScreen(withRow);
  paintFinishedNote(finished && !withRow);
}

/** Redraws the card and the end of an item from `state`: the player's time updates and every Hub state. */
export function paintUpNext() {
  paintCard();
  paintFinished();
}

/** The centre button plays the item again while "Finished" shows. */
export const showingFinished = () => noteShown;
