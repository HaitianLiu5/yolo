import { api } from "./api.js";
import { artworkImage, hydrateArtwork, landscapeArtwork } from "./artwork.js";
import { cardElement, h, metaLine, runtime } from "./dom.js";
import { language, t } from "./i18n.js";

// The rows Yolo fills by itself, what is on now, what is new, and last night's
// games (Agent Note 2026-11-04-living-home-and-media-pool), which the node
// builds and a screen only draws. While the home shows they are asked for
// again, so a game going live appears on a home nobody touched; the same cards
// keep their place and focus, and only what changed on them changes.

const REFRESH_MS = 5 * 60_000;
// With something on, scores move; while Yolo is still reading what it
// follows, a new home's rows are seconds away.
const REFRESH_LIVE_MS = 60_000;
const REFRESH_READING_MS = 10_000;
const NEW_WITHIN_MS = 48 * 3_600_000;
const NEAR_DAYS = 6;
const LIMIT = 30;

const ROWS = Object.freeze({
  live: { section: document.getElementById("live-section"), list: document.getElementById("live-list") },
  new: { section: document.getElementById("new-section"), list: document.getElementById("new-list") },
  replays: { section: document.getElementById("replays-section"), list: document.getElementById("replays-list") },
});

const UNFOLLOW_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>';

// Set by browse.js, which owns playing, the queue, and a card's actions.
let host = null;
let shown = [];
let items = new Map();
let timer = null;

export function initFeedRows(next) {
  host = next;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && host.homeVisible()) void refreshFeedRows();
  });
}

/** Whether any of these rows has cards. */
export const feedHasRows = () => shown.some((row) => row.items.length);

