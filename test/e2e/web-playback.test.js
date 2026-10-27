import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { deviceEvents, eventually, holdHub, launchBrowser, openPage, pair, playingPast, statusIs, waitFor } from "./browser.js";
import { startMediaStack } from "./fixtures.js";
import { fileContext } from "./yolo-stack.js";

// The web profile on one stack (Agent Note 2026-10-12-two-playback-engines):
// the four stream types through the browser's <video> element, pairing with
// the owner's passkey, and owner settings behind it, last, since signing out
// ends the session. The passkey is real: the owner creates it on /login with
// the code the node prints, as on a new instance, in Playwright's virtual
// authenticator, and each browser that signs in carries it.
// YOLO_E2E_WEBKIT=1 also runs the stream types and Plex in Playwright's WebKit.

const SECONDS = 120;
const PHONE_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36";
const webkitOnly = { timeout: 300_000, skip: process.env.YOLO_E2E_WEBKIT !== "1" && "set YOLO_E2E_WEBKIT=1" };
// The Plex fixture's subtitle: a bilingual cue whose Chinese the source broke in two.
const SUBTITLE = "1\n00:00:00,000 --> 00:02:00,000\nDuring the presentation, we may discuss certain non-GAAP financial measures.\n在本次发布会中\n我们可能会讨论某些非 GAAP 财务指标\n";

const shared = fileContext();
let media;
let plex;
let yolo;
// The owner's passkey as the virtual authenticator exported it.
let passkey;

before(async () => {
  ({ media, plex, yolo } = await startMediaStack(shared, { seconds: SECONDS, plex: { commentary: true, subtitle: SUBTITLE } }));
  passkey = await setUpOwner();
}, { timeout: 120_000 });

// A new instance's first sign-in: /login takes the node's owner code and
// creates the passkey. A code registration revokes every session, the stack's
// own included, so the stack goes on with the one this sign-in made.
async function setUpOwner() {
  const context = await launchBrowser(shared);
  await context.credentials.install();
  const { page, errors } = await openPage(context, `${yolo.origin}/login`);
  await page.locator("#code").fill(await yolo.ownerCode());
  await page.locator("#register").click();
  await page.waitForURL((url) => url.pathname !== "/login");
  const session = (await context.cookies()).find((cookie) => cookie.name === yolo.ownerSession.name);
  assert.ok(session, "signed in by the new passkey");
  yolo.useOwnerSession(session.value);
  const created = await context.credentials.get();
  assert.equal(created.length, 1);
  assert.deepEqual(errors, []);
  return created[0];
}

