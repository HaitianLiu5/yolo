import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { serveClient } from "./fixtures.js";
import { ensureClientBuilt } from "./yolo-stack.js";

// The Tesla client's page on its own (no control plane): caption layout and
// fonts at Tesla window sizes, and subtitle choices that wait for Yolo.

const dist = resolve(fileURLToPath(new URL("../../clients/tesla/dist", import.meta.url)));
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(macChrome) ? macChrome : undefined);

async function clientPage(t, viewport) {
  await ensureClientBuilt();
  const baseUrl = await serveClient(t, dist);
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.goto(baseUrl);
  await page.waitForFunction(() => Boolean(globalThis.__yolo?.subtitles));
  return { page, baseUrl };
}

test("subtitle languages stack upward as compact background groups", async (t) => {
  const { page } = await clientPage(t, { width: 1280, height: 720 });

  const layout = await page.evaluate(async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const captions = new Map([
      ["/test/en.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nFirst line\nSecond line\n"],
      ["/test/zh.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n中文翻译\n"],
    ]);
    globalThis.fetch = (input, init) => {
      const requestUrl = typeof input === "string"
        ? input
        : input instanceof URL ? input.href : input.url;
      const url = new URL(requestUrl, location.origin);
      if (captions.has(url.pathname)) {
        return Promise.resolve(new Response(captions.get(url.pathname), {
          status: 200,
          headers: { "Content-Type": "text/vtt" },
        }));
      }
      return realFetch(input, init);
    };

    const subtitles = globalThis.__yolo.subtitles;
    await subtitles.loadSubtitleTrack("en", "/test/en.vtt");
    await subtitles.loadSubtitleTrack("zh-Hans", "/test/zh.vtt");
    subtitles.renderSubtitle(1);

    const app = document.getElementById("app");
    const overlay = document.getElementById("subtitle-overlay");
    const tracks = [...overlay.querySelectorAll(":scope > .subtitle-track")];
    const englishLines = [...tracks[0].querySelectorAll(".subtitle-line")];
    const appBox = app.getBoundingClientRect();
    const overlayBox = overlay.getBoundingClientRect();
    const englishBox = tracks[0].getBoundingClientRect();
    const chineseBox = tracks[1].getBoundingClientRect();
    const firstLineBox = englishLines[0].getBoundingClientRect();
    const secondLineBox = englishLines[1].getBoundingClientRect();
    const overlayStyle = getComputedStyle(overlay);
    const trackStyle = getComputedStyle(tracks[0]);
    const chineseTrackStyle = getComputedStyle(tracks[1]);
    const lineStyle = getComputedStyle(englishLines[0]);
    const languageFontFamily = (lang) => {
      const track = document.createElement("div");
      track.className = "subtitle-track";
      track.lang = lang;
      track.style.position = "fixed";
      track.style.visibility = "hidden";
      document.body.append(track);
      const family = getComputedStyle(track).fontFamily;
      track.remove();
      return family;
    };

    return {
      groupCount: tracks.length,
      groups: tracks.map((track) => ({
        lang: track.lang,
        lines: [...track.querySelectorAll(".subtitle-line")].map((line) => line.textContent),
      })),
      overlay: {
        display: overlayStyle.display,
        direction: overlayStyle.flexDirection,
        gap: overlayStyle.gap,
        bottomInset: appBox.bottom - overlayBox.bottom,
      },
      firstLanguageIsLower: englishBox.bottom > chineseBox.bottom,
      sameLanguageLineGap: secondLineBox.top - firstLineBox.bottom,
      trackBackground: trackStyle.backgroundColor,
      lineBackground: lineStyle.backgroundColor,
      englishFontFamily: trackStyle.fontFamily,
      chineseFontFamily: chineseTrackStyle.fontFamily,
      japaneseFontFamily: languageFontFamily("ja"),
      koreanFontFamily: languageFontFamily("ko"),
    };
  });

  assert.deepEqual(layout.groups, [
    { lang: "en", lines: ["First line", "Second line"] },
    { lang: "zh-Hans", lines: ["中文翻译"] },
  ]);
  assert.equal(layout.groupCount, 2);
  assert.equal(layout.overlay.display, "flex");
  assert.equal(layout.overlay.direction, "column-reverse");
  assert.equal(layout.overlay.gap, "4px");
  assert.ok(layout.overlay.bottomInset >= 24 && layout.overlay.bottomInset <= 96);
  assert.equal(layout.firstLanguageIsLower, true);
  assert.ok(Math.abs(layout.sameLanguageLineGap) < 0.5);
  assert.equal(layout.trackBackground, "rgba(0, 0, 0, 0.65)");
  assert.equal(layout.lineBackground, "rgba(0, 0, 0, 0)");
  assert.match(layout.englishFontFamily, /^"Noto Sans"/);
  assert.match(layout.chineseFontFamily, /^"Noto Sans SC"/);
  assert.match(layout.japaneseFontFamily, /^"Noto Sans JP"/);
  assert.match(layout.koreanFontFamily, /^"Noto Sans KR"/);
});

