import { YoloError } from "./errors.js";
import { newId } from "./ids.js";

// The agent canvas (Agent Note 2026-10-21-agent-canvas): what agents place on
// a screen, kept by the Hub per screen and drawn by each host with its own
// components. This module is the shape every side agrees on: the surfaces,
// the kinds and their props, an object's envelope, and the limits. The Hub
// validates every object with it before it reaches a screen, and a host
// reads the capability it declares in `hello` with it.

export const CANVAS_SURFACES = Object.freeze(["panel", "player", "overlay", "wallpaper"]);
// The light kinds built so far, with their versions.
export const CANVAS_KINDS = Object.freeze({ note: 1, image: 1, choices: 1 });
export const CANVAS_ANCHORS = Object.freeze([
  "top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right",
]);
export const CANVAS_GESTURES = Object.freeze(["press", "pick", "dismiss"]);
// What a gesture may do. The Hub runs play, queue, dismiss, and remove
// itself; notify only records the event for agents.
export const CANVAS_ACTIONS = Object.freeze(["play", "queue", "dismiss", "remove", "notify"]);

export const CANVAS_LIMITS = Object.freeze({
  objects: 50,
  propsBytes: 16 * 1024,
  // Operations a second, per owner.
  opsPerSecond: 10,
  // A transient object, such as choices waiting for an answer, ends by then.
  transientMs: 10 * 60_000,
  events: 500,
  eventsKeptMs: 24 * 60 * 60_000,
  payloadBytes: 1024,
  waitSeconds: 45,
  choices: 6,
  noteChars: 500,
  lineChars: 140,
  titleChars: 120,
});

const byteLength = (value) => new TextEncoder().encode(JSON.stringify(value ?? null)).length;

function invalid(message) {
  return new YoloError("invalid_request", message);
}

function text(value, max, name, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw invalid(`${name} is required`);
    return null;
  }
  if (typeof value !== "string") throw invalid(`${name} must be text`);
  const trimmed = value.trim();
  if (required && !trimmed) throw invalid(`${name} is required`);
  if (trimmed.length > max) throw invalid(`${name} is longer than ${max} characters`);
  return trimmed || null;
}

/**
 * What a host declares it draws, from `hello`'s capabilities: `{ surfaces,
 * kinds }`, or null for a host without a canvas.
 */
export function normalizeCanvasCapability(value) {
  if (!value || typeof value !== "object") return null;
  const surfaces = Array.isArray(value.surfaces) ? CANVAS_SURFACES.filter((surface) => value.surfaces.includes(surface)) : [];
  const kinds = {};
  for (const [kind, version] of Object.entries(value.kinds && typeof value.kinds === "object" ? value.kinds : {})) {
    if (/^[a-z][a-z0-9-]{0,31}$/.test(kind) && Number.isInteger(version) && version > 0 && version < 1000) kinds[kind] = version;
  }
  if (!surfaces.length || !Object.keys(kinds).length) return null;
  return { surfaces, kinds };
}

/** Whether a host with capability `canvas` draws `kind`. */
export const drawsKind = (canvas, kind) => Boolean(canvas?.kinds?.[kind]);

function layoutOf(value) {
  const layout = value && typeof value === "object" ? value : {};
  const fraction = (input, name) => {
    if (input == null || input === "auto") return "auto";
    const number = Number(input);
    if (!Number.isFinite(number) || number <= 0 || number > 1) throw invalid(`layout.${name} must be a fraction from 0 to 1, or "auto"`);
    return number;
  };
  const anchor = layout.anchor ?? "center";
  if (!CANVAS_ANCHORS.includes(anchor)) throw invalid(`layout.anchor must be one of ${CANVAS_ANCHORS.join(", ")}`);
  const z = layout.z == null ? 0 : Number(layout.z);
  if (!Number.isInteger(z) || z < 0 || z > 99) throw invalid("layout.z must be a whole number from 0 to 99");
  return { anchor, w: fraction(layout.w, "w"), h: fraction(layout.h, "h"), z };
}

function actionOf(value, name) {
  if (!value || typeof value !== "object") throw invalid(`${name} must be an action such as { "do": "notify" }`);
  if (!CANVAS_ACTIONS.includes(value.do)) throw invalid(`${name}.do must be one of ${CANVAS_ACTIONS.join(", ")}`);
  return { do: value.do };
}

function actionsOf(value) {
  if (value == null) return {};
  if (typeof value !== "object") throw invalid("actions must map a gesture to an action");
  const actions = {};
  for (const [gesture, action] of Object.entries(value)) {
    if (!CANVAS_GESTURES.includes(gesture)) throw invalid(`actions may name only ${CANVAS_GESTURES.join(", ")}`);
    actions[gesture] = actionOf(action, `actions.${gesture}`);
  }
  return actions;
}

