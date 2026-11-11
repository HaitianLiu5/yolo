import { api } from "./api.js";
import { artworkImage, artworkSource, hydrateArtwork, landscapeArtwork } from "./artwork.js";
import { cardElement, h, metaLine, runtime } from "./dom.js";
import { t } from "./i18n.js";
import { parseRoute } from "./router.js";
import { state } from "./state.js";
import { share, subscribe } from "./store.js";

// This screen's agent canvas (Agent Note 2026-10-21-agent-canvas): the
// objects agents placed for it, which arrive whole in the welcome and then
// as canvas_ops, kept in the store beside the Hub's state, and drawn here
// with the player's own cards. What the person does goes back to the Hub as
// an event, which plays or queues a choice itself.
//
// The agent says what to show; this screen decides how. Choices over the
// picture while something plays here are a shelf along the bottom, with
// After this to queue a choice; anywhere else they are a spotlight over the
// home screen. Either way they take the bottom row from the up-next card
// and the end screen while they are open. Notes and pictures are small
// cards at their layout's anchor, which the person drags to another; the
// middle stays clear, so a card anchored at the center sits in a corner,
// the driver's side in the car. A kind this page does not draw shows its
// fallback.

const KINDS = Object.freeze({ note: 1, image: 1, choices: 1 });
// The car shows fewer at once, and nothing above everything else.
const CAR_MAX_OBJECTS = 4;

/** What this page draws, for `hello`'s capabilities. */
export function canvasCapability({ car }) {
  return { surfaces: car ? ["panel", "player"] : ["panel", "player", "overlay"], kinds: { ...KINDS } };
}

// Where a card may sit: every anchor but the center, read in thirds of the
// layer, a row and a column.
const PLACES = Object.freeze([
  ["top-left", "top", "top-right"],
  ["left", null, "right"],
  ["bottom-left", "bottom", "bottom-right"],
]);
const EDGE_ANCHORS = new Set(PLACES.flat().filter(Boolean));
// A press that moves less than this is a press, not a drag.
const DRAG_SLOP = 8;

/** The anchor nearest a card dropped with its middle at (x, y) of a w × h layer. */
export function anchorAt(x, y, w, h) {
  const third = (value, size) => Math.min(2, Math.max(0, Math.floor((value / size) * 3)));
  const row = third(y, h);
  const column = third(x, w);
  if (row !== 1 || column !== 1) return PLACES[row][column];
  // Dropped in the middle: to the nearer edge.
  const dx = x / w - 0.5;
  const dy = y / h - 0.5;
  return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "top" : "bottom");
}

