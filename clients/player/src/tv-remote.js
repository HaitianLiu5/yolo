import { parseRoute } from "./router.js";

// A TV's remote (Agent Note 2026-10-26-tv-web-client): a smart TV's own web
// engine has no pointer, only the remote's arrows, OK, Back, and media keys.
// The arrows move focus to the nearest control in their direction on the
// layer on top (an open dialog, the home screen, or the player's controls);
// OK presses the focused control as the browser does; Back closes what is
// on top. Over the picture with the controls hidden, left and right seek as
// on a computer (controls.js), and the other keys bring the controls up.

const DIRECTIONS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

// Back is Tizen's XF86Back and webOS's 461. The media keys reach a Tizen page
// only after its app registered them (clients/tizen/main.js).
const KEY_CODES = new Map([
  [10009, "back"], [461, "back"],
  [10252, "playpause"], [415, "play"], [19, "pause"], [413, "stop"],
  [417, "forward"], [412, "rewind"], [10233, "next"], [10232, "previous"],
]);
const KEY_NAMES = new Map([
  ["XF86Back", "back"], ["GoBack", "back"], ["BrowserBack", "back"],
  ["MediaPlayPause", "playpause"], ["MediaPlay", "play"], ["MediaPause", "pause"], ["MediaStop", "stop"],
  ["MediaFastForward", "forward"], ["MediaRewind", "rewind"], ["MediaTrackNext", "next"], ["MediaTrackPrevious", "previous"],
]);

const FOCUSABLE = "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])";
// A row's scroll arrows are a mouse's; the remote scrolls a row by moving
// along its cards.
const POINTER_ONLY = ".browse-arrow";
// Focus entering a page lands on its first card rather than its header.
const CARD = ".browse-card-primary";
const TYPING = "input:not([type]), input[type='text'], input[type='search'], input[type='url'], input[type='email'], "
  + "input[type='password'], input[type='number'], textarea, select, [contenteditable]:not([contenteditable='false'])";

/** What a key press means on a remote: an arrow's direction, "ok", a named key, or null. */
export function remoteKey(event) {
  if (DIRECTIONS[event.key]) return DIRECTIONS[event.key];
  if (event.key === "Enter") return "ok";
  return KEY_NAMES.get(event.key) ?? KEY_CODES.get(event.keyCode) ?? null;
}

/**
 * The candidate a move in `direction` lands on from `from`: one that lies
 * beyond `from`'s edge, nearest along the move, with a sideways offset
 * costing twice as much. Left and right stay in `from`'s own row, so a
 * header's controls lead to each other and a row's end stops the move, not a
 * card below. Rectangles are client rects; returns null when nothing lies
 * that way.
 * @template {{ left: number, top: number, right: number, bottom: number }} R
 * @param {R} from
 * @param {R[]} candidates
 * @param {"up" | "down" | "left" | "right"} direction
 * @returns {R | null}
 */
