import assert from "node:assert/strict";
import test from "node:test";

import { createLoadingScreen, SLOW_AFTER_MS } from "../../src/loading.js";

const element = () => {
  const classes = new Set(["hidden"]);
  return {
    textContent: "",
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    removeAttribute(name) {
      delete this[name];
    },
  };
};

function screen() {
  const env = { timers: [], spinner: 0, sources: [] };
  env.poster = element();
  env.image = element();
  env.line = element();
  env.loading = createLoadingScreen({
    poster: env.poster,
    image: env.image,
    line: env.line,
    showSpinner: () => {
      env.spinner += 1;
    },
    source: async (url) => {
      env.sources.push(url);
      return `blob:${url}`;
    },
    setTimer: (fn, ms) => env.timers.push({ fn, ms }) - 1,
    clearTimer: (id) => {
      if (env.timers[id]) env.timers[id].fn = () => {};
    },
  });
  return env;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("loading shows the item's picture and the one spinner, without words until the wait is long", async () => {
  const at = screen();
  at.loading.show({ artwork: "/v1/library/items/plex%3A7/artwork" });
  await tick();
  assert.equal(at.poster.classList.contains("hidden"), false);
  assert.equal(at.image.src, "blob:/v1/library/items/plex%3A7/artwork");
  assert.equal(at.spinner, 1);
  assert.equal(at.line.classList.contains("hidden"), true);
  assert.equal(at.line.textContent, "");

  // Only a long wait says something, and nothing technical.
  assert.equal(at.timers.at(-1).ms, SLOW_AFTER_MS);
  at.timers.at(-1).fn();
  assert.equal(at.line.classList.contains("hidden"), false);
  assert.equal(at.line.textContent, "Connecting to the home server…");
  at.loading.streaming();
  assert.equal(at.line.textContent, "Still loading…");

  // The picture moves: everything goes.
  at.loading.hide();
  assert.equal(at.poster.classList.contains("hidden"), true);
  assert.equal(at.line.classList.contains("hidden"), true);

  // A picture that arrives after the screen went is not shown.
  at.loading.show({ artwork: "https://img.test/a.jpg" });
  at.loading.hide();
  await tick();
  assert.equal(at.image.src, undefined);
});
