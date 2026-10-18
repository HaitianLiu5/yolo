import assert from "node:assert/strict";
import { test } from "node:test";
import { createYtdlpSource, SOURCE_ID } from "../src/node.js";
import { subtitleEntries } from "../src/subtitles.js";
import { createYtdlp } from "../src/ytdlp.js";
import { vimeoPlayerUrl } from "../src/vimeo.js";

// Anonymous yt-dlp reads a Vimeo page only through the embed player: its web
// client answers "only works when logged-in" for vimeo.com/<id>.
const LOGIN_REQUIRED = "ERROR: [vimeo] 76979871: The web client only works when logged-in. Use --cookies, --cookies-from-browser, --username and --password, --netrc-cmd, or --netrc (vimeo) to provide account credentials.";
const MASTER = "https://skyfire.vimeocdn.com/1/2/v2/playlist/av/primary/playlist.m3u8?sf=fmp4";
const PLAYER_INFO = {
  title: "Player",
  duration: 62,
  webpage_url: "https://player.vimeo.com/video/76979871",
  requested_formats: [
    { format_id: "hls-fastly_skyfire-2644", protocol: "m3u8_native", url: "https://skyfire.vimeocdn.com/v.m3u8", manifest_url: MASTER, vcodec: "avc1.64001F", acodec: "none", height: 720, fps: 23.976, tbr: 2644 },
    { format_id: "hls-fastly_skyfire-audio-high-English", protocol: "m3u8_native", url: "https://skyfire.vimeocdn.com/a.m3u8", manifest_url: MASTER, vcodec: "none" },
  ],
};

