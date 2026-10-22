import { artworkSource, landscapeArtwork } from "./artwork.js";

// What the screen shows from a tap until the picture moves (Agent Note
// 2026-10-11-device-telemetry): the item's own picture at once, lightly
// dimmed, under the one small spinner, and no words, however long it
// takes; as the YouTube and Netflix apps do. An error keeps its own panel.
// The picture is the item's artwork, which its card already loaded.

/**
 * @param {object} elements  the poster and its <img>
 * @param {() => void} options.showSpinner  the centre spinner (controls.js)
 */
export function createLoadingScreen({
  poster,
  image,
  showSpinner,
  source = (url) => artworkSource(landscapeArtwork(url)),
}) {
  let generation = 0;
  let active = false;
  let shownArtwork = null;

  return {
    get active() {
      return active;
    },

    // A tap (or a stream Yolo sent) begins: the picture, when the item has
    // one, and the spinner. The same item's picture, already up (a start
    // that showed it before its welcome), stays as it is.
    show({ artwork = null } = {}) {
      showSpinner();
      if (active && artwork === shownArtwork) return;
      const mine = ++generation;
      active = true;
      shownArtwork = artwork;
      image.classList.remove("ready");
      image.removeAttribute("src");
      poster.classList.remove("hidden");
      if (!artwork) return;
      void Promise.resolve(source(artwork)).then((url) => {
        if (!url || mine !== generation) return;
        image.onload = () => image.classList.add("ready");
        image.src = url;
      }, () => {});
    },

    // The picture moves, an error shows, or the owner left.
    hide() {
      generation += 1;
      active = false;
      shownArtwork = null;
      poster.classList.add("hidden");
    },
  };
}