function fallbackOf(value, props, kind) {
  const given = value && typeof value === "object" ? value : {};
  const title = text(given.title, CANVAS_LIMITS.titleChars, "fallback.title")
    ?? props.title ?? (kind === "note" ? null : kind[0].toUpperCase() + kind.slice(1));
  const line = text(given.text, CANVAS_LIMITS.noteChars, "fallback.text")
    ?? (kind === "note" ? props.text : kind === "choices" ? props.options.map((option) => option.item?.title ?? option.label).filter(Boolean).join(" · ").slice(0, CANVAS_LIMITS.noteChars) : null);
  return { title: title ?? null, text: line ?? null };
}

// A choice is an item Yolo looked up (`item`, which the Hub fills in from
// the agent's item_id or url, never from the agent's words) with at most one
// line of the agent's own, or a `label` that asks the agent for something
// else.
function choiceOf(value, index) {
  if (!value || typeof value !== "object") throw invalid(`options[${index}] must be an object`);
  const note = text(value.note, CANVAS_LIMITS.lineChars, `options[${index}].note`);
  if (value.item) {
    const item = value.item;
    if (!item.source || typeof item.source !== "object") throw invalid(`options[${index}] has no item Yolo looked up`);
    return {
      item: {
        source: item.source,
        title: typeof item.title === "string" ? item.title.slice(0, 300) : null,
        thumbnail: typeof item.thumbnail === "string" ? item.thumbnail.slice(0, 2048) : null,
        duration: Number.isFinite(Number(item.duration)) && Number(item.duration) > 0 ? Number(item.duration) : null,
      },
      note,
    };
  }
  const label = text(value.label, CANVAS_LIMITS.lineChars, `options[${index}].label`, { required: true });
  return { label, note };
}

const PROPS = {
  note(props) {
    return {
      title: text(props.title, CANVAS_LIMITS.titleChars, "props.title"),
      text: text(props.text, CANVAS_LIMITS.noteChars, "props.text", { required: true }),
    };
  },
  image(props) {
    const url = text(props.url, 2048, "props.url", { required: true });
    if (!/^https?:\/\//i.test(url) && !/^\/v1\/library\/items\/[^/]+\/artwork$/.test(url)) {
      throw invalid("props.url must be an http(s) picture or a library item's artwork");
    }
    return { url, alt: text(props.alt, CANVAS_LIMITS.lineChars, "props.alt"), title: text(props.title, CANVAS_LIMITS.titleChars, "props.title") };
  },
  choices(props) {
    const options = Array.isArray(props.options) ? props.options : [];
    if (!options.length) throw invalid("props.options needs at least one choice");
    if (options.length > CANVAS_LIMITS.choices) throw invalid(`props.options holds at most ${CANVAS_LIMITS.choices} choices`);
    return { title: text(props.title, CANVAS_LIMITS.titleChars, "props.title"), options: options.map(choiceOf) };
  },
};

/**
 * An object as the Hub keeps it, from what an agent or a screen placed:
 * validated, with defaults filled in. `now` and `owner` come from the Hub.
 */
export function normalizeCanvasObject(input, { owner, now = Date.now(), id = null } = {}) {
  if (!input || typeof input !== "object") throw invalid("An object is required");
  const kind = input.kind;
  if (!PROPS[kind]) throw invalid(`kind must be one of ${Object.keys(PROPS).join(", ")}`);
  const surface = input.surface ?? "panel";
  if (!CANVAS_SURFACES.includes(surface)) throw invalid(`surface must be one of ${CANVAS_SURFACES.join(", ")}`);
  const props = PROPS[kind](input.props && typeof input.props === "object" ? input.props : {});
  if (byteLength(props) > CANVAS_LIMITS.propsBytes) throw invalid(`props are larger than ${CANVAS_LIMITS.propsBytes} bytes`);
  const transient = input.transient ?? kind === "choices";
  let expiresAt = input.expiresAt == null ? null : Number(input.expiresAt);
  if (expiresAt != null && !Number.isFinite(expiresAt)) throw invalid("expiresAt must be a time in milliseconds");
  if (transient) expiresAt = Math.min(expiresAt ?? Infinity, now + CANVAS_LIMITS.transientMs);
  const scope = input.scope ?? "device";
  if (scope !== "device" && scope !== "all") throw invalid("scope must be device or all");
  return {
    id: id ?? (typeof input.id === "string" && /^obj_[a-z0-9]{4,32}$/.test(input.id) ? input.id : newId("obj", 10)),
    surface,
    kind,
    layout: layoutOf(input.layout),
    props,
    actions: actionsOf(input.actions),
    fallback: fallbackOf(input.fallback, props, kind),
    owner: owner ?? "agent",
    scope,
    transient: Boolean(transient),
    expiresAt: expiresAt ?? null,
    createdAt: now,
  };
}

/** Whether `object` is still to be drawn at `now`. */
export const isCanvasObjectLive = (object, now = Date.now()) => !object.expiresAt || object.expiresAt > now;
