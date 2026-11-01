import { h } from "./dom.js";

// One line of text in a box no wider than its CSS allows (the player's
// title): text that fits sits still; text that does not scrolls from right
// to left, round and round, a copy following after a gap, with a rest at
// the start of each round, so all of it passes by. The motion is CSS
// (style.css), which pauses it while the controls are hidden and leaves it
// out for reduced motion.

const GAP_PX = 48;
const SPEED_PX_PER_S = 40;
// The rest at the start, as a share of each round (style.css's keyframes).
const REST_SHARE = 0.15;

export function createMarquee(box) {
  let text = "";
  const track = h("span", { class: "marquee-track" });
  box.replaceChildren(track);

  function measure() {
    const first = h("span", { class: "marquee-text", text });
    track.replaceChildren(first);
    const overflow = first.offsetWidth > box.clientWidth + 1;
    box.classList.toggle("scrolling", overflow);
    if (!overflow) return;
    track.append(h("span", { class: "marquee-text", text, "aria-hidden": "true" }));
    const distance = first.offsetWidth + GAP_PX;
    box.style.setProperty("--marquee-gap", `${GAP_PX}px`);
    box.style.setProperty("--marquee-distance", `${distance}px`);
    box.style.setProperty("--marquee-duration", `${(distance / SPEED_PX_PER_S / (1 - REST_SHARE)).toFixed(2)}s`);
  }

  // The box's width follows the window (and the text, up to its cap).
  let width = 0;
  new ResizeObserver(() => {
    if (box.clientWidth === width) return;
    width = box.clientWidth;
    measure();
  }).observe(box);

  return {
    get text() {
      return text;
    },
    // The same text again (a new stream of the same item) keeps its place.
    set(value) {
      const next = String(value ?? "");
      if (next === text) return;
      text = next;
      measure();
    },
  };
}
