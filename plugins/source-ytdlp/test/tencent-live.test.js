import assert from "node:assert/strict";
import { test } from "node:test";
import { createYtdlpSource, SOURCE_ID } from "../src/node.js";
import { cKey, definitionFor } from "../src/tencent-live.js";
import { createYtdlp } from "../src/ytdlp.js";

// A Tencent Sports game being played plays its live channel from Tencent's
// live play-info API (tencent-live.js), with the owner's session for a paid
// game, and runs no yt-dlp.

const GAME = "https://sports.qq.com/kbsweb/game.htm?mid=100000:10022600024";
const SESSION = { vuserid: "123456789", vusession: "session-a", cookie: "main_login=wx; vuserid=123456789; vusession=session-a" };

function tencent({ period = "1", playurl = "http://live.test/1782040502.m3u8", iretcode = 0, replays = [] } = {}) {
  const asked = [];
  const fetchImpl = async (url, options = {}) => {
    asked.push({ url: new URL(url), headers: options.headers ?? {} });
    if (url.includes("matchVideoAll")) return new Response(JSON.stringify({ code: 0, data: { playbackList: replays, totalList: [] } }));
    if (url.includes("matchDetail")) {
      return new Response(JSON.stringify({ code: 0, data: {
        liveId: "1397586800",
        coverPicture: "https://pic.test/cover.jpg",
        multiCameras: { cameras: [{ name: "英文原音", liveID: "1782040500", pic: { "640x360": "https://pic.test/en.jpg" } }] },
        matchInfo: { matchDesc: "NBA杯", leftName: "掘金", rightName: "太阳", leftGoal: "88", rightGoal: "90", matchPeriod: period },
      } }));
    }
    return new Response(JSON.stringify({ iretcode, playurl: iretcode ? "" : playurl, defn: "shd", ispay: 1, errinfo: "请您登录后再试 (25)" }));
  };
  return { asked, fetchImpl };
}

const noYtdlp = createYtdlp({ exec: () => assert.fail("a live game runs no yt-dlp") });
const quiet = { warn() {}, info() {} };
const game = { plugin: SOURCE_ID, id: GAME, url: GAME };
const car = { capabilities: { video: ["avc1"], audio: ["mp4a"], maxHeight: 720 }, limits: { maxVideoKbps: 4800 } };

test("the cKey is yt-dlp's for Tencent's APIs", () => {
  // yt-dlp's TencentBaseIE._get_ckey for the same request.
  assert.equal(
    cKey("1782040500", { guid: "0123456789abcdef0123456789abcdef", time: 1793411775, userAgent: "Mozilla/5.0 Test" }),
    "3B9420BD1DD56FB5DFCEC1857BF32CBF055D81F1ADC963EE4E6C615CF2EEAA2B36F91F598C7B71EB0C65D93A181FE6226D0DB81EB9357A537B69BB7BA47D8BDD3F3C5E2DAF2084F9A2134D19798951E5FBAFB56C3B374D7E69CC018EE1036AB230073073BE5B09297FB314D340B5A7B2851C77BCCEDD5C01099D5CE646BF55F56DD50BFD1AA0280BB5ADCCA6E102C88A6E76206A146AD48C7ABB3287BAA8C6994FCAF581E3BA77DA118B2D13386F989FBB4EC1EB740E7268E556A168BAA28ACB",
  );
  assert.deepEqual([definitionFor(1080), definitionFor(720), definitionFor(600), definitionFor(240)], ["fhd", "shd", "hd", "sd"]);
});

test("a game being played plays its English channel live, at the screen's height, with the owner's session", async () => {
  const { asked, fetchImpl } = tencent();
  const source = createYtdlpSource(noYtdlp, { fetchImpl, logger: quiet, account: { session: async () => SESSION } });

  const described = await source.describe(game);
  assert.deepEqual(described, { title: "NBA杯 掘金 88–90 太阳", thumbnail: "https://pic.test/en.jpg", duration: null, isLive: true });
  const prepared = await source.prepare(game, car);
  assert.deepEqual([prepared.isLive, prepared.input, prepared.startTime, prepared.profile], [true, { type: "hls", url: "http://live.test/1782040502.m3u8" }, 0, { height: 720 }]);
  const live = asked.filter(({ url }) => url.hostname === "info.zb.video.qq.com").at(-1);
  assert.deepEqual([live.url.searchParams.get("cnlid"), live.url.searchParams.get("defn"), live.url.searchParams.get("vusession"), live.headers.cookie], ["1782040500", "shd", "session-a", SESSION.cookie]);
  assert.match(live.url.searchParams.get("cKey"), /^[0-9A-F]{64,}$/);
  assert.deepEqual(await prepared.refresh(), { type: "hls", url: "http://live.test/1782040502.m3u8" });
  assert.deepEqual([await source.tracks(game), await source.chapters(game), await source.comments(game, { start: 0 })], [{ subtitles: [], audio: [] }, [], null]);
});

test("a paid game without a sign-in Tencent accepts says how to sign in; a game not started yet says so", async () => {
  const refused = createYtdlpSource(noYtdlp, { fetchImpl: tencent({ iretcode: 25 }).fetchImpl, logger: quiet });
  await assert.rejects(refused.prepare(game, car), (error) => error.code === "forbidden" && /accounts login/.test(error.message));

  const upcoming = createYtdlpSource(noYtdlp, { fetchImpl: tencent({ period: "0" }).fetchImpl, logger: quiet });
  await assert.rejects(upcoming.describe(game), /not started yet/);
});