export function nearestInDirection(from, candidates, direction) {
  const horizontal = direction === "left" || direction === "right";
  const centre = (r) => (horizontal ? (r.top + r.bottom) / 2 : (r.left + r.right) / 2);
  let best = null;
  let bestScore = Infinity;
  for (const r of candidates) {
    if (r === from) continue;
    const along = direction === "right" ? r.left - from.right
      : direction === "left" ? from.left - r.right
      : direction === "down" ? r.top - from.bottom
      : from.top - r.bottom;
    // A little overlap still counts: rows and buttons sit close together.
    if (along < -4) continue;
    const across = horizontal
      ? Math.max(0, r.top - from.bottom, from.top - r.bottom)
      : Math.max(0, r.left - from.right, from.left - r.right);
    if (horizontal && across > 0) continue;
    const score = Math.max(0, along) + 2 * across + 0.01 * Math.abs(centre(r) - centre(from));
    if (score < bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

function shown(element) {
  if (element.disabled || element.matches(POINTER_ONLY) || element.closest("[hidden], [aria-hidden='true']:not(#controls)")) return false;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
}

function atEdge(field, key) {
  if (typeof field.selectionStart !== "number" || field.selectionStart !== field.selectionEnd) return false;
  return key === "left" ? field.selectionStart === 0 : field.selectionEnd === field.value.length;
}

function focusablesIn(scope) {
  return [...scope.querySelectorAll(FOCUSABLE)].filter(shown);
}

/**
 * @param {object} options
 * @param {() => boolean} options.enabled  whether this screen is a TV now
 * @param {() => void} options.showControls  brings the player's controls up for a while
 * @param {Window} [options.win]
 */
export function initTvRemote({ enabled, showControls, win = window }) {
  const doc = win.document;
  const app = doc.getElementById("app");
  const overlay = doc.getElementById("overlay");
  const controls = doc.getElementById("controls");
  const byId = (id) => doc.getElementById(id);
  const firstShown = (...ids) => ids.map(byId).find((element) => element && shown(element)) ?? null;

  function layer() {
    const dialog = doc.querySelector("dialog[open]");
    if (dialog) return { kind: "dialog", scope: dialog };
    if (!overlay.classList.contains("hidden")) return { kind: "home", scope: overlay };
    return { kind: "player", scope: controls };
  }

  // A choice of a few (dom.js) is a radio group: focus rests on its checked
  // radio, and left and right pick the next one, as the browser's own arrows.
  const group = (radio) => [...doc.querySelectorAll("input[type='radio']")]
    .filter((other) => other.name === radio.name && other.form === radio.form && shown(other));

  function focus(element) {
    if (element.matches("input[type='radio']") && !element.checked) {
      element = group(element).find((radio) => radio.checked) ?? element;
    }
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // Focus entering a layer goes back to where it was on this page, or to the
  // card, else the control, nearest its top left on screen.
  const lastFocus = new Map();
  doc.addEventListener("focusin", (event) => {
    if (overlay.contains(event.target)) lastFocus.set(win.location.pathname, event.target);
  });

  function enter(scope) {
    const last = lastFocus.get(win.location.pathname);
    if (last?.isConnected && scope.contains(last) && shown(last)) return focus(last);
    const all = focusablesIn(scope);
    const cards = all.filter((element) => element.matches(CARD));
    const candidates = cards.length ? cards : all;
    const visible = candidates.filter((element) => {
      const r = element.getBoundingClientRect();
      return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
    });
    const pool = visible.length ? visible : candidates;
    const first = pool.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.top - rb.top || ra.left - rb.left;
    })[0];
    if (first) focus(first);
  }

  function move(scope, direction) {
    const current = doc.activeElement;
    if (!current || current === doc.body || !scope.contains(current)) return enter(scope);
    if (current.matches("input[type='radio']") && (direction === "left" || direction === "right")) {
      const radios = group(current).map((radio) => Object.assign(radio.getBoundingClientRect().toJSON(), { radio }));
      const from = radios.find((r) => r.radio === current);
      const next = from && nearestInDirection(from, radios, direction);
      if (next) {
        next.radio.click();
        next.radio.focus({ preventScroll: true });
        return;
      }
    }
    const candidates = focusablesIn(scope);
    const rects = candidates.map((element) => Object.assign(element.getBoundingClientRect().toJSON(), { element }));
    const from = Object.assign(current.getBoundingClientRect().toJSON(), { element: current });
    const next = nearestInDirection(from, rects.filter((r) => r.element !== current), direction);
    if (next) focus(next.element);
  }

  function closeDialog(dialog) {
    // The dialog's own dismiss (dom.js dismissible) answers its cancel.
    const cancel = new Event("cancel", { cancelable: true });
    if (dialog.dispatchEvent(cancel)) dialog.close();
  }

  function playing() {
    const video = doc.querySelector("#player-container video");
    return Boolean(video && !video.paused);
  }

  function media(key) {
    if (key === "stop") return byId("btn-back")?.click();
    if (key === "playpause" || (key === "play" && !playing()) || (key === "pause" && playing())) return byId("btn-play")?.click();
    if (key === "next") return firstShown("btn-bar-next", "btn-next")?.click();
    if (key === "previous") return firstShown("btn-bar-previous", "btn-previous")?.click();
    if (key === "forward" || key === "rewind") {
      // The computer's arrows seek (controls.js); untrusted, so not ours again.
      doc.dispatchEvent(new KeyboardEvent("keydown", { key: key === "forward" ? "ArrowRight" : "ArrowLeft", bubbles: true }));
    }
  }

  function onPlayer(key, event) {
    if (["playpause", "play", "pause", "stop", "next", "previous", "forward", "rewind"].includes(key)) {
      media(key);
      return true;
    }
    const up = app.classList.contains("controls-visible");
    if (!up) {
      if (key === "back") {
        byId("btn-back")?.click();
        return true;
      }
      if (key === "left" || key === "right") return false;
      showControls();
      const play = firstShown("btn-center-play", "btn-play");
      if (play) focus(play);
      else enter(controls);
      return true;
    }
    showControls();
    if (key === "back") {
      app.classList.remove("controls-visible");
      doc.activeElement?.blur();
      return true;
    }
    if (key === "ok") return false;
    // The seek bar takes left and right itself (controls.js).
    if ((key === "left" || key === "right") && event.target?.closest?.("[role='slider']")) return false;
    move(controls, key);
    return true;
  }

  function onKey(event) {
    if (!event.isTrusted || event.defaultPrevented || !enabled()) return;
    const key = remoteKey(event);
    if (!key) return;
    const target = event.target instanceof win.Element ? event.target : null;
    const typing = target?.closest(TYPING);
    // OK picks a choice as a click would; the browser leaves it to Space.
    if (key === "ok" && target?.matches("input[type='radio'], input[type='checkbox']")) {
      target.click();
      event.preventDefault();
      return;
    }
    // In a text field OK submits and the left and right arrows move the
    // caret, leaving the field only from its start or end.
    if (typing && key === "ok") return;
    if (typing && (key === "left" || key === "right") && !atEdge(typing, key)) return;
    if (typing && key === "back") {
      typing.blur();
      event.preventDefault();
      return;
    }
    const { kind, scope } = layer();
    let handled = true;
    if (kind === "player") {
      handled = onPlayer(key, event);
    } else if (key === "back") {
      if (kind === "dialog") closeDialog(scope);
      else if (parseRoute().view !== "browse") win.history.back();
    } else if (DIRECTIONS[event.key]) {
      move(scope, key);
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // Capturing, so a handled key never reaches the computer's shortcuts.
  win.addEventListener("keydown", onKey, true);
}
