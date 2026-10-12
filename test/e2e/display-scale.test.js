import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { serveClient } from "./fixtures.js";
import { ensureClientBuilt } from "./yolo-stack.js";

// Display size on the Tesla browser of software 2026.26: a 773x601 window at
// devicePixelRatio 1.53 on a 1254x784 screen (as the car reports it). The
// page sets <meta name="viewport" content="width=N"> with N = physical width
// / scale; Chromium honours that with a mobile viewport, as the car's
// browser does for the community's width=1183.

const dist = resolve(fileURLToPath(new URL("../../clients/tesla/dist", import.meta.url)));
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(macChrome) ? macChrome : undefined);

async function carBrowser(t) {
  await ensureClientBuilt();
  const origin = await serveClient(t, dist);
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 773, height: 601 }, screen: { width: 1254, height: 784 }, deviceScaleFactor: 1.53, isMobile: true, hasTouch: true,
  });
  await context.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  return { context, origin };
}

const layout = (page) => page.evaluate(() => ({
  width: document.documentElement.clientWidth,
  meta: document.querySelector('meta[name="viewport"]').content,
  boot: globalThis.__yoloDisplayBoot,
  state: globalThis.__yolo?.displayScale.state,
}));

test("the car's browser lays the page out at the chosen display size", { timeout: 60_000 }, async (t) => {
  const { context, origin } = await carBrowser(t);
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(globalThis.__yolo?.displayScale));
  // First visit: the fingerprint says Tesla 2026.26, so 1.25: 1183 / 1.25.
  await page.waitForFunction(() => document.documentElement.clientWidth === 946);
  let now = await layout(page);
  assert.deepEqual([now.meta, now.state.scale, now.state.source], ["width=946", 1.25, "default"]);
  assert.deepEqual([now.boot.physicalWidth, now.boot.physicalHeight, Math.round(now.boot.devicePixelRatio * 100) / 100], [1183, 920, 1.53]);

  // Next time it applies before the first layout, from the measurement made
  // before any change.
  await page.reload();
  now = await layout(page);
  assert.deepEqual([now.width, now.boot.width, now.boot.source, now.boot.physicalWidth], [946, 946, "default", 1183]);

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
  // Every control in the sheet is a full touch target, and its content
  // scrolls clear of the dock (the bottom 15%).
  for (const box of await page.locator("#settings button").evaluateAll((buttons) => buttons.filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect().toJSON()))) {
    assert.ok(box.height >= 48 && box.width >= 48, JSON.stringify(box));
  }
  const clearance = await page.evaluate(() => {
    const body = document.getElementById("settings-body");
    body.scrollTop = body.scrollHeight;
    const last = [...body.querySelectorAll("a, button")].filter((element) => element.offsetParent).at(-1).getBoundingClientRect();
    return { bottom: last.bottom, height: innerHeight };
  });
  assert.ok(clearance.bottom <= clearance.height * 0.85, JSON.stringify(clearance));

  await steps.filter({ hasText: "Smaller" }).tap();
  await page.waitForFunction(() => document.documentElement.clientWidth === 1029);
  assert.equal(await page.locator('#settings .size-step[aria-checked="true"] .size-label').innerText(), "Smaller");
  // Escape closes the sheet (a keyboard, as on a computer); Close does too.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("settings").open && location.pathname === "/");
  // Playwright's taps miss in an emulated page laid out wider than its window
  // (width=1029 in a 773 window); press the buttons directly.
  await page.evaluate(() => document.getElementById("btn-settings").click());
  await page.waitForFunction(() => document.getElementById("settings").open);
  await page.evaluate(() => document.getElementById("settings-close").click());
  await page.waitForFunction(() => !document.getElementById("settings").open && location.pathname === "/");
  await page.reload();
  assert.equal((await layout(page)).width, 1029, "the choice is kept on this device");

  // ?scale= for a quick test, not saved; 1.0 is the community's width=1183.
  const quick = await context.newPage();
  await quick.goto(`${origin}/?scale=1.0`);
  assert.equal((await layout(quick)).width, 1183);
  await page.reload();
  assert.equal((await layout(page)).width, 1029);

  // Largest is the browser's own 773.
  await page.evaluate(() => globalThis.__yolo.displayScale.choose("native"));
  await page.waitForFunction(() => document.documentElement.clientWidth === 773);
});

test("a computer's browser keeps its own scale and offers no display size", { timeout: 60_000 }, async (t) => {
  await ensureClientBuilt();
  const origin = await serveClient(t, dist);
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  // A Mac at 2x that once saved a size (the old chips showed there too).
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await context.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await context.addInitScript(() => {
    localStorage.setItem("yolo.displayScaleAuto", "native");
    localStorage.setItem("yolo.displayScale", "1.35");
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(globalThis.__yolo?.displayScale));
  const now = await layout(page);
  assert.deepEqual([now.width, now.meta, now.state.eligible, await page.evaluate(() => document.documentElement.dataset.profile)],
    [1440, "width=device-width, initial-scale=1.0", false, "web"]);
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
