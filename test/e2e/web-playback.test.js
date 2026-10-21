import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { deviceEvents, eventually, launchBrowser, openPage, pair, playingPast, statusIs, waitFor } from "./browser.js";
import { startMediaStack } from "./fixtures.js";
import { fileContext, OWNER } from "./yolo-stack.js";

// The web profile on one stack (Agent Note 2026-10-12-two-playback-engines):
// the four stream types through the browser's <video> element, pairing with
// the owner's passkey (stood in for by yolo.ownerSession), and owner
// settings behind it, last, since signing out ends the session.
// YOLO_E2E_WEBKIT=1 also runs the stream types and Plex in Playwright's WebKit.

const SECONDS = 120;
const PHONE_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36";
const PASSKEY_SEED = `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
  VALUES ('e2e-passkey', '${OWNER}', 'x', 0, '["internal"]', 'multiDevice', 1, 'E2E passkey', 0);\n`;
const webkitOnly = { timeout: 300_000, skip: process.env.YOLO_E2E_WEBKIT !== "1" && "set YOLO_E2E_WEBKIT=1" };

const shared = fileContext();
let media;
let plex;
let yolo;

before(async () => {
  ({ media, plex, yolo } = await startMediaStack(shared, { seconds: SECONDS, plex: { commentary: true }, seed: PASSKEY_SEED }));
}, { timeout: 120_000 });

after(() => shared.cleanup());

const mode = (page) => page.evaluate(() => [globalThis.__yoloPlayer?.engine, globalThis.__yoloPlayer?.player?.mode]);
const currentTime = (page) => page.evaluate(() => globalThis.__yoloPlayer?.player?.getCurrentTime() ?? null);

// Commands a moment apart: the Hub closes a socket that sends over 30 messages in 10 s.
async function agentSays(agent, tool, args) {
  await yolo.mcp(agent, tool, args);
  await new Promise((done) => setTimeout(done, 1_200));
}

async function webPage(t, engine) {
  const context = await launchBrowser(t, { engine });
  const opened = await openPage(context, yolo.origin);
  const credential = await pair(yolo, opened.page);
  await waitFor(opened.page, () => globalThis.__yolo.profile.engine === "native", null, "the <video> engine");
  return { ...opened, context, credential };
}

// Signed in with a passkey here (a host-only cookie: no __Host- cookie by URL on http).
const signIn = (context) => context.addCookies([{
  name: yolo.ownerSession.name, value: yolo.ownerSession.value, domain: new URL(yolo.origin).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax",
}]);

async function playsStreamTypes(t, engine) {
  const { page, errors, credential } = await webPage(t, engine);
  const agent = await yolo.agentToken();
  const hlsMode = engine === "webkit" ? "native-hls" : "hls.js";
  const { devices } = await yolo.mcp(agent, "list_devices");
  assert.equal(devices.find((device) => device.id === credential.deviceId).capabilities.renderer, "html5-video");

  // direct: the element reads the file through /m/ with byte ranges (WebKit plays no WebM).
  await yolo.mcp(agent, "play", { url: `${media.url}/${engine === "webkit" ? "video.mp4" : "clip.webm"}`, start_at: 0, device: credential.deviceId });
  await playingPast(page, 1, "direct");
  assert.deepEqual(await mode(page), ["native", "progressive"]);
  assert.match(await page.evaluate(() => globalThis.__yoloPlayer.player.video.currentSrc), /\/m\/[^/]+\/f\/\d+$/);
  await agentSays(agent, "control", { action: "pause" });
  await statusIs(page, "paused", "direct paused");
  await agentSays(agent, "control", { action: "resume" });
  await agentSays(agent, "seek", { position_seconds: 60 });
  await playingPast(page, 60.5, "direct after a seek");

  // hls: a seek inside the stream keeps it.
  await yolo.mcp(agent, "play", { url: `${media.url}/hls/index.m3u8`, start_at: 0, device: credential.deviceId });
  await playingPast(page, 1, "hls");
  assert.deepEqual(await mode(page), ["native", hlsMode]);
  const hlsSession = await page.evaluate(() => globalThis.__yolo.state.sessionId);
  await agentSays(agent, "seek", { position_seconds: 90 });
  await playingPast(page, 90.5, "hls after a seek");
  assert.equal(await page.evaluate(() => globalThis.__yolo.state.sessionId), hlsSession);

  // dash_split: separate files joined into fMP4 HLS with an audio rendition.
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0, device: credential.deviceId });
  await playingPast(page, 4, "dash_split");
  assert.deepEqual(await mode(page), ["native", hlsMode]);
  if (engine !== "webkit") {
    // Fullscreen keeps Yolo's controls.
    await page.locator("#btn-fullscreen").click({ force: true });
    await waitFor(page, () => document.fullscreenElement?.id === "app", null, "the player in fullscreen");
    await page.locator("#btn-fullscreen").click({ force: true });
    await waitFor(page, () => !document.fullscreenElement, null, "fullscreen left");
  }
  await eventually(() => deviceEvents(yolo, "stream_first_frame", credential.deviceId).length >= 3, "first frames in the logs", 25_000);
  assert.ok(deviceEvents(yolo, "stream_selected", credential.deviceId).every((event) => event.includes("engine: 'native'")));

  // Back: home, with the item paused in this browser's bar, also after a
  // reload; the bar plays it again from there, and "Stop playing" clears it.
  const parked = () => waitFor(page, () => location.pathname === "/" && !globalThis.__yoloPlayer
    && document.querySelector("#now-playing .np-device")?.textContent === "Paused on This browser", null, "the bar with this browser's item");
  await page.evaluate(() => document.getElementById("btn-back").click());
  await parked();
  const left = (await yolo.api(credential.token, "/v1/playback")).body;
  assert.deepEqual([left.status, left.deviceId], ["paused", credential.deviceId]);
  await page.reload();
  await parked();
  await page.locator("#np-toggle").click();
  await playingPast(page, left.position + 0.5, "resumed from the bar", 45_000);
  assert.ok(await currentTime(page) < left.position + 10, "not from the start or further on");
  await page.evaluate(() => document.getElementById("btn-back").click());
  await parked();
  await page.locator("#np-devices").click();
  await page.locator("#device-picker").getByRole("button", { name: "Stop playing" }).click();
  await waitFor(page, () => document.getElementById("now-playing").classList.contains("hidden"), null, "the bar gone");
  assert.equal((await yolo.api(credential.token, "/v1/playback")).body.status, "idle");
  assert.deepEqual(errors, []);
}

