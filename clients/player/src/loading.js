import { artworkSource, landscapeArtwork } from "./artwork.js";

// What the screen shows from a tap until the picture moves (Agent Note
// 2026-10-11-device-telemetry): the item's own picture at once, lightly
// dimmed, under the one small spinner, with no words; as the YouTube and
// Netflix apps do. Only a wait past SLOW_AFTER_MS adds one quiet line, and
// never a technical one; an error keeps its own panel. The picture is the
// item's artwork, which its card already loaded.

export const SLOW_AFTER_MS = 8_000;
const SLOW_LINES = Object.freeze({
  // Yolo is still preparing the stream.
  connecting: "Connecting to the home server…",
  // The stream arrived; its first picture has not.
  loading: "Still loading…",
});

/**
 * @param {object} elements  the poster, its <img>, and the quiet line
 * @param {() => void} options.showSpinner  the centre spinner (controls.js)
 */
export function createLoadingScreen({
  poster,
  image,
  line,
  showSpinner,
  source = (url) => artworkSource(landscapeArtwork(url)),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
}) {
  let generation = 0;
  let active = false;
  let stage = "connecting";
  let timer = null;

  const say = () => {
    line.textContent = SLOW_LINES[stage];
    line.classList.remove("hidden");
  };

  return {
    get active() {
      return active;
    },

    // A tap (or a stream Yolo sent) begins: the picture, when the item has
    // one, and the spinner.
    show({ artwork = null } = {}) {
      const mine = ++generation;
      active = true;
      stage = "connecting";
      line.classList.add("hidden");
      line.textContent = "";
      image.classList.remove("ready");
      image.removeAttribute("src");
      poster.classList.remove("hidden");
      showSpinner();
      clearTimer(timer);
      timer = setTimer(say, SLOW_AFTER_MS);
      if (!artwork) return;
      void Promise.resolve(source(artwork)).then((url) => {
        if (!url || mine !== generation) return;
        image.onload = () => image.classList.add("ready");
        image.src = url;
      }, () => {});
    },

    // The stream arrived; now its first picture is awaited.
    streaming() {
      if (!active) return;
      stage = "loading";
      if (!line.classList.contains("hidden")) say();
    },

    // The picture moves, an error shows, or the owner left.
    hide() {
      generation += 1;
      active = false;
      clearTimer(timer);
      timer = null;
      line.classList.add("hidden");
      poster.classList.add("hidden");
    },
  };
}
