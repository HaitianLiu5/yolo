import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { makeMedia, mediaOrigin } from "./fixtures.js";
import { CHROMIUM_EXECUTABLE, eventually, launchBrowser, openPage, pair, playingPast, waitFor } from "./browser.js";
import { OWNER, startYolo } from "./yolo-stack.js";

// Yolo Web (Agent Note 2026-10-11-yolo-web-client): owner settings behind the
// passkey session, a browser as the remote for another device, and playback
// in a computer's and a phone's browser. The owner's passkey ceremony is
// stood in for by the session it leaves behind (yolo.ownerSession).

const PHONE_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36";
const PASSKEY_SEED = `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
  VALUES ('e2e-passkey', '${OWNER}', 'x', 0, '["internal"]', 'multiDevice', 1, 'E2E passkey', 0);\n`;

let mediaDir;

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "yolo-e2e-web-"));
  await makeMedia(mediaDir, { seconds: 120 });
});

after(async () => {
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
});

// A browser with its own window, for sizes other than launchBrowser's.
async function browserWith(t, options) {
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_EXECUTABLE, args: ["--autoplay-policy=no-user-gesture-required"] });
  t.after(() => browser.close());
  const context = await browser.newContext(options);
  return context;
}

// The owner signed in with a passkey on this browser. (A host-only cookie:
// Chromium refuses a __Host- cookie added by URL on plain http.)
const signIn = (context, yolo) => context.addCookies([{
  name: yolo.ownerSession.name, value: yolo.ownerSession.value, domain: new URL(yolo.origin).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax",
}]);

const devicesOf = async (yolo, token) => (await yolo.api(token, "/v1/devices")).body.devices;

