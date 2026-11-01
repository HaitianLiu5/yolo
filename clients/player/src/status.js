import { endLaunch } from "./launch.js";

// The message over the home screen: one line that needs the owner ("This
// screen is no longer paired"), or, with `waiting`, the spinner alone for a
// wait the owner started (taking over playback); never "Connecting…" or
// "Loading…". The home screen and a show's episodes hide it (browse.js).
//
// It covers everything under it, so a message that is not a wait gives the
// owner a way on: its `actions`, each `{ label, onClick, primary, id }`
// (Try again, Home, Take over here). Only a step the page takes by itself
// next (pairing again) goes without one.

const screen = document.getElementById("status-screen");
const text = document.getElementById("status-text");
const waitingRing = document.getElementById("status-waiting");
const actionsRow = document.getElementById("status-actions");

export function showStatus(message, { waiting = false, actions = [] } = {}) {
  text.textContent = message;
  waitingRing.classList.toggle("on", waiting);
  actionsRow.replaceChildren(...actions.map(({ label, onClick, primary = false, id = null }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (id) button.id = id;
    if (primary) button.className = "primary";
    button.addEventListener("click", onClick);
    return button;
  }));
  actionsRow.classList.toggle("hidden", actions.length === 0);
  screen.style.display = "";
  document.getElementById("overlay").classList.remove("hidden");
  endLaunch();
}

export function hideStatus() {
  screen.style.display = "none";
}

export const statusShown = () => screen.style.display !== "none";
