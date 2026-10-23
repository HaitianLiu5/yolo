import { artworkImage, hydrateArtwork, landscapeArtwork } from "./artwork.js";
import { h, icons } from "./dom.js";
import { state } from "./state.js";
import { subscribe } from "./store.js";

// What plays next, on the player (Agent Note 2026-10-23-up-next): in an
// item's last seconds a card names what the Hub's state says plays next
// (the queue's head, or the item's run), with Play now and a dismiss that
// lets the item stop at its end; and when an item ended here with nothing
// after it, the centre button plays it again under "Finished". In the car
// both sit on the driver's side (style.css).

// The card shows this long before the end, on items at least this long.
const LEAD_SECONDS = 20;
const MIN_DURATION_SECONDS = 90;

let actions = { playNow: () => {}, finishedHere: () => false };
let card = null;
let note = null;
// The stream whose next the owner dismissed: its `ended` says advance: false.
let declined = null;

/**
 * `playNow` plays what is next (the player's Next); `finishedHere()` says
 * whether the stream on screen played to its end here.
 */
export function initUpNext({ playNow, finishedHere }) {
  actions = { playNow, finishedHere };
  subscribe(["hub"], paintUpNext);
}

/** The `ended` message for a stream that played to its end here. */
export function endedMessage(sessionId) {
  return { type: "ended", sessionId, ...(declined && declined === sessionId ? { advance: false } : {}) };
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
  title.textContent = upNext.item.title || "The next item";
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

// Ended here, and the Hub went idle: nothing followed it.
function paintFinished() {
  const finished = Boolean(state.player && actions.finishedHere() && state.hub && !state.hub.sessionId);
  document.getElementById("app")?.classList.toggle("finished", finished);
  if (!finished) {
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

/** Redraws the card and the finished note from `state`: the player's time updates and every Hub state. */
export function paintUpNext() {
  paintCard();
  paintFinished();
}

/** The centre button plays the item again while "Finished" shows. */
export const showingFinished = () => Boolean(note && !note.classList.contains("hidden"));