function startsAt(ms) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(language(), { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  const near = Math.abs(ms - Date.now()) < NEAR_DAYS * 24 * 3_600_000;
  return `${date.toLocaleDateString(language(), near ? { weekday: "short" } : { month: "numeric", day: "numeric" })} ${time}`;
}

function whyLine(why) {
  if (!why?.title) return null;
  if (why.kind === "team") return t("You follow {title}", { title: why.title });
  if (why.kind === "channel") return t("From {title}", { title: why.title });
  return why.title;
}

// What a card says now: its badge and the line under its title.
function facts(item) {
  const state = item.live?.state;
  const why = whyLine(item.why);
  if (state === "live") return { badge: t("Live"), kind: "live", meta: metaLine(item.matchup?.period, why) };
  if (state === "upcoming") return { badge: item.live.startsAt ? startsAt(item.live.startsAt) : t("Soon"), kind: "upcoming", meta: why ?? "" };
  const fresh = state !== "ended" && item.at && Date.now() - item.at < NEW_WITHIN_MS;
  return { badge: fresh ? t("New") : null, kind: "new", meta: metaLine(why, runtime(item.duration)) };
}

const scoreOf = (matchup) => (matchup.left.score != null && matchup.right.score != null ? `${matchup.left.score} – ${matchup.right.score}` : "vs");

function sideElement(side) {
  return h("span", { class: "matchup-side" },
    h("span", { class: "matchup-badge", html: artworkImage(side.badge ?? null) }),
    h("span", { class: "matchup-name", text: side.name }));
}

function setBadge(card, { badge, kind }) {
  const thumb = card.querySelector(".browse-card-thumb");
  let element = thumb.querySelector(".card-badge");
  if (!badge) {
    element?.remove();
    return;
  }
  if (!element) {
    element = h("span", { class: "card-badge" });
    thumb.append(element);
  }
  element.className = `card-badge ${kind}`;
  element.textContent = badge;
}

function press(key) {
  const item = items.get(key);
  if (!item) return;
  if (item.live?.state === "upcoming") {
    host.notify(t("{title} starts {time}", { title: item.title, time: item.live.startsAt ? startsAt(item.live.startsAt) : t("Soon") }));
    return;
  }
  host.play(item);
}

// Takes `change(rows)` to what the screen shows at once, and tells Yolo.
async function send(body, change, label) {
  shown = change(shown);
  draw({ evenEditing: true });
  try {
    await api("/v1/feed/feedback", { method: "POST", body, label });
  } catch {
    void refreshFeedRows();
  }
}

const notInterested = (item) => send(
  { signal: "not_interested", source: item.source },
  (rows) => rows.map((row) => ({ ...row, items: row.items.filter((other) => other.id !== item.id) })),
  "Not interested",
);

const stopFollowing = (interest) => send(
  { signal: "stop_following", interest },
  (rows) => rows.map((row) => ({ ...row, items: row.items.filter((other) => other.why?.interest !== interest) })),
  "Stop following",
);

function cardFor(item, section) {
  const said = facts(item);
  const card = cardElement({
    shape: "still",
    artwork: item.matchup ? "" : artworkImage(landscapeArtwork(item.thumbnail)),
    progress: item.resumeAt && item.duration ? item.resumeAt / item.duration : 0,
    title: item.title,
    meta: said.meta || " ",
  });
  card.dataset.key = item.id;
  const thumb = card.querySelector(".browse-card-thumb");
  if (item.matchup) {
    thumb.prepend(h("span", { class: "matchup" },
      sideElement(item.matchup.left),
      h("span", { class: "matchup-score", text: scoreOf(item.matchup) }),
      sideElement(item.matchup.right)));
  }
  setBadge(card, said);
  host.cardAction(card, { kind: "remove", label: t("Not interested in {title}", { title: item.title }), icon: host.icons.close, onActivate: () => notInterested(item) });
  if (item.why?.interest) {
    host.cardAction(card, { kind: "unfollow", label: t("Stop following {title}", { title: item.why.title }), icon: UNFOLLOW_ICON, onActivate: () => stopFollowing(item.why.interest) });
  }
  if (!item.live) {
    host.cardAction(card, { kind: "queue", label: t("Add {title} to queue", { title: item.title }), icon: host.icons.queue, onActivate: () => host.addToQueue({ source: item.source }) });
  }
  host.primaryAction(card, { label: t("Play {title}", { title: item.title }), section, onActivate: () => press(item.id) });
  return card;
}

// The same cards in the same order keep their elements: a score that moved
// does not take a TV remote's focus away, or scroll a row back.
function drawRow({ section, list }, row, { evenEditing = false } = {}) {
  const rowItems = row?.items ?? [];
  section.classList.toggle("hidden", rowItems.length === 0);
  // A row being edited holds still, except for what the owner just removed.
  if (section.classList.contains("edit-mode") && !evenEditing) return;
  const keys = rowItems.map((item) => item.id).join("\n");
  if (list.dataset.keys === keys) {
    rowItems.forEach((item, index) => {
      const card = list.children[index];
      const said = facts(item);
      setBadge(card, said);
      const meta = card.querySelector(".browse-card-meta");
      if (meta) meta.textContent = said.meta || " ";
      const score = card.querySelector(".matchup-score");
      if (score && item.matchup) score.textContent = scoreOf(item.matchup);
    });
    return;
  }
  const focused = list.contains(document.activeElement) ? document.activeElement.closest(".browse-card")?.dataset.key : null;
  list.replaceChildren(...rowItems.map((item) => cardFor(item, section)));
  list.dataset.keys = keys;
  hydrateArtwork(list);
  if (focused) [...list.children].find((card) => card.dataset.key === focused)?.querySelector(".browse-card-primary")?.focus();
}

function draw(options) {
  items = new Map(shown.flatMap((row) => row.items.map((item) => [item.id, item])));
  for (const [role, elements] of Object.entries(ROWS)) drawRow(elements, shown.find((row) => row.role === role), options);
  host.onDrawn();
}

/** What this screen showed last, for a start: what is on now is not kept, since it will have moved on. */
export function showCachedFeed(rows) {
  shown = rows.filter((row) => row.role !== "live" && Array.isArray(row.items));
  draw();
}

function nextRefresh(afterMs) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (host.homeVisible() && document.visibilityState === "visible") void refreshFeedRows();
    else nextRefresh(afterMs);
  }, afterMs);
}

/** Asks Yolo for the rows. One it cannot give keeps what the screen shows. */
export async function refreshFeedRows() {
  let answer;
  try {
    answer = await api(`/v1/feed/rows?limit=${LIMIT}`, { label: "Feed" });
  } catch {
    nextRefresh(REFRESH_MS);
    return;
  }
  shown = Array.isArray(answer?.rows) ? answer.rows : [];
  draw();
  host.remember(shown.filter((row) => row.role !== "live"));
  nextRefresh(answer?.reading ? REFRESH_READING_MS : shown.some((row) => row.role === "live") ? REFRESH_LIVE_MS : REFRESH_MS);
}
