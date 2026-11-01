import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchBrowser, openPage, pair, waitFor } from "./browser.js";
import { startYolo } from "./yolo-stack.js";

// The home's cold start (Agent Note 2026-10-31-home-cold-start): a new
// home asks where the owner watches; choosing turns plugins on in the
// running node, the answer counts on every screen, and a TV follows a phone.
const root = fileURLToPath(new URL("../../", import.meta.url));

test("a new home asks where the owner watches: a choice turns its plugins on in place, and no other screen asks again", { timeout: 180_000 }, async (t) => {
  const yolo = await startYolo(t, {
    pluginConfig: { plugins: [{ source: join(root, "plugins/source-ytdlp"), builtIn: true }] },
    seed: "DELETE FROM home_setup;",
  });
  const context = await launchBrowser(t);
  const { hostname } = new URL(yolo.origin);
  await context.addCookies([{ name: yolo.ownerSession.name, value: yolo.ownerSession.value, domain: hostname, path: "/", secure: true, sameSite: "Lax" }]);

  const { page, errors } = await openPage(context, yolo.origin);
  await pair(yolo, page, { kind: "browser" });
  await waitFor(page, () => !document.getElementById("home-setup").classList.contains("hidden"), null, "the guide");
  assert.equal(await page.locator("#home-setup-title").innerText(), "Where do you usually watch?");

  // Just ask my agent: no connect step, so the guide ends on the home.
  await page.locator('[data-place="agent"]').click();
  await page.getByRole("button", { name: "Continue" }).click();
  await waitFor(page, () => document.getElementById("home-setup").classList.contains("hidden"), null, "the guide closed");
  const config = JSON.parse(readFileSync(join(yolo.dir, "yolo.config.json"), "utf8"));
  assert.deepEqual(config.plugins.map((entry) => entry.source.split("/").at(-1)), ["agent-claude-code", "agent-codex", "source-ytdlp"]);
  const { body: catalog } = await yolo.node("/internal/v1/plugins", {}, "GET");
  assert.deepEqual(catalog.places.find((place) => place.id === "agent").state, "on");
  assert.equal(catalog.plugins.find((plugin) => plugin.name === "@useyolo/agent-claude-code").state, "on", "loaded without a restart");

  // A second screen, a TV, never asks: the owner answered.
  const tv = await openPage(await launchBrowser(t), yolo.origin);
  await pair(yolo, tv.page, { kind: "tv" });
  await waitFor(tv.page, () => !document.getElementById("browse-screen").classList.contains("hidden"), null, "the TV's home");
  await tv.page.waitForTimeout(1500);
  assert.ok(await tv.page.locator("#home-setup").evaluate((element) => element.classList.contains("hidden")), "the TV shows no guide");
  assert.deepEqual([...errors, ...tv.errors], []);
});
