import { endLaunch } from "./launch.js";

// The message over the home screen: one line that needs the owner ("This
// screen is no longer paired"), or, with `waiting`, the spinner alone for a
// wait the owner started (taking over playback); never "Connecting…" or
// "Loading…". The home screen and a show's episodes hide it (browse.js).

const screen = document.getElementById("status-screen");
const text = document.getElementById("status-text");
const waitingRing = document.getElementById("status-waiting");

export function showStatus(message, { waiting = false } = {}) {
  text.textContent = message;
  waitingRing.classList.toggle("on", waiting);
  screen.style.display = "";
  document.getElementById("overlay").classList.remove("hidden");
  endLaunch();
}

export function hideStatus() {
  screen.style.display = "none";
}

export const statusShown = () => screen.style.display !== "none";