async function playsPlex(t, engine) {
  const { page, errors, credential } = await webPage(t, engine);
  const plays = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/v1/playback/play")) plays.push(request.postDataJSON());
  });
  const starts = () => plex.calls.filter((call) => call.path.endsWith("/start.m3u8"));
  const startsAtFirst = starts().length;

  // No Yolo history for it: Plex's own position (3 s).
  await yolo.api(credential.token, "/v1/history", { method: "DELETE", body: { sourceKey: "plex:7" } });
  const played = await yolo.api(credential.token, "/v1/playback/play", { method: "POST", body: { itemId: "plex:7", deviceId: credential.deviceId } });
  assert.equal(played.body.state.position, 3, JSON.stringify(played.body));
  await playingPast(page, 3, "plex");

  // A text subtitle drawn by Yolo inside the <video> picture, not the browser's captions.
  await yolo.api(credential.token, "/v1/playback/tracks", { method: "PUT", body: { subtitles: ["plex:21"] } });
  await waitFor(page, () => document.getElementById("subtitle-overlay").textContent.includes("Fixture subtitle"), null, "the subtitle");
  const layout = await page.evaluate(() => {
    const { video } = globalThis.__yoloPlayer.player;
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const left = box.left + (box.width - video.videoWidth * scale) / 2;
    const line = document.querySelector("#subtitle-overlay .subtitle-line").getBoundingClientRect();
    return {
      inside: line.left >= left - 1 && line.right <= left + video.videoWidth * scale + 1,
      captions: Array.from(video.textTracks).filter((track) => track.mode === "showing").length,
    };
  });
  assert.deepEqual(layout, { inside: true, captions: 0 });
  assert.equal(starts().length, startsAtFirst + 1, "no second transcode");

  // An audio switch rebuilds the stream at the place reached. Segments come
  // slowly from here, so the browser still fetches ahead when Plex drops it.
  const audio = played.body.state.tracks?.audio === "plex:12" ? "plex:11" : "plex:12";
  await page.route(/\/m\/[^/]+\/f\//, async (route) => {
    await new Promise((done) => setTimeout(done, 300));
    await route.continue();
  });
  const before = await currentTime(page);
  await yolo.api(credential.token, "/v1/playback/tracks", { method: "PUT", body: { audio } });
  await eventually(() => starts().length === startsAtFirst + 2, "the new transcode");
  assert.equal(starts().at(-1).params.audioStreamID, audio.slice("plex:".length));
  await playingPast(page, before, "playing on with the chosen audio");

  // Plex drops the transcode: the next segment is a 410, and the player asks
  // Yolo for a new stream where playback is, with no error shown.
  const clearedAt = await currentTime(page);
  plex.sessions.clear();
  await eventually(() => plays.find((body) => body.reason === "recovery"), "the recovery", 45_000);
  const recovery = plays.find((body) => body.reason === "recovery");
  assert.ok(recovery.startTime >= clearedAt - 1, JSON.stringify({ clearedAt, plays }));
  await playingPast(page, recovery.startTime + 0.5, "playing again after the 410", 45_000);
  assert.equal(await page.evaluate(() => document.getElementById("playback-error").classList.contains("hidden")), true, "no error shown");
  assert.deepEqual(errors, []);
}