test("owner settings need the owner's passkey session; a device credential never reaches them", { timeout: 180_000 }, async (t) => {
  const yolo = await startYolo(t, { seed: PASSKEY_SEED });
  const context = await launchBrowser(t);
  const { page, errors } = await openPage(context, yolo.origin);
  const credential = await pair(yolo, page);

  // A paired device's credential is a bearer token, never an owner session.
  for (const [method, path] of [["GET", "/v1/owner/devices"], ["GET", "/v1/owner/agents"], ["DELETE", `/v1/owner/devices/${credential.deviceId}`]]) {
    const response = await fetch(`${yolo.origin}${path}`, { method, headers: { authorization: `Bearer ${credential.token}`, "x-yolo-owner": "1", origin: yolo.origin } });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  // The owner's session, sent by another site: refused.
  const crossSite = await fetch(`${yolo.origin}/v1/owner/devices/${credential.deviceId}`, {
    method: "PATCH",
    headers: { cookie: yolo.ownerSession.cookie, "x-yolo-owner": "1", origin: "https://evil.test", "content-type": "application/json" },
    body: JSON.stringify({ name: "Hacked" }),
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await fetch(`${yolo.origin}/v1/owner/devices`, { headers: { cookie: yolo.ownerSession.cookie } })).status, 403, "no X-Yolo-Owner");

  // In this browser, settings are locked until the owner signs in.
  await page.locator("#btn-settings").click();
  await page.waitForSelector("#settings[open] .locked");
  assert.equal(await page.locator("#settings-sign-in").innerText(), "Sign in with passkey");
  assert.match(await page.locator("#settings-device-name").innerText(), /\S/);
  await page.locator("#settings-close").click();
  await page.waitForFunction(() => !document.getElementById("settings").open && location.pathname === "/");

  // Signed in with a passkey; an agent connected meanwhile.
  await signIn(context, yolo);
  const agent = await yolo.agentToken();
  assert.equal((await yolo.api(agent, "/v1/me")).status, 200);
  await page.locator("#btn-settings").click();
  const self = page.locator(`#settings [data-device="${credential.deviceId}"]`);
  await self.waitFor();
  assert.match(await self.innerText(), /This screen/);

  // Rename this browser in place.
  await self.getByRole("button", { name: /^Rename/ }).click();
  await page.locator('#settings .row-edit input[name="name"]').fill("Desk");
  await page.locator('#settings .row-edit button[type="submit"]').click();
  await eventually(async () => (await devicesOf(yolo, credential.token)).find((device) => device.id === credential.deviceId)?.name === "Desk", "the rename");
  // Settings reload after a rename and redraw every row, which would drop a
  // Revoke armed meanwhile: wait until the list shows the new name.
  await self.filter({ hasText: "Desk" }).waitFor();

  // Revoke the agent: it asks once more, then the agent's token stops working.
  const agentRow = page.locator("#settings [data-agent]").filter({ hasText: "E2E agent" });
  await agentRow.getByRole("button", { name: "Revoke E2E agent" }).click();
  await agentRow.getByRole("button", { name: "Revoke?" }).click();
  await agentRow.waitFor({ state: "detached" });
  await eventually(async () => (await yolo.api(agent, "/v1/me")).status === 401, "the agent's token to be revoked");

  // Passkeys are listed; the only one cannot be removed.
  const passkeys = page.locator('#settings ul[aria-label="Passkeys"]');
  assert.match(await passkeys.innerText(), /E2E passkey[\s\S]*Your only passkey/);
  assert.equal(await passkeys.getByRole("button", { name: /^Remove/ }).count(), 0);

  // Signing out locks owner settings again.
  await page.locator("#settings").getByRole("button", { name: "Sign out" }).click();
  await page.waitForSelector("#settings[open] .locked");
  assert.equal((await fetch(`${yolo.origin}/v1/owner/devices`, { headers: { cookie: yolo.ownerSession.cookie, "x-yolo-owner": "1" } })).status, 401);
  assert.deepEqual(errors, []);
});

test("a browser is a remote for the car: it pauses it, takes playback over, and hands it back", { timeout: 240_000 }, async (t) => {
  const media = await mediaOrigin(t, mediaDir);
  const yolo = await startYolo(t);
  const car = await openPage(await launchBrowser(t), yolo.origin);
  const carCredential = await pair(yolo, car.page, { kind: "car", name: "Model Y" });
  const web = await openPage(await launchBrowser(t), yolo.origin);
  const webCredential = await pair(yolo, web.page);

  const played = await yolo.api(carCredential.token, "/v1/playback/play", {
    method: "POST", body: { url: `${media.url}/hls/index.m3u8`, startTime: 0, deviceId: carCredential.deviceId },
  });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  await playingPast(car.page, 1, "the car playing");

  // The browser shows what plays where, with its controls.
  await waitFor(web.page, () => !document.getElementById("now-playing").classList.contains("hidden")
    && document.querySelector("#now-playing .np-device").textContent.includes("Model Y"), null, "the now-playing bar");
  await web.page.locator("#np-toggle").click();
  await waitFor(car.page, () => globalThis.__yoloPlayer?.player?.getStatus() === "paused", null, "paused from the browser");
  await web.page.locator("#np-toggle").click();
  await playingPast(car.page, 2, "playing again from the browser");

  // Move playback here: the browser plays on from where the car was.
  await web.page.locator("#np-devices").click();
  await web.page.locator("#device-picker").getByRole("button", { name: /This browser/ }).click();
  const carAt = await car.page.evaluate(() => globalThis.__yoloPlayer?.player?.getCurrentTime() ?? 0);
  await playingPast(web.page, Math.max(1, carAt - 1), "playing in the browser", 45_000);
  assert.equal(await web.page.evaluate(() => globalThis.__yoloPlayer.engine), "native", "the browser plays with its <video> element");
  await waitFor(car.page, () => !globalThis.__yoloPlayer && !document.getElementById("now-playing").classList.contains("hidden"), null, "the car a remote now");
  assert.equal((await yolo.api(webCredential.token, "/v1/playback")).body.deviceId, webCredential.deviceId);

  // And back to the car, from the car.
  await car.page.locator("#np-devices").click();
  await car.page.locator("#device-picker").getByRole("button", { name: /This screen/ }).click();
  await playingPast(car.page, 2, "playing in the car again", 45_000);
  assert.equal(await car.page.evaluate(() => globalThis.__yoloPlayer.engine), "canvas", "the car plays with the canvas engine");
  await waitFor(web.page, () => !globalThis.__yoloPlayer, null, "the browser a remote again");
  assert.deepEqual([...car.errors, ...web.errors], []);
});

test("Back leaves the item paused in this browser's now-playing bar, which plays it again or stops it", { timeout: 180_000 }, async (t) => {
  const media = await mediaOrigin(t, mediaDir);
  const yolo = await startYolo(t);
  const { page, errors } = await openPage(await launchBrowser(t), yolo.origin);
  const credential = await pair(yolo, page);
  const played = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST", body: { url: `${media.url}/hls/index.m3u8`, startTime: 0, deviceId: credential.deviceId },
  });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  await playingPast(page, 4, "playing in the browser");

  // Back: home, with the item paused here at the position reached, also
  // after a reload.
  await page.evaluate(() => document.getElementById("btn-back").click());
  const parked = () => waitFor(page, () => location.pathname === "/" && !globalThis.__yoloPlayer
    && !document.getElementById("browse-screen").classList.contains("hidden")
    && !document.getElementById("now-playing").classList.contains("hidden")
    && document.querySelector("#now-playing .np-device").textContent === "Paused on This browser", null, "the bar with this browser's item");
  await parked();
  const left = (await yolo.api(credential.token, "/v1/playback")).body;
  assert.deepEqual([left.status, left.deviceId], ["paused", credential.deviceId]);
  assert.ok(left.position > 4, `left at ${left.position}`);
  await page.reload();
  await parked();

  // Its play button opens the player at that position.
  await page.locator("#np-toggle").click();
  await playingPast(page, left.position + 0.5, "playing again from the bar", 45_000);
  assert.equal(await page.evaluate(() => location.pathname), "/play");
  assert.ok(await page.evaluate(() => globalThis.__yoloPlayer.player.getCurrentTime()) < left.position + 10, "not from the start or further on");

  // "Stop playing" clears it.
  await page.evaluate(() => document.getElementById("btn-back").click());
  await parked();
  await page.locator("#np-devices").click();
  await page.locator("#device-picker").getByRole("button", { name: "Stop playing" }).click();
  await waitFor(page, () => document.getElementById("now-playing").classList.contains("hidden"), null, "the bar gone");
  assert.equal((await yolo.api(credential.token, "/v1/playback")).body.status, "idle");
  assert.deepEqual(errors, []);
});

