import { api } from "./api.js";
import { artworkImage, hydrateArtwork, landscapeArtwork } from "./artwork.js";
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
// cards in a corner, the driver's side in the car. A kind this page does
// not draw shows its fallback.

const KINDS = Object.freeze({ note: 1, image: 1, choices: 1 });
// The car shows fewer at once, and nothing above everything else.
const CAR_MAX_OBJECTS = 4;

/** What this page draws, for `hello`'s capabilities. */
export function canvasCapability({ car }) {
  return { surfaces: car ? ["panel", "player"] : ["panel", "player", "overlay"], kinds: { ...KINDS } };
}

const pictureUrl = (url) => (url?.startsWith("/v1/") ? url : `/v1/thumbnail?url=${encodeURIComponent(url)}`);

export function createCanvas({ car, notify, root = document.getElementById("app") }) {
  const capability = canvasCapability({ car });
  let rev = 0;
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
    if (shelf) {
      element.append(h("button", {
        type: "button", class: "canvas-after", text: t("After this"), onclick: () => gesture(object, "pick", { option: index, after: true }),
      }));
    }
    return element;
  }

  function choicesView(object) {
    const shelf = parseRoute().view === "player" && Boolean(state.player);
    const title = object.props.title || t("Which one?");
    const view = h("section", { class: `canvas-choices ${shelf ? "shelf" : "spotlight"}`, role: "dialog", "aria-label": title },
      h("header", { class: "canvas-choices-head" }, h("h2", { text: title }), closeButton(object)),
      h("div", { class: "canvas-choices-row" }, object.props.options.map((option, index) => choiceCard(object, option, index, { shelf }))));
    hydrateArtwork(view);
    return view;
  }

  function cardView(object) {
    const known = Boolean(KINDS[object.kind]);
    const title = known ? object.props.title : object.fallback?.title;
    const body = object.kind === "note" ? object.props.text : known ? null : object.fallback?.text;
    const picture = object.kind === "image" ? object.props.url : null;
    const pressable = Boolean(object.actions?.press);
    return h("article", { class: `canvas-card ${object.kind}` },
      picture ? h("img", { class: "canvas-picture", src: pictureUrl(picture), alt: object.props.alt || "", loading: "lazy", decoding: "async" }) : null,
      h("div", { class: "canvas-card-text" },
        title ? h("h3", { text: title }) : null,
        body ? h("p", { text: body }) : null),
      pressable ? h("button", { type: "button", class: "canvas-card-press", "aria-label": title || body || t("Open"), onclick: () => gesture(object, "press") }) : null,
      closeButton(object));
  }

  function render() {
    const objects = shown();
    const choices = objects.filter((object) => object.kind === "choices").at(-1) ?? null;
    const cards = objects.filter((object) => object.kind !== "choices");
    layer.replaceChildren(...[
      cards.length ? h("div", { class: "canvas-cards" }, cards.map(cardView)) : null,
      choices ? choicesView(choices) : null,
    ].filter(Boolean));
    root.classList.toggle("canvas-choices-open", Boolean(choices));
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
