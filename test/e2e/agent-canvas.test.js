import assert from "node:assert/strict";
import { test } from "node:test";
import { CAR_BROWSER, eventually, launchBrowser, openPage, pair, waitFor } from "./browser.js";
import { startMediaStack } from "./fixtures.js";

// The agent canvas (Agent Note 2026-10-21-agent-canvas) on the whole stack:
// an agent offers choices over MCP, the paired car shows them over its home
// screen, a tap plays the pick at once and answers the agent's offer; over
// the picture they are a shelf whose After this queues the pick next; a
// note shows in a corner until the person closes it.

test("an agent's choices play or queue the pick from the car, and a note closes", { timeout: 300_000 }, async (t) => {
  const { media, yolo } = await startMediaStack(t, { seconds: 120 });
  const { page, errors } = await openPage(await launchBrowser(t, { context: CAR_BROWSER }), yolo.origin);
  const credential = await pair(yolo, page, { kind: "car" });
  const agent = await yolo.agentToken();

  // Over the home screen: a spotlight, Yolo's own titles, and the agent's line.
  const offered = yolo.mcp(agent, "offer", {
    title: "Which one?",
    options: [{ url: `${media.url}/clip.webm`, note: "the short one" }, { url: `${media.url}/hls/index.m3u8` }],
    wait_seconds: 30,
  });
  await page.waitForSelector(".canvas-choices.spotlight .canvas-choice", { timeout: 20_000 });
  assert.equal(await page.locator(".canvas-choice").count(), 2);
  assert.match(await page.locator(".canvas-choice").first().innerText(), /the short one/);
  assert.equal(await page.locator(".canvas-after").count(), 0, "nothing plays here, so there is nothing to come after");
  await page.locator(".canvas-choice .browse-card-primary").nth(1).click();
  const answer = await offered;
  assert.equal(answer.status, "chosen");
  assert.equal(answer.option, 1);
  assert.equal(answer.played, true);
  await waitFor(page, () => globalThis.__yoloPlayer?.player?.getCurrentTime() > 0.5, null, "the pick plays");
  await page.waitForSelector(".canvas-choices", { state: "detached" });

  // Over the picture: a shelf, and After this queues the pick next.
  const waiting = await yolo.mcp(agent, "offer", { options: [{ url: `${media.url}/clip.webm` }], wait_seconds: 0 });
  assert.equal(waiting.status, "waiting");
  await page.waitForSelector(".canvas-choices.shelf .canvas-after", { timeout: 20_000 });
  await page.locator(".canvas-after").click();
  const queued = await eventually(async () => {
    const { events } = await yolo.mcp(agent, "canvas_events", { since: waiting.cursor });
    return events.find((entry) => entry.queued);
  }, "the pick is queued");
  assert.equal(queued.objectId, waiting.id);
  assert.match(JSON.stringify(await yolo.mcp(agent, "queue_list")), /clip\.webm/);

  // A note, in the car on the driver's side, until it is closed.
  const { object } = await yolo.mcp(agent, "canvas_put", { kind: "note", props: { title: "Tyres", text: "At 9 tomorrow" } });
  await page.waitForSelector(".canvas-card.note", { timeout: 20_000 });
  assert.match(await page.locator(".canvas-card.note").innerText(), /At 9 tomorrow/);
  await page.locator(".canvas-card.note .canvas-close").click();
  await page.waitForSelector(".canvas-card.note", { state: "detached" });
  const { screens } = await yolo.mcp(agent, "canvas_read", { device: credential.deviceId });
  assert.equal(screens[0].objects.some((entry) => entry.id === object.id), false);
  assert.deepEqual(errors, []);
});