// The owner's passkey in this browser, before it opens Yolo. Each sign-in
// raises the passkey's signature counter, which Yolo checks, so the next
// browser carries the count this one reached (kept()).
async function carryPasskey(context) {
  const { rpId, id, userHandle, privateKey, publicKey, signCount } = passkey;
  await context.credentials.install();
  await context.credentials.create(rpId, { id, userHandle, privateKey, publicKey, signCount });
  return async function kept() {
    [passkey] = await context.credentials.get({ id });
  };
}

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

  // The speed panel's preset: the element plays at the speed with the
  // voice's pitch, and the button shows it; the next item keeps it.
  const speed = () => page.evaluate(() => {
    const { video } = globalThis.__yoloPlayer.player;
    return [video.playbackRate, video.preservesPitch ?? video.webkitPreservesPitch, document.querySelector("#btn-speed .speed-value").textContent];
  });
  await page.locator("#btn-speed").click({ force: true });
  await page.locator("#speed-presets").getByRole("button", { name: "1.5×", exact: true }).click({ force: true });
  assert.deepEqual(await speed(), [1.5, true, "1.5×"]);

  // dash_split: separate files joined into fMP4 HLS with an audio rendition.
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0, device: credential.deviceId });
  await playingPast(page, 4, "dash_split");
  assert.deepEqual(await mode(page), ["native", hlsMode]);
  assert.deepEqual(await speed(), [1.5, true, "1.5×"], "the owner's speed on the next item");
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
  // The reload starts on what the page kept (Agent Note 2026-10-11-yolo-web-client):
  // the bar and Continue Watching before Yolo's welcome and its history, and
  // no "Connecting…"; then Yolo's own, without the history item removed meanwhile.
  const hub = await holdHub(page);
  let releaseHistory;
  const historyHeld = new Promise((done) => { releaseHistory = done; });
  await page.route(/\/v1\/history\?/, async (route) => {
    await historyHeld;
    await route.continue();
  });
  await page.reload();
  await waitFor(page, () => document.querySelector("#now-playing .np-device")?.textContent === "Paused on This browser"
    && document.querySelectorAll("#history-list .browse-card").length > 1 && !globalThis.__yolo.realtime.ready
    && document.getElementById("status-text").textContent === "", null, "the kept home screen before the welcome");
  const kept = await page.locator("#history-list .browse-card").count();
  const oldest = (await yolo.api(credential.token, "/v1/history")).body.at(-1);
  await yolo.api(credential.token, "/v1/history", { method: "DELETE", body: { sourceKey: oldest.sourceKey } });
  hub.release();
  releaseHistory();
  await parked();
  await waitFor(page, (count) => document.querySelectorAll("#history-list .browse-card").length === count - 1, kept, "Yolo's history in place of the kept one");
  await page.unroute(/\/v1\/history\?/);
  // A kept record this release cannot draw goes: the page starts as with
  // nothing kept, and connects. Engine-independent, so Chromium only:
  // WebKit reports the welcome's own requests a reload cuts short as errors.
  if (engine !== "webkit") {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("e2e.unreadable")) return;
      sessionStorage.removeItem("e2e.unreadable");
      const { deviceId } = JSON.parse(localStorage.getItem("yolo.device"));
      localStorage.setItem(`yolo.home.${deviceId}`, JSON.stringify({ v: 1, rows: { history: [null] }, hub: null, devices: null }));
    });
    await page.evaluate(() => sessionStorage.setItem("e2e.unreadable", "1"));
    await page.reload();
    await parked();
    assert.equal(await page.evaluate(() => globalThis.__yolo.realtime.ready), true);
  }
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

  // A text subtitle drawn by Yolo inside the <video> picture, not the
  // browser's captions: one line per language, each on one row (the English
  // one shrunk to fit), with a background that follows its text.
  await yolo.api(credential.token, "/v1/playback/tracks", { method: "PUT", body: { subtitles: ["plex:21"] } });
  await waitFor(page, () => {
    const texts = Array.from(document.querySelectorAll("#subtitle-overlay .subtitle-text"));
    return texts.length === 2 && texts.every((text) => text.getClientRects().length === 1);
  }, null, "the subtitle, one row for each language");
  const layout = await page.evaluate(() => {
    const { video } = globalThis.__yoloPlayer.player;
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const left = box.left + (box.width - video.videoWidth * scale) / 2;
    const texts = Array.from(document.querySelectorAll("#subtitle-overlay .subtitle-text"), (text) => text.getBoundingClientRect());
    return {
      lines: Array.from(document.querySelectorAll("#subtitle-overlay .subtitle-text"), (text) => text.textContent),
      inside: texts.every((text) => text.left >= left - 1 && text.right <= left + video.videoWidth * scale + 1),
      hugs: texts[1].width < texts[0].width * 0.8,
      captions: Array.from(video.textTracks).filter((track) => track.mode === "showing").length,
    };
  });
  assert.deepEqual(layout, {
    lines: ["During the presentation, we may discuss certain non-GAAP financial measures.", "在本次发布会中我们可能会讨论某些非 GAAP 财务指标"],
    inside: true, hugs: true, captions: 0,
  });
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
    // The owner's passkey on this browser: one press signs in and pairs it, no scan.
    const kept = await carryPasskey(context);
    const { page, errors } = await openPage(context, yolo.origin);
    await waitFor(page, () => document.getElementById("pair-passkey")?.textContent === "Sign in with passkey", null, `${label}: pair with the passkey`);
    await page.locator("#pair-passkey").click();
    await waitFor(page, () => Boolean(globalThis.__yolo?.state?.deviceId), null, `${label}: paired`);
    await kept();
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
  // Shift+. plays faster, as on YouTube; a press and hold plays at 2× and
  // lets go back to the speed.
  const rate = () => desktop.evaluate(() => globalThis.__yoloPlayer.player.video.playbackRate);
  await desktop.keyboard.press(">");
  assert.equal(await rate(), 1.25);
  await desktop.mouse.move(720, 300);
  await desktop.mouse.down();
  await waitFor(desktop, () => globalThis.__yoloPlayer.player.video.playbackRate === 2, null, "2× while held");
  await desktop.mouse.up();
  assert.equal(await rate(), 1.25);
  // The speed panel opens above its button; its slider goes to 5×, where a
  // hold changes nothing and its release does not pause.
  await desktop.mouse.move(700, 320);
  await desktop.locator("#btn-speed").click();
  const placed = await desktop.evaluate(() => {
    const [panel, button] = ["speed-panel", "btn-speed"].map((id) => document.getElementById(id).getBoundingClientRect());
    return [Math.abs((panel.left + panel.right) / 2 - (button.left + button.right) / 2) < 1, panel.bottom <= button.top];
  });
  assert.deepEqual(placed, [true, true], "centred above the speed button");
  await desktop.locator("#speed-slider").press("End");
  assert.deepEqual([await rate(), await desktop.locator("#btn-speed .speed-value").textContent()], [5, "5×"]);
  await desktop.mouse.click(720, 300);
  await desktop.mouse.move(720, 300);
  await desktop.mouse.down();
  await new Promise((done) => setTimeout(done, 800));
  await desktop.mouse.up();
  await new Promise((done) => setTimeout(done, 400));
  assert.deepEqual([await rate(), await desktop.evaluate(() => globalThis.__yoloPlayer.player.getStatus())], [5, "playing"], "a hold at 5× changes nothing");
  await desktop.keyboard.press("<");
  assert.equal(await rate(), 4.75);

  // With a mouse, as on YouTube's desktop player: no centre row, and
  // previous beside play. After another item, it plays the link again on
  // this computer, and next, beside it now, goes forward to that item.
  const item = () => desktop.evaluate(() => {
    const { source } = globalThis.__yolo.state;
    return source && globalThis.__yoloPlayer?.player?.getStatus() === "playing" ? `${source.plugin}:${source.id}` : null;
  });
  const linkItem = await item();
  await yolo.mcp(await yolo.agentToken(), "play", { url: `${media.url}/clip.webm`, start_at: 0, device: screens.desktop.deviceId });
  await eventually(async () => ![null, linkItem].includes(await item()), "another item on the computer", 45_000);
  const other = await item();
  const shown = (id) => desktop.evaluate((id) => getComputedStyle(document.getElementById(id)).display !== "none", id);
  await waitFor(desktop, () => getComputedStyle(document.getElementById("btn-bar-previous")).display !== "none", null, "previous beside play");
  assert.deepEqual([await shown("controls-center"), await shown("btn-bar-next")], [false, false]);
  await desktop.mouse.move(700, 300);
  await desktop.locator("#btn-bar-previous").click();
  await eventually(async () => (await item()) === linkItem, "previous plays the link again here", 45_000);
  await waitFor(desktop, () => getComputedStyle(document.getElementById("btn-bar-next")).display !== "none", null, "next, back where previous came from");
  await desktop.mouse.move(720, 300);
  await desktop.locator("#btn-bar-next").click();
  await eventually(async () => (await item()) === other, "next goes forward to the other item", 45_000);
  assert.equal(await rate(), 4.75, "the speed holds from item to item");
  await desktop.mouse.move(700, 300);
  await desktop.locator("#btn-speed").click();
  await desktop.locator("#speed-presets").getByRole("button", { name: "1×", exact: true }).click();
  assert.equal(await rate(), 1);

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
  const kept = await carryPasskey(context);
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

  // Settings are locked until the owner signs in with the passkey.
  await page.locator("#btn-settings").click();
  await page.waitForSelector("#settings[open] .locked");
  await page.locator("#settings-sign-in").click();
  await page.waitForSelector(`#settings[open] [data-device="${credential.deviceId}"]`);
  await kept();
  await page.locator("#settings-close").click();
  await page.waitForFunction(() => !document.getElementById("settings").open);

  // An agent that names the MCP URL as its resource, beside the origin, as
  // Codex does, gets Yolo's one token for /mcp and /v1.
  const agent = await yolo.agentToken({ name: "Settings agent", resources: [`${yolo.origin}/mcp`, yolo.origin] });
  assert.equal((await yolo.api(agent, "/v1/me")).status, 200);
  assert.ok(Array.isArray((await yolo.mcp(agent, "list_devices")).devices));
  await page.locator("#btn-settings").click();
  const self = page.locator(`#settings [data-device="${credential.deviceId}"]`);
  await self.waitFor();

  // Rename this browser in place.
  await self.getByRole("button", { name: /^Edit/ }).click();
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
  assert.match(await passkeys.innerText(), /added today[\s\S]*Your only passkey/);
  assert.equal(await passkeys.getByRole("button", { name: /^Remove/ }).count(), 0);

  // Signing out ends the session this browser's passkey sign-in made.
  const session = (await context.cookies()).find((cookie) => cookie.name === yolo.ownerSession.name);
  const devices = () => fetch(`${yolo.origin}/v1/owner/devices`, { headers: owner({ cookie: `${session.name}=${session.value}` }) });
  assert.equal((await devices()).status, 200);
  await page.locator("#settings").getByRole("button", { name: "Sign out" }).click();
  await page.waitForSelector("#settings[open] .locked");
  assert.equal((await devices()).status, 401);
  assert.deepEqual(errors, []);
});