test("direct, hls and dash_split play in the browser's <video> element, and Back leaves the item to resume from the bar", { timeout: 300_000 }, (t) => playsStreamTypes(t, "chromium"));
test("Plex plays in the <video> element: Plex's position, subtitles over the picture, an audio switch, and recovery after a 410", { timeout: 300_000 }, (t) => playsPlex(t, "chromium"));
test("in WebKit (Safari's engine) the stream types play through native HLS", webkitOnly, (t) => playsStreamTypes(t, "webkit"));
test("in WebKit, Plex plays through native HLS with subtitles, an audio switch, and recovery after a 410", webkitOnly, (t) => playsPlex(t, "webkit"));

test("Yolo Web pairs with the owner's passkey at desktop and phone sizes, and a tap on the phone plays on the computer", { timeout: 240_000 }, async (t) => {
  const link = `${media.url}/hls/index.m3u8`;
  const screens = {};
  for (const [label, options] of [
    ["desktop", { viewport: { width: 1440, height: 900 } }],
    ["phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: PHONE_UA }],
  ]) {
    const context = await launchBrowser(t, { context: options });
    // Signed in with a passkey here: one press pairs this browser, no scan.
    await signIn(context);
    const { page, errors } = await openPage(context, yolo.origin);
    await waitFor(page, () => document.getElementById("pair-passkey")?.textContent === "Pair this browser", null, `${label}: pair with the passkey`);
    await page.locator("#pair-passkey").click();
    await waitFor(page, () => Boolean(globalThis.__yolo?.state?.deviceId), null, `${label}: paired`);
    await page.waitForSelector("#home-header");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} fits its width`);
    screens[label] = { page, errors, deviceId: await page.evaluate(() => globalThis.__yolo.state.deviceId) };
  }
  const token = (await screens.desktop.page.evaluate(() => JSON.parse(localStorage.getItem("yolo.device")))).token;
  const kinds = Object.fromEntries((await yolo.api(token, "/v1/devices")).body.devices.map((device) => [device.id, device.kind]));
  assert.deepEqual([kinds[screens.desktop.deviceId], kinds[screens.phone.deviceId]], ["browser", "phone"]);

  // On the computer: paste a link and play it here; a click pauses, Space plays on.
  const { page: desktop } = screens.desktop;
  await desktop.locator("#search-input").fill(link);
  await desktop.getByRole("button", { name: "Play link" }).click();
  await playingPast(desktop, 1, "playing on the computer", 45_000);
  await desktop.mouse.click(720, 300);
  await statusIs(desktop, "paused", "paused by a click");
  await desktop.keyboard.press(" ");
  await playingPast(desktop, await currentTime(desktop) + 0.3, "playing after Space");

  // On the phone, a tap plays where playback is: on the computer.
  const { page: phone } = screens.phone;
  await waitFor(phone, () => !document.getElementById("now-playing").classList.contains("hidden"), null, "the phone's now-playing bar");
  const before = (await yolo.api(token, "/v1/playback")).body.sessionId;
  await phone.locator("#search-input").fill(link);
  await phone.getByRole("button", { name: "Play link" }).tap();
  await eventually(async () => (await yolo.api(token, "/v1/playback")).body.sessionId !== before, "a new play on the computer");
  assert.equal((await yolo.api(token, "/v1/playback")).body.deviceId, screens.desktop.deviceId);
  assert.deepEqual([...screens.desktop.errors, ...screens.phone.errors], []);
});

// Share links (Agent Note 2026-10-20-share-links): a browser that never
// paired plays the link's one item, the owner's playback and history never
// hear of it, and revoking the link stops it.
test("a friend plays a share link without pairing; the owner's playback and history stay as they were, and a revoked link stops", { timeout: 180_000 }, async (t) => {
  const agent = await yolo.agentToken({ name: "Share agent" });
  const keys = async () => (await yolo.mcp(agent, "history")).map((entry) => entry.sourceKey).sort();
  const [historyBefore, { playback: before }] = [await keys(), await yolo.mcp(agent, "get_status")];
  const shared = await yolo.mcp(agent, "share", { url: `${media.url}/hls/index.m3u8` });
  assert.match(shared.url, /\/s\/[A-Za-z0-9_-]{22}$/);

  const context = await launchBrowser(t);
  const { page, errors } = await openPage(context, shared.url);
  await playingPast(page, 1, "the shared video");
  assert.deepEqual(await page.evaluate(() => [location.pathname.startsWith("/s/"), localStorage.getItem("yolo.device"), globalThis.__yolo.realtime.running]), [true, null, false]);
  assert.equal((await yolo.mcp(agent, "get_status")).playback.sessionId ?? null, before.sessionId ?? null);
  assert.deepEqual(await keys(), historyBefore);

  const revoke = await fetch(`${yolo.origin}/v1/owner/shares/${shared.id}/revoke`, {
    method: "POST", headers: { "x-yolo-owner": "1", origin: yolo.origin, cookie: yolo.ownerSession.cookie },
  });
  assert.equal(revoke.status, 200);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("This video is no longer shared").waitFor();
  assert.deepEqual(errors, []);
});

test("owner settings need the owner's passkey session; a device credential never reaches them", { timeout: 180_000 }, async (t) => {
  const context = await launchBrowser(t);
  const { page, errors } = await openPage(context, yolo.origin);
  const credential = await pair(yolo, page);
  const owner = (headers = {}) => ({ "x-yolo-owner": "1", origin: yolo.origin, ...headers });

  // A device credential never reaches them, nor the session from another site or without X-Yolo-Owner.
  for (const [method, path] of [["GET", "/v1/owner/devices"], ["GET", "/v1/owner/agents"], ["DELETE", `/v1/owner/devices/${credential.deviceId}`]]) {
    assert.equal((await fetch(`${yolo.origin}${path}`, { method, headers: owner({ authorization: `Bearer ${credential.token}` }) })).status, 401, `${method} ${path}`);
  }
  const crossSite = await fetch(`${yolo.origin}/v1/owner/devices/${credential.deviceId}`, {
    method: "PATCH", headers: owner({ cookie: yolo.ownerSession.cookie, origin: "https://evil.test", "content-type": "application/json" }), body: JSON.stringify({ name: "Hacked" }),
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await fetch(`${yolo.origin}/v1/owner/devices`, { headers: { cookie: yolo.ownerSession.cookie } })).status, 403, "no X-Yolo-Owner");

  // Settings are locked until the owner signs in.
  await page.locator("#btn-settings").click();
  await page.waitForSelector("#settings[open] .locked");
  await page.locator("#settings-close").click();
  await page.waitForFunction(() => !document.getElementById("settings").open);

  await signIn(context);
  const agent = await yolo.agentToken({ name: "Settings agent" });
  assert.equal((await yolo.api(agent, "/v1/me")).status, 200);
  await page.locator("#btn-settings").click();
  const self = page.locator(`#settings [data-device="${credential.deviceId}"]`);
  await self.waitFor();

  // Rename this browser in place.
  await self.getByRole("button", { name: /^Rename/ }).click();
  await page.locator('#settings .row-edit input[name="name"]').fill("Desk");
  await page.locator('#settings .row-edit button[type="submit"]').click();
  await self.filter({ hasText: "Desk" }).waitFor();
  // Revoke the agent: it asks once more, then the agent's token stops working.
  const agentRow = page.locator("#settings [data-agent]").filter({ hasText: "Settings agent" });
  await agentRow.getByRole("button", { name: "Revoke Settings agent" }).click();
  await agentRow.getByRole("button", { name: "Revoke?" }).click();
  await eventually(async () => (await yolo.api(agent, "/v1/me")).status === 401, "the agent's token to be revoked");
  // The only passkey cannot be removed.
  const passkeys = page.locator('#settings ul[aria-label="Passkeys"]');
  assert.match(await passkeys.innerText(), /E2E passkey[\s\S]*Your only passkey/);
  assert.equal(await passkeys.getByRole("button", { name: /^Remove/ }).count(), 0);

  // Signing out ends the session.
  await page.locator("#settings").getByRole("button", { name: "Sign out" }).click();
  await page.waitForSelector("#settings[open] .locked");
  assert.equal((await fetch(`${yolo.origin}/v1/owner/devices`, { headers: owner({ cookie: yolo.ownerSession.cookie }) })).status, 401);
  assert.deepEqual(errors, []);
});
