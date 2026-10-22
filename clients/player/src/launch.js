// The launch mark (Agent Note 2026-10-11-yolo-web-client): the Yolo mark
// with one light sweep, shown from the first paint on a start with nothing
// to show yet, the first one on a browser or after its cache was cleared.
// index.html's first script decides it before the page paints
// (`<html data-boot="cold">`; a screen that kept its home starts on it,
// `data-boot="warm"`, and never sees the mark). It holds no minimum: the
// first screen that has something to show ends it (the home, a show, the
// player's loading screen, pairing, or a message), and it fades into that
// screen.

/** The latest the mark stays on a paired screen whose welcome is late. */
export const LAUNCH_AT_MOST_MS = 1_200;

const FADE_MS = 360;

/** The first screen is ready: the mark, if it shows, fades into it. */
export function endLaunch() {
  const root = document.documentElement;
  if (root.dataset.boot !== "cold") return;
  root.dataset.boot = "leaving";
  setTimeout(() => {
    root.dataset.boot = "done";
    document.getElementById("launch")?.remove();
  }, FADE_MS);
}

/** True while the mark shows: nothing else has been shown yet. */
export const launching = () => document.documentElement.dataset.boot === "cold";