// A note's web addresses are links to open, since a long one cannot be
// copied on a touch screen.
function linked(text) {
  return String(text).split(/(https?:\/\/[^\s<>"]+)/i).map((part, index) => (index % 2
    ? h("a", { href: part, target: "_blank", rel: "noopener noreferrer", draggable: "false", text: part })
    : part));
}

export function createCanvas({ car, notify, onDrawn = () => {}, root = document.getElementById("app") }) {
  const capability = canvasCapability({ car });
  let rev = 0;
  // What the layer last drew: the Hub's state changes often, and drawing
  // the same objects again would take a remote's focus off them.
  let drawn = "";
  let refetching = null;
  // Objects this page took down at a press, before the Hub's remove arrives.
  const settled = new Set();
  const layer = h("div", { class: "canvas-layer" });
  root.append(layer);

  function set(canvas) {
    rev = Number(canvas?.rev) || 0;
    share({ canvas: Array.isArray(canvas?.objects) ? canvas.objects : [] });
  }

  function refetch() {
    refetching ??= api("/v1/canvas", { label: "canvas" })
      .then(set)
      .catch((error) => console.warn("[canvas] Could not read this screen's canvas:", error.message))
      .finally(() => { refetching = null; });
    return refetching;
  }

  // A rev out of step means a change went missing: read the canvas again.
  function applyOps(message) {
    if (message.rev !== rev + 1) {
      void refetch();
      return;
    }
    rev = message.rev;
    let objects = [...(state.canvas || [])];
    for (const op of message.ops || []) {
      if (op.op === "put" && op.object) objects = [...objects.filter((object) => object.id !== op.object.id), op.object];
      else if (op.op === "remove") objects = objects.filter((object) => object.id !== op.id);
    }
    share({ canvas: objects });
  }

  async function gesture(object, name, payload = null) {
    settled.add(object.id);
    render();
    try {
      await api("/v1/canvas/events", { method: "POST", body: { objectId: object.id, gesture: name, payload }, label: "canvas event" });
    } catch (error) {
      // The object comes back with the canvas, to press again.
      settled.delete(object.id);
      notify(t("That did not go through: {message}", { message: error.message }));
      void refetch();
    }
  }

  const homeCorner = car ? "top-left" : "top-right";
  const placeOf = (object) => (EDGE_ANCHORS.has(object.layout?.anchor) ? object.layout.anchor : homeCorner);

  // The card follows the finger and lands at the anchor nearest where it is
  // let go: at once here, then on every screen it is on through the Hub.
  async function move(object, anchor) {
    if (placeOf(object) === anchor) return;
    share({ canvas: (state.canvas || []).map((entry) => (entry.id === object.id ? { ...entry, layout: { ...entry.layout, anchor } } : entry)) });
    try {
      await api(`/v1/canvas/objects/${encodeURIComponent(object.id)}`, { method: "PATCH", body: { layout: { anchor } }, label: "canvas move" });
    } catch (error) {
      notify(t("That did not go through: {message}", { message: error.message }));
      void refetch();
    }
  }

  // A finger that moves past the slop drags the card: it follows the finger
  // anywhere on the page, then lands at the anchor nearest where it is let
  // go. A press that does not move stays a press.
  function draggable(element, object) {
    element.addEventListener("pointerdown", (down) => {
      if (down.button !== 0 || down.target.closest(".canvas-close, a")) return;
      let dragging = false;
      const follow = (event) => {
        if (event.pointerId !== down.pointerId) return;
        const dx = event.clientX - down.clientX;
        const dy = event.clientY - down.clientY;
        if (!dragging) {
          if (Math.hypot(dx, dy) < DRAG_SLOP) return;
          dragging = true;
          element.classList.add("dragging");
        }
        element.style.transform = `translate(${dx}px, ${dy}px)`;
      };
      const end = (event) => {
        if (event.pointerId !== down.pointerId) return;
        window.removeEventListener("pointermove", follow);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        if (!dragging) return;
        const card = element.getBoundingClientRect();
        const bounds = layer.getBoundingClientRect();
        element.classList.remove("dragging");
        element.style.transform = "";
        // The click that ends a drag, dispatched before any timer, is not a press.
        const swallow = (click) => { click.preventDefault(); click.stopPropagation(); };
        window.addEventListener("click", swallow, { capture: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
        if (event.type === "pointercancel") return;
        void move(object, anchorAt(card.left + card.width / 2 - bounds.left, card.top + card.height / 2 - bounds.top, bounds.width, bounds.height));
      };
      window.addEventListener("pointermove", follow);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    });
    return element;
  }

  function shown() {
    const now = Date.now();
    for (const id of settled) if (!(state.canvas || []).some((object) => object.id === id)) settled.delete(id);
    const objects = (state.canvas || []).filter((object) => !settled.has(object.id)
      && (!object.expiresAt || object.expiresAt > now)
      && capability.surfaces.includes(object.surface));
    return car ? objects.slice(-CAR_MAX_OBJECTS) : objects;
  }

  function closeButton(object) {
    return h("button", {
      type: "button", class: "canvas-close", "aria-label": t("Close"), html: "&times;", onclick: () => gesture(object, "dismiss"),
    });
  }

  function choiceCard(object, option, index, { shelf }) {
    if (!option.item) {
      return h("button", {
        type: "button", class: "canvas-choice-label", onclick: () => gesture(object, "pick", { option: index }),
      }, option.label || t("Something else"), option.note ? h("span", { class: "canvas-choice-note", text: option.note }) : null);
    }
    const title = option.item.title || t("Untitled");
    const element = cardElement({
      shape: "still",
      artwork: artworkImage(landscapeArtwork(option.item.thumbnail ?? null)),
      title: car ? `${index + 1}. ${title}` : title,
      meta: metaLine(option.note, runtime(option.item.duration)),
      className: "canvas-choice",
    });
    element.append(h("button", {
      type: "button", class: "browse-card-primary", "aria-label": t("Play {title}", { title }), onclick: () => gesture(object, "pick", { option: index }),
    }));
    if (!shelf) return element;
    // After this lies below the card, outside its whole-card button, where a
    // remote's down reaches it.
    return h("div", { class: "canvas-choice-slot" }, element, h("button", {
      type: "button", class: "canvas-after", text: t("After this"), onclick: () => gesture(object, "pick", { option: index, after: true }),
    }));
  }

  function choicesView(object, { shelf }) {
    const title = object.props.title || t("Which one?");
    const view = h("section", { class: `canvas-choices ${shelf ? "shelf" : "spotlight"}`, role: "dialog", "aria-label": title },
      h("header", { class: "canvas-choices-head" }, h("h2", { text: title }), closeButton(object)),
      h("div", { class: "canvas-choices-row" }, object.props.options.map((option, index) => choiceCard(object, option, index, { shelf }))));
    hydrateArtwork(view);
    return view;
  }

  // A picture comes from Yolo with this screen's credential, which an <img>
  // cannot send by itself; one that does not load leaves the card's text.
  function pictureView(url, alt) {
    const img = h("img", { class: "canvas-picture", alt: alt || "", decoding: "async", draggable: "false" });
    artworkSource(url).then((source) => {
      if (source) img.src = source;
      else img.remove();
    }, () => img.remove());
    return img;
  }

  function cardView(object) {
    const known = Boolean(KINDS[object.kind]);
    const title = known ? object.props.title : object.fallback?.title;
    const body = object.kind === "note" ? object.props.text : known ? null : object.fallback?.text;
    const picture = object.kind === "image" ? object.props.url : null;
    const pressable = Boolean(object.actions?.press);
    return draggable(h("article", { class: `canvas-card ${object.kind}` },
      picture ? pictureView(picture, object.props.alt) : null,
      h("div", { class: "canvas-card-text" },
        title ? h("h3", { text: title }) : null,
        body ? h("p", {}, linked(body)) : null),
      pressable ? h("button", { type: "button", class: "canvas-card-press", "aria-label": title || body || t("Open"), onclick: () => gesture(object, "press") }) : null,
      closeButton(object)), object);
  }

  function render() {
    const objects = shown();
    const choices = objects.filter((object) => object.kind === "choices").at(-1) ?? null;
    const cards = objects.filter((object) => object.kind !== "choices");
    const shelf = parseRoute().view === "player" && Boolean(state.player);
    const drawing = JSON.stringify([car, shelf, objects]);
    if (drawing === drawn) return;
    drawn = drawing;
    const places = new Map();
    for (const card of cards) places.set(placeOf(card), [...(places.get(placeOf(card)) || []), card]);
    layer.replaceChildren(...[
      ...[...places].map(([place, group]) => h("div", { class: `canvas-cards at-${place}` }, group.map(cardView))),
      choices ? choicesView(choices, { shelf }) : null,
    ].filter(Boolean));
    root.classList.toggle("canvas-choices-open", Boolean(choices));
    onDrawn();
  }

  subscribe(["canvas", "hub"], render);

  return {
    capability,
    /** A welcome's canvas, or none from a Hub before the canvas. */
    welcome: (canvas) => set(canvas ?? { rev: 0, objects: [] }),
    ops: applyOps,
    // The view changed (home or player): choices move between spotlight and shelf.
    refresh: render,
  };
}