test("Yolo Web pairs with the owner's passkey and plays at desktop and phone sizes", { timeout: 240_000 }, async (t) => {
  const media = await mediaOrigin(t, mediaDir);
  const yolo = await startYolo(t);
  const link = `${media.url}/hls/index.m3u8`;
  const screens = {};

  for (const [label, options] of [
    ["desktop", { viewport: { width: 1440, height: 900 } }],
    ["phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: PHONE_UA }],
  ]) {
    const context = await browserWith(t, options);
    // Signed in with a passkey here: one press pairs this browser, no scan.
    await signIn(context, yolo);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(yolo.origin);
    await waitFor(page, () => document.getElementById("pair-passkey")?.textContent === "Pair this browser", null, `${label}: pair with the passkey`);
    await page.locator("#pair-passkey").click();
    await waitFor(page, () => Boolean(globalThis.__yolo?.state?.deviceId), null, `${label}: paired`);
    const deviceId = await page.evaluate(() => globalThis.__yolo.state.deviceId);
    screens[label] = { page, errors, deviceId };
    assert.equal(await page.evaluate(() => document.documentElement.dataset.profile), "web");
    // The layout fits the window: no sideways scrolling.
    await page.waitForSelector("#home-header");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} fits its width`);
  }
  const token = (await screens.desktop.page.evaluate(() => JSON.parse(localStorage.getItem("yolo.device")))).token;
  const kinds = Object.fromEntries((await devicesOf(yolo, token)).map((device) => [device.id, device.kind]));
  assert.deepEqual([kinds[screens.desktop.deviceId], kinds[screens.phone.deviceId]], ["browser", "phone"]);

  // On the computer: paste a link and play it here.
  const { page: desktop } = screens.desktop;
  await desktop.locator("#search-input").fill(link);
  await desktop.getByRole("button", { name: "Play link" }).click();
  await playingPast(desktop, 1, "playing on the computer", 45_000);
  assert.equal(await desktop.evaluate(() => globalThis.__yoloPlayer.engine), "native");
  const controls = await desktop.evaluate(() => document.getElementById("controls-row").getBoundingClientRect().bottom);
  assert.ok(controls <= 900, `controls end at ${controls}`);

  // On the phone, a tap plays where playback is: on the computer.
  const { page: phone } = screens.phone;
  await waitFor(phone, () => !document.getElementById("now-playing").classList.contains("hidden"), null, "the phone's now-playing bar");
  const before = await yolo.api(token, "/v1/playback");
  await phone.locator("#search-input").fill(link);
  await phone.getByRole("button", { name: "Play link" }).tap();
  await eventually(async () => (await yolo.api(token, "/v1/playback")).body.sessionId !== before.body.sessionId, "a new play on the computer");
  assert.equal((await yolo.api(token, "/v1/playback")).body.deviceId, screens.desktop.deviceId);

  // Then the phone takes it and plays in its own window.
  await phone.locator("#search-clear").tap();
  await phone.locator("#np-devices").tap();
  await phone.locator("#device-picker").getByRole("button", { name: /This browser/ }).tap();
  await playingPast(phone, 1, "playing on the phone", 45_000);
  const phoneLayout = await phone.evaluate(() => ({
    picture: document.querySelector('#player-container video[data-engine="native"]').getBoundingClientRect().toJSON(),
    width: innerWidth,
  }));
  assert.ok(phoneLayout.picture.width <= phoneLayout.width + 1, JSON.stringify(phoneLayout));
  assert.deepEqual([...screens.desktop.errors, ...screens.phone.errors], []);
});
