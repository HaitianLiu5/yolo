import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { serveClient } from "./fixtures.js";
import { CAR_BROWSER, CHROMIUM_EXECUTABLE } from "./browser.js";
import { ensureClientBuilt } from "./yolo-stack.js";

// Display size on the Tesla browser of software 2026.26: a 773x601 window at
// devicePixelRatio 1.53 on a 1254x784 screen, in a desktop Chrome that
// ignores the viewport meta (as the car reports it). The page zooms its
// root by scale / 1.53 and lays out 773 / zoom CSS px wide.

const dist = resolve(fileURLToPath(new URL("../../clients/player/dist", import.meta.url)));

async function carBrowser(t) {
  await ensureClientBuilt();
  const origin = await serveClient(t, dist);
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const context = await browser.newContext(CAR_BROWSER);
  return { context, origin };
}

// `width` is the CSS width the page lays out at; the window stays 773 wide.
const layout = (page) => page.evaluate(() => ({
  width: document.body.clientWidth,
  innerWidth,
  zoom: getComputedStyle(document.documentElement).zoom,
  meta: document.querySelector('meta[name="viewport"]').content,
  boot: globalThis.__yoloDisplayBoot,
  state: globalThis.__yolo?.displayScale.state,
}));

test("the car's browser lays the page out at the chosen display size", { timeout: 60_000 }, async (t) => {
  const { context, origin } = await carBrowser(t);
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(globalThis.__yolo?.displayScale));
  // First visit: the fingerprint says Tesla 2026.26, so 1.25: a zoom of
  // 1.25 / 1.53, and 773 / 0.817 = 946 CSS px across.
  await page.waitForFunction(() => document.body.clientWidth === 946);
  let now = await layout(page);
  assert.deepEqual([now.zoom, now.innerWidth, now.state.scale, now.state.source], ["0.817", 773, 1.25, "default"]);
  assert.equal(now.meta, "width=device-width, initial-scale=1.0", "the viewport meta is left alone");
  assert.equal(Math.round(now.boot.devicePixelRatio * 100) / 100, 1.53);
  // Yolo still hears of the screen in physical pixels.
  assert.deepEqual(await page.evaluate(() => globalThis.__yolo.displayScale.physicalViewport()), { width: 1183, height: 920 });

  // Next time it applies before the first layout.
  await page.reload();
  now = await layout(page);
  assert.deepEqual([now.width, now.boot.zoom, now.boot.width, now.boot.source], [946, 0.817, 946, "default"]);

  // The owner picks another size in settings, opened from the home screen.
  // (No control plane here: the page would pair. Show the home screen.)
  const showHome = () => page.evaluate(() => {
    document.getElementById("pair-screen").classList.add("hidden");
    document.getElementById("status-screen").style.display = "none";
    document.getElementById("browse-screen").classList.remove("hidden", "episodes-open");
  });
  await showHome();
  assert.equal(await page.locator("#display-scale, #display-section").count(), 0, "no size chips on the home screen");
  await page.locator("#btn-settings").tap();
  await page.waitForFunction(() => document.getElementById("settings").open && location.pathname === "/settings");
  const steps = page.locator("#settings .size-step");
  assert.deepEqual(await steps.locator(".size-label").allInnerTexts(), ["Smallest", "Smaller", "Default", "Larger", "Largest"]);
  assert.equal(await page.locator('#settings .size-step[aria-checked="true"] .size-label').innerText(), "Default");
  // Every control in the sheet is a full 48 CSS px touch target (about 60
  // physical pixels at Default), and the sheet's content scrolls to its end
  // inside the window: the window ends above the car's dock.
  for (const box of await page.locator("#settings button").evaluateAll((buttons) => buttons.filter((b) => b.offsetParent).map((b) => ({ width: b.offsetWidth, height: b.offsetHeight, screen: b.getBoundingClientRect().height * devicePixelRatio })))) {
    assert.ok(box.height >= 48 && box.width >= 48 && box.screen >= 58, JSON.stringify(box));
  }
  const end = await page.evaluate(() => {
    const body = document.getElementById("settings-body");
    body.scrollTop = body.scrollHeight;
    const last = [...body.querySelectorAll("a, button")].filter((element) => element.offsetParent).at(-1).getBoundingClientRect();
    return { bottom: last.bottom, height: innerHeight };
  });
  assert.ok(end.bottom <= end.height, JSON.stringify(end));

  // Taps land on what they show at every size.
  await steps.filter({ hasText: "Smaller" }).tap();
  await page.waitForFunction(() => Math.abs(document.body.clientWidth - 1028) <= 1);
  assert.equal(await page.locator('#settings .size-step[aria-checked="true"] .size-label').innerText(), "Smaller");
  // Escape closes the sheet (a keyboard, as on a computer); Close does too.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("settings").open && location.pathname === "/");
  await page.locator("#btn-settings").tap();
  await page.waitForFunction(() => document.getElementById("settings").open);
  await page.locator("#settings-close").tap();
  await page.waitForFunction(() => !document.getElementById("settings").open && location.pathname === "/");
  await page.reload();
  assert.ok(Math.abs((await layout(page)).width - 1028) <= 1, "the choice is kept on this device");
});

test("a computer's browser keeps its own scale and offers no display size", { timeout: 60_000 }, async (t) => {
  await ensureClientBuilt();
  const origin = await serveClient(t, dist);
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  // A Mac at 2x that once saved a size (the old chips showed there too).
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    localStorage.setItem("yolo.displayScaleAuto", "native");
    localStorage.setItem("yolo.displayScale", "1.35");
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(globalThis.__yolo?.displayScale));
  const now = await layout(page);
  assert.deepEqual([now.width, now.zoom, now.meta, now.state.eligible, await page.evaluate(() => document.documentElement.dataset.profile)],
    [1440, "1", "width=device-width, initial-scale=1.0", false, "web"]);
  await page.evaluate(() => {
    document.getElementById("pair-screen").classList.add("hidden");
    document.getElementById("status-screen").style.display = "none";
    document.getElementById("browse-screen").classList.remove("hidden");
  });
  await page.locator("#btn-settings").click();
  await page.waitForFunction(() => document.getElementById("settings").open);
  assert.equal(await page.locator("#settings .size-step").count(), 0);
  // Keyboard: Tab stays inside the sheet, Escape leaves it and returns focus.
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest("#settings"))), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("settings").open);
  assert.equal(await page.evaluate(() => document.activeElement.id), "btn-settings");
});
