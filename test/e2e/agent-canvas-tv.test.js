import assert from "node:assert/strict";
import { test } from "node:test";
import { eventually, launchBrowser, openPage, pair, waitFor } from "./browser.js";
import { startMediaStack } from "./fixtures.js";

// The agent canvas (Agent Note 2026-10-21-agent-canvas) on a screen paired as
// a TV, driven only by its remote (Agent Note 2026-10-26-tv-web-client):
// choices take focus when they appear, the arrows reach every card and its
// After this, OK picks, Back and the close button dismiss them and leave the
// picture playing, and a note's close button is reached among the player's
// controls.

const TV = Object.freeze({ viewport: { width: 1920, height: 1080 } });

// Back is Tizen's XF86Back, which Playwright's keyboard has no name for.
async function back(page) {
  const cdp = await page.context().newCDPSession(page);
  for (const type of ["rawKeyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "XF86Back", windowsVirtualKeyCode: 10009 });
  await cdp.detach();
}

const focusOn = (page, selector, label) => waitFor(page, (wanted) => document.activeElement?.matches(wanted), selector, label, 10_000);
const card = (n, part = ".browse-card-primary") => `.canvas-choices-row > :nth-child(${n}) ${part}`;

test("a TV's remote picks, queues, and closes an agent's choices, and closes a note", { timeout: 300_000 }, async (t) => {
  const { media, yolo } = await startMediaStack(t, { seconds: 120 });
  const { page, errors } = await openPage(await launchBrowser(t, { context: TV }), yolo.origin);
  await pair(yolo, page, { kind: "tv" });
  const agent = await yolo.agentToken();
  const clip = `${media.url}/clip.webm`;
  const hls = `${media.url}/hls/index.m3u8`;

  // Over the home screen: focus lands on the first card, the arrows move
  // along the row, and OK plays the pick.
  const offered = yolo.mcp(agent, "offer", { title: "Which one?", options: [{ url: clip }, { url: hls }], wait_seconds: 30 });
  await page.waitForSelector(".canvas-choices.spotlight .canvas-choice", { timeout: 20_000 });
  await focusOn(page, card(1), "the first choice takes focus");
  await page.keyboard.press("ArrowRight");
  await focusOn(page, card(2), "right reaches the second choice");
  await page.keyboard.press("ArrowLeft");
  await focusOn(page, card(1), "left goes back");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  const answer = await offered;
  assert.equal(answer.status, "chosen");
  assert.equal(answer.option, 1);
  await waitFor(page, () => globalThis.__yoloPlayer?.player?.getCurrentTime() > 0.5, null, "the pick plays");
  await page.waitForSelector(".canvas-choices", { state: "detached" });

  // Over the picture: a shelf; each card's After this lies below it, and OK
  // on it queues that pick next.
  const waiting = await yolo.mcp(agent, "offer", { options: [{ url: hls }, { url: clip }], wait_seconds: 0 });
  await page.waitForSelector(".canvas-choices.shelf .canvas-after", { timeout: 20_000 });
  await focusOn(page, card(1), "the shelf's first choice takes focus");
  await page.keyboard.press("ArrowDown");
  await focusOn(page, card(1, ".canvas-after"), "down reaches its After this");
  await page.keyboard.press("ArrowRight");
  await focusOn(page, card(2, ".canvas-after"), "right reaches the next After this");
  await page.keyboard.press("ArrowUp");
  await focusOn(page, card(2), "up reaches its card");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const queued = await eventually(async () => {
    const { events } = await yolo.mcp(agent, "canvas_events", { since: waiting.cursor });
    return events.find((entry) => entry.queued);
  }, "the pick is queued");
  assert.equal(queued.objectId, waiting.id);
  assert.match(JSON.stringify(await yolo.mcp(agent, "queue_list")), /clip\.webm/);
  await page.waitForSelector(".canvas-choices", { state: "detached" });

  // Back dismisses the choices, as it closes a sheet, and the picture plays on.
  const backed = yolo.mcp(agent, "offer", { options: [{ url: clip }], wait_seconds: 30 });
  await page.waitForSelector(".canvas-choices.shelf", { timeout: 20_000 });
  await focusOn(page, card(1), "the choice takes focus");
  await back(page);
  assert.equal((await backed).status, "dismissed");
  await page.waitForSelector(".canvas-choices", { state: "detached" });
  assert.equal(await page.evaluate(() => document.getElementById("overlay").classList.contains("hidden")), true, "still on the player");
  assert.equal(await page.evaluate(() => globalThis.__yoloPlayer?.player?.getStatus()), "playing");

  // Up from a card reaches the close button, and OK on it dismisses them.
  const closed = yolo.mcp(agent, "offer", { options: [{ url: clip }], wait_seconds: 30 });
  await page.waitForSelector(".canvas-choices.shelf", { timeout: 20_000 });
  await focusOn(page, card(1), "the choice takes focus");
  await page.keyboard.press("ArrowUp");
  await focusOn(page, ".canvas-choices .canvas-close", "up reaches close");
  await page.keyboard.press("Enter");
  assert.equal((await closed).status, "dismissed");
  await page.waitForSelector(".canvas-choices", { state: "detached" });

  // A note in the corner over the picture: with the controls up, right past
  // the end of their top bar reaches its close button, and left comes back.
  const note = ".canvas-card.note .canvas-close";
  await yolo.mcp(agent, "canvas_put", { kind: "note", props: { title: "Tyres", text: "At 9 tomorrow" } });
  await page.waitForSelector(".canvas-card.note", { timeout: 20_000 });
  assert.equal(await page.evaluate(() => document.activeElement?.closest(".canvas-layer") ?? null), null, "a note takes no focus");
  await page.keyboard.press("ArrowUp");
  await focusOn(page, "#btn-play", "the controls come up on play");
  // Up past the seek bar.
  for (let i = 0; i < 4 && !(await page.evaluate(() => document.activeElement?.id === "btn-back")); i++) await page.keyboard.press("ArrowUp");
  await focusOn(page, "#btn-back", "up reaches the top bar");
  await page.keyboard.press("ArrowRight");
  await focusOn(page, note, "right reaches the note's close button");
  await page.keyboard.press("ArrowLeft");
  await focusOn(page, "#btn-back", "left comes back");
  await page.keyboard.press("ArrowRight");
  await focusOn(page, note, "and right again");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".canvas-card.note", { state: "detached" });
  assert.deepEqual(errors, []);
});