// A yt-dlp stand-in that answers by the URL it is given: Vimeo pages need a
// login, the player answers, and anything else fails as `otherError`.
function vimeoExec(calls, { pages = LOGIN_REQUIRED, otherError = "ERROR: Unsupported URL" } = {}) {
  return (binary, args, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    const url = args.at(-1);
    calls.push(url);
    if (/^https:\/\/player\.vimeo\.com\//.test(url)) return done(null, JSON.stringify(PLAYER_INFO), "");
    if (/^https:\/\/(www\.)?vimeo\.com\//.test(url)) {
      return pages instanceof Object ? done(null, JSON.stringify(pages), "") : done(new Error("exit 1"), "", pages);
    }
    return done(new Error("exit 1"), "", otherError);
  };
}

test("a Vimeo page maps to its embed player, with an unlisted video's hash", () => {
  assert.equal(vimeoPlayerUrl("https://vimeo.com/76979871"), "https://player.vimeo.com/video/76979871");
  assert.equal(vimeoPlayerUrl("https://www.vimeo.com/76979871?share=copy#t=10"), "https://player.vimeo.com/video/76979871");
  assert.equal(vimeoPlayerUrl("https://vimeo.com/392479337/a52724358e"), "https://player.vimeo.com/video/392479337?h=a52724358e");
  assert.equal(vimeoPlayerUrl("https://vimeo.com/581039021/9603038895"), "https://player.vimeo.com/video/581039021?h=9603038895");
  assert.equal(vimeoPlayerUrl("https://vimeo.com/392479337?h=a52724358e"), "https://player.vimeo.com/video/392479337?h=a52724358e");
  assert.equal(vimeoPlayerUrl("https://vimeo.com/channels/tributes/6612336"), "https://player.vimeo.com/video/6612336");
  assert.equal(vimeoPlayerUrl("https://vimeo.com/showcase/2632481/video/79761619"), "https://player.vimeo.com/video/79761619");
  assert.equal(vimeoPlayerUrl("https://vimeo.com/groups/shortfilms/videos/22439234"), "https://player.vimeo.com/video/22439234");
  // Collections, people, the player itself, and other sites are not a page of one video.
  for (const url of ["https://vimeo.com/showcase/2632481", "https://vimeo.com/album/2632481", "https://vimeo.com/channels/staffpicks",
    "https://vimeo.com/user7108434", "https://player.vimeo.com/video/76979871", "https://example.com/76979871", "not a url"]) {
    assert.equal(vimeoPlayerUrl(url), null, url);
  }
});

test("a Vimeo page that needs a login resolves through the embed player, once per URL", async () => {
  const calls = [];
  const ytdlp = createYtdlp({ exec: vimeoExec(calls) });
  const page = "https://vimeo.com/392479337/a52724358e";
  const info = await ytdlp.info(page);
  assert.equal(info.title, "Player");
  assert.equal(info.webpage_url, page, "the page stays the video's address");
  assert.deepEqual(calls, [page, "https://player.vimeo.com/video/392479337?h=a52724358e"]);
  // The page is not asked again while the answer is fresh.
  await ytdlp.playable(page, { selector: "bv+ba" });
  assert.deepEqual(calls.slice(2), ["https://player.vimeo.com/video/392479337?h=a52724358e"]);

  // Other failures are not retried, on Vimeo or elsewhere.
  const others = [];
  const failing = createYtdlp({ exec: vimeoExec(others, { pages: "ERROR: [vimeo] 1: Unable to download webpage: HTTP Error 404" }) });
  await assert.rejects(failing.info("https://vimeo.com/1"), { code: "resolve_failed", message: /404/ });
  await assert.rejects(failing.info("https://example.com/v"), { message: "ERROR: Unsupported URL" });
  assert.deepEqual(others, ["https://vimeo.com/1", "https://example.com/v"]);
});

test("a player that refuses too keeps the page's login error", async () => {
  const calls = [];
  const exec = (binary, args, options, callback) => {
    calls.push(args.at(-1));
    callback(new Error("exit 1"), "", /player/.test(args.at(-1)) ? "ERROR: [vimeo] 1: HTTP Error 401: Unauthorized" : LOGIN_REQUIRED);
  };
  await assert.rejects(createYtdlp({ exec }).info("https://vimeo.com/1"), { message: /only works when logged-in/ });
  assert.equal(calls.length, 2);
});

test("signed in, a Vimeo page plays as itself", async () => {
  const calls = [];
  const ytdlp = createYtdlp({ cookies: ["--cookies", "/vimeo.txt"], exec: vimeoExec(calls, { pages: { title: "Signed in", webpage_url: "https://vimeo.com/76979871" } }) });
  assert.equal((await ytdlp.info("https://vimeo.com/76979871")).title, "Signed in");
  assert.deepEqual(calls, ["https://vimeo.com/76979871"]);
});

test("a Vimeo item keeps its page as identity and plays the player's HLS master", async () => {
  const calls = [];
  const source = createYtdlpSource(createYtdlp({ exec: vimeoExec(calls) }));
  const page = "https://vimeo.com/76979871";
  const item = { plugin: SOURCE_ID, ...source.claim(page) };
  assert.deepEqual(item, { plugin: SOURCE_ID, id: "https://vimeo.com/76979871", url: page });
  const stream = await source.prepare(item, {
    capabilities: { video: ["avc1"], audio: ["mp4a"], maxHeight: 720 }, startTime: 30, limits: { maxVideoKbps: 4800 }, chooseTracks: () => ({ subtitles: [], audio: null }),
  });
  assert.deepEqual([stream.input.type, stream.input.url, stream.startTime], ["hls", MASTER, 30]);
  assert.equal((await source.details(item)).url, page);
  // A pasted player URL needs no detour.
  calls.length = 0;
  await source.describe({ plugin: SOURCE_ID, ...source.claim("https://player.vimeo.com/video/76979871") });
  assert.deepEqual(calls, ["https://player.vimeo.com/video/76979871"]);
});

test("Vimeo subtitles come as one WebVTT file, named in their own language, and auto-generated ones say so", () => {
  const sub = (id) => [
    { url: `https://vod-adaptive-ak.vimeocdn.com/x/sub/${id}/media.m3u8`, ext: "vtt", protocol: "m3u8_native" },
    { ext: "vtt", manifest_url: "https://skyfire.vimeocdn.com/x/playlist.mpd", url: `https://skyfire.vimeocdn.com/x/sub/${id}.mp4` },
    { ext: "vtt", url: `https://captions.vimeo.com/captions/${id}.vtt?expires=1` },
  ];
  const entries = subtitleEntries({ subtitles: { en: sub(140662), "en-x-autogen": sub(325643016) } });
  assert.deepEqual(entries.map((entry) => [entry.key, entry.lang, entry.name, entry.auto, entry.url]), [
    ["en", "en", "English", false, "https://captions.vimeo.com/captions/140662.vtt?expires=1"],
    ["en-x-autogen", "en", "English", true, "https://captions.vimeo.com/captions/325643016.vtt?expires=1"],
  ]);
});

test("Bilibili's AI subtitles are named in their own language, with no \"(auto)\" in the name", () => {
  const vtt = (lang) => [{ ext: "vtt", url: `https://subs.test/${lang}.vtt` }];
  const entries = subtitleEntries({ subtitles: { "ai-zh": vtt("zh"), "ai-ja": vtt("ja"), "ai-ar": vtt("ar") } });
  assert.deepEqual(entries.map((entry) => [entry.lang, entry.name, entry.auto]), [
    ["zh", "中文", true],
    ["ja", "日本語", true],
    ["ar", "العربية", true],
  ]);
});
