import { deviceKindIconSvg } from "@useyolo/core";
import { artworkImage } from "./artwork.js";

// The player's shared UI pieces: a small element builder, the icons, and
// the controls more than one screen draws (a button that asks again, a
// switch, a choice of a few, dismissing a modal sheet, and an item's card).
// Text always goes in as text: device, agent, passkey, and track names come
// from devices, agents, and sources. Only `html` takes markup, and only for
// the icons and the markup made here.

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key === "html") element.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

const svg = (path, size = 24) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;

export const icons = {
  gear: svg("M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"),
  close: svg("M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"),
  search: svg("M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z", 20),
  lock: svg("M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"),
  key: svg("M12.65 10A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"),
  agent: svg("M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z"),
  play: svg("M8 5v14l11-7z"),
  pause: svg("M6 19h4V5H6v14zm8-14v14h4V5h-4z"),
  next: svg("M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"),
  replay: svg("M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"),
  back10: svg("M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8zm-1.1 11h-.85v-3.26l-1.01.31v-.69l1.77-.63h.09V16zm4.28-1.76c0 .32-.03.6-.1.82s-.17.42-.29.57-.28.26-.45.33-.37.1-.59.1-.41-.03-.59-.1-.33-.18-.46-.33-.23-.34-.3-.57-.11-.5-.11-.82v-.74c0-.32.03-.6.1-.82s.17-.42.29-.57.28-.26.45-.33.37-.1.59-.1.41.03.59.1.33.18.46.33.23.34.3.57.11.5.11.82v.74zm-.85-.86c0-.19-.01-.35-.04-.48s-.07-.23-.12-.31-.11-.14-.19-.17-.16-.05-.25-.05-.18.02-.25.05-.14.09-.19.17-.09.18-.12.31-.04.29-.04.48v.97c0 .19.01.35.04.48s.07.24.12.32.11.14.19.17.16.05.25.05.18-.02.25-.05.14-.09.19-.17.09-.19.11-.32.04-.29.04-.48v-.97z"),
  stop: svg("M6 6h12v12H6z"),
  devices: svg("M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2a9 9 0 0 1 9 9h2c0-6.08-4.93-11-11-11z"),
  check: svg("M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z", 20),
  chevron: svg("M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z", 20),
  kind: (kind, size = 22) => deviceKindIconSvg(kind, { size }),
};

/** Human dates for settings: "today", "yesterday", "Oct 3", "Oct 3, 2025". */
export function shortDate(ms, now = Date.now()) {
  if (!ms) return "";
  const date = new Date(ms);
  const today = new Date(now);
  const startOfDay = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  const options = { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) };
  return date.toLocaleDateString(undefined, options);
}

const CONFIRM_MS = 4_000;

// A button that asks once more in place ("Remove" → "Remove?") before it
// acts; it goes back after a few seconds or when focus leaves it.
export function confirmButton({ label, confirmLabel, ariaLabel, quiet = true, onConfirm, onError }) {
  const button = h("button", { type: "button", class: quiet ? "pill pill-quiet" : "pill", "aria-label": ariaLabel ?? null }, label);
  let timer = null;
  const disarm = () => {
    clearTimeout(timer);
    timer = null;
    button.textContent = label;
    button.classList.remove("armed");
    if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
    else button.removeAttribute("aria-label");
  };
  button.addEventListener("click", async () => {
    if (!timer) {
      button.textContent = confirmLabel;
      button.classList.add("armed");
      button.setAttribute("aria-label", confirmLabel);
      timer = setTimeout(disarm, CONFIRM_MS);
      return;
    }
    disarm();
    button.disabled = true;
    try {
      await onConfirm();
    } catch (error) {
      onError?.(error);
    } finally {
      button.disabled = false;
    }
  });
  button.addEventListener("blur", () => {
    if (timer) disarm();
  });
  return button;
}

// An on/off setting: a switch named by its row's title.
export function switchButton({ id, on, labelledBy, onToggle }) {
  return h("button", {
    type: "button",
    class: "switch",
    role: "switch",
    id,
    "aria-checked": String(on),
    "aria-labelledby": labelledBy,
    onclick: onToggle,
  }, h("span", { class: "switch-thumb", "aria-hidden": "true" }));
}

// One choice of a few: native radio inputs drawn as steps in one tile, so
// arrow keys move between them and a form reads the choice by `name`. A
// step's `content` (a letter at its size, an icon) replaces its label on
// the face, and the label stays its name.
export function segmented({ name, labelledBy = null, options, selected, disabled = false, className = "", onChoose = null }) {
  return h("div", { class: className ? `segmented ${className}` : "segmented", role: "radiogroup", "aria-labelledby": labelledBy },
    options.map((option) => h("label", { class: "segmented-step" },
      h("input", {
        type: "radio",
        name,
        value: String(option.value),
        checked: option.value === selected,
        disabled,
        "aria-label": option.content ? option.label : null,
        onchange: onChoose ? () => onChoose(option.value) : null,
      }),
      h("span", { class: "segmented-face" }, option.content ?? option.label))));
}

// A modal <dialog> that Escape and a tap on the dimmed page beside it
// dismiss through `onDismiss`, which decides how it closes (settings go
// back in history, the picker forgets the play it held).
export function dismissible(dialog, onDismiss) {
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    onDismiss();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) onDismiss();
  });
}

// --- Cards --------------------------------------------------------------

const WATCHED_BADGE = '<div class="watched-badge" role="img" aria-label="Watched"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>';

// Runtimes read the same everywhere: "1h 58m", "49m".
export function runtime(seconds) {
  const minutes = Math.round(Number(seconds) / 60);
  if (!(minutes > 0)) return null;
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes}m`;
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

export const metaLine = (...parts) => parts.filter(Boolean).join(" · ");

function progressHtml(fraction) {
  if (!(fraction > 0)) return "";
  const percent = Math.min(fraction * 100, 100).toFixed(1);
  return `<div class="card-progress" aria-hidden="true"><div class="card-progress-fill" style="width:${percent}%"></div></div>`;
}

// One card of a row, the home screen's or the end screen's: artwork (with
// its watched mark and progress), then a title and one line of metadata.
// `shape` is "still" (16:9) or "poster" (2:3). The title and meta go in as
// text; only the artwork, badge, and progress are markup, all made here.
export function cardElement({ shape, artwork, watched = false, progress = 0, title, meta, className = "" }) {
  return h("div", { class: `browse-card ${shape}${className ? ` ${className}` : ""}` },
    h("div", { class: "browse-card-thumb", html: `${artwork ?? artworkImage(null)}${watched ? WATCHED_BADGE : ""}${progressHtml(progress)}` }),
    h("div", { class: "browse-card-title", text: title }),
    meta ? h("div", { class: "browse-card-meta", text: meta }) : null);
}