test("Plex bilingual captions use local Chinese glyphs and stay inside the movie at Tesla window sizes", async (t) => {
  const { page } = await clientPage(t, { width: 773, height: 601 });
  await page.evaluate(async () => {
    document.getElementById("overlay").classList.add("hidden");
    document.getElementById("browse-screen").classList.add("hidden");
    const canvas = document.createElement("canvas");
    canvas.dataset.engine = "mediabunny";
    canvas.width = 1280; canvas.height = 536;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#a0a7ab"; ctx.fillRect(0, 0, 1280, 536);
    document.getElementById("player-container").append(canvas);
    const text = "WEBVTT\n\n01:44:33.300 --> 01:44:37.410\n- He added an air-duct system... that can cut through the maze. - Good. Explain it to them.\n- 他加了一条穿过迷宫的通风管 - 好 快告诉他们\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
    const subs = globalThis.__yolo.subtitles;
    await subs.loadSubtitleTrack("plex:80803", url);
    subs.renderSubtitle(6274);
    await document.fonts.ready;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '.subtitle-line[lang="zh-Hans"]' });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  // Some Noto subset binaries retain a "Thin" family suffix internally even
  // though the served @font-face is the static 400 face.
  assert.ok(fonts.some((font) => font.isCustomFont && font.familyName.startsWith("Noto Sans SC") && font.glyphCount > 0), JSON.stringify(fonts));
  for (const viewport of [{ width: 773, height: 601 }, { width: 1280, height: 720 }, { width: 640, height: 360 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction((width) => Math.abs(parseFloat(document.getElementById("subtitle-overlay").style.getPropertyValue("--subtitle-picture-width")) - width) < 1, viewport.width);
    const result = await page.evaluate(() => {
      const overlay = document.getElementById("subtitle-overlay");
      const box = overlay.getBoundingClientRect();
      const pictureBottom = (innerHeight + innerWidth * 536 / 1280) / 2;
      const lines = [...overlay.querySelectorAll(".subtitle-line")];
      return { gap: pictureBottom - box.bottom, fontSize: parseFloat(getComputedStyle(lines[1]).fontSize),
        languages: lines.map((line) => line.lang), font: getComputedStyle(lines[1]).fontFamily,
        width: box.width, height: box.height, overflow: lines.some((line) => line.scrollWidth > line.clientWidth),
        localChineseFont: performance.getEntriesByType("resource").some((entry) => entry.name.includes("/lib/fonts/noto-sans-sc/files/") && entry.responseEnd > 0),
      };
    });
    assert.deepEqual(result.languages, ["en", "zh-Hans"]);
    assert.match(result.font, /^"Noto Sans SC"/);
    assert.ok(result.localChineseFont);
    assert.ok(result.fontSize >= 16 && result.fontSize <= 24);
    if (viewport.width === 773) assert.ok(result.fontSize < 19);
    assert.ok(result.gap >= 9 && result.gap <= 25, JSON.stringify(result));
    assert.equal(result.overflow, false);
    assert.ok(result.height < viewport.height / 2);
  }
});

test("a subtitle choice changes only when Yolo confirms it", async (t) => {
  const { page } = await clientPage(t, { width: 773, height: 601 });
  let reject = true;
  const requests = [];
  await page.route("**/v1/playback/tracks", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: reject ? 500 : 200, contentType: "application/json",
      body: JSON.stringify(reject ? { error: { code: "internal", message: "Cannot save" } } : { state: {} }) });
  });
  await page.evaluate(() => {
    const { state } = globalThis.__yolo;
    state.tracks = { subtitles: [{ id: "plex:8", name: "中文", language: "zho", delivery: "vtt", url: "/m/t/sub/0.vtt" }], audio: [], selected: { subtitles: [], audio: null } };
    globalThis.__yolo.updateSubsUI();
    document.querySelectorAll("#subs-list button")[1].click();
  });
  await page.waitForFunction(() => document.getElementById("status-text").textContent.includes("Could not change subtitles"));
  assert.deepEqual(await page.evaluate(() => globalThis.__yolo.state.tracks.selected.subtitles), []);
  reject = false;
  await page.evaluate(() => document.querySelectorAll("#subs-list button")[1].click());
  await page.waitForFunction(() => document.getElementById("status-text").textContent !== "" );
  assert.deepEqual(requests.at(-1), { subtitles: ["plex:8"] });
  assert.deepEqual(await page.evaluate(() => globalThis.__yolo.state.tracks.selected.subtitles), [], "still unchanged until Yolo sends tracks");
  // Yolo's `tracks` message is what applies it.
  await page.evaluate(() => globalThis.__yolo.applyTracks(null, { subtitles: ["plex:8"], audio: null }));
  assert.deepEqual(await page.evaluate(() => globalThis.__yolo.state.tracks.selected.subtitles), ["plex:8"]);
  assert.equal(await page.evaluate(() => document.querySelectorAll("#subs-list button.active")[0].textContent), "中文");
});

test("late subtitles stay disabled and cannot overwrite a newer language selection", async (t) => {
  const { page } = await clientPage(t, { width: 1280, height: 720 });
  // Ignore AbortSignal in the fixture fetch so the generation check is tested
  // independently of successful transport cancellation.
  const result = await page.evaluate(async () => {
    const subtitles = globalThis.__yolo.subtitles;
    const originalFetch = globalThis.fetch;
    const responses = [];
    globalThis.fetch = (input, init) => String(input).includes("fixture-sub")
      ? new Promise((done) => responses.push(done)) : originalFetch(input, init);
    const response = (text) => new Response(`WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n${text}\n`);
    try {
      const old = subtitles.loadSubtitleTrack("en", "/fixture-sub-old.vtt");
      subtitles.disableExternalSubtitle();
      responses.shift()(response("STALE"));
      await old;
      subtitles.renderSubtitle(1);
      const disabledText = document.getElementById("subtitle-overlay").textContent;
      const first = subtitles.loadSubtitleTrack("en", "/fixture-sub-first.vtt");
      const second = subtitles.loadSubtitleTrack("en", "/fixture-sub-second.vtt");
      responses[1](response("CURRENT"));
      await second;
      responses[0](response("OLD"));
      await first;
      subtitles.renderSubtitle(1);
      return { disabledText, selectedText: document.getElementById("subtitle-overlay").textContent };
    } finally { globalThis.fetch = originalFetch; }
  });
  assert.deepEqual(result, { disabledText: "", selectedText: "CURRENT" });
});
