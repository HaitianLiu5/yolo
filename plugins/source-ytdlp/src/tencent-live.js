import { createCipheriv, randomBytes } from "node:crypto";
import { YoloError } from "@useyolo/plugin-api";
import { BROWSER_USER_AGENT } from "./formats.js";

// A Tencent Sports game while it is played: its live HLS from Tencent's live
// play-info API (info.zb.video.qq.com), which yt-dlp does not read. Each
// request carries a cKey, the same signature yt-dlp computes for Tencent
// Video's on-demand API, and a paid game answers only to the owner's signed-in
// session (tencent-account.js) (Agent Note 2026-10-26-tencent-sports-replays).

const LIVE_API = "https://info.zb.video.qq.com/";
const TIMEOUT_MS = 8_000;
const PLATFORM = "4330701";
const APP_VERSION = "1.0.0";
const PAGE = "https://sports.qq.com/kbsweb/game.htm";
// yt-dlp's (yt_dlp/extractor/tencent.py, encryptVer 8.1).
const CKEY_KEY = Buffer.from("4f6bdaa39e2f8cb07f5e722d9edef314", "hex");
const CKEY_IV = Buffer.from("01504af356e619cf2e42bba68c3f70f9", "hex");

// The cKey of a request for `id` from `url`, at `time` (Unix seconds).
export function cKey(id, { url = PAGE, guid, time = Math.floor(Date.now() / 1000), platform = PLATFORM, appVersion = APP_VERSION, userAgent = BROWSER_USER_AGENT } = {}) {
  const payload = `${id}|${time}|mg3c3b04ba|${appVersion}|${guid}|${platform}|${url.slice(0, 48)}|${userAgent.toLowerCase().slice(0, 48)}||Mozilla|Netscape|Windows x86_64|00|`;
  const sum = [...payload].reduce((total, char) => total + char.charCodeAt(0), 0);
  const plain = Buffer.from(`|${sum}|${payload}`, "utf8");
  // Padded with spaces to the block size, as yt-dlp's "whitespace" padding.
  const padded = Buffer.concat([plain, Buffer.alloc(16 - (plain.length % 16), 0x20)]);
  const cipher = createCipheriv("aes-128-cbc", CKEY_KEY, CKEY_IV).setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("hex").toUpperCase();
}

// Tencent's definitions, smallest first, by the height each one is.
const DEFINITIONS = [["sd", 360], ["hd", 540], ["shd", 720], ["fhd", 1080]];

// The tallest definition at most `height`, else the smallest.
export function definitionFor(height) {
  const fitting = DEFINITIONS.filter(([, tall]) => tall <= (Number(height) || 720));
  return (fitting.at(-1) ?? DEFINITIONS[0])[0];
}

/**
 * The live stream of the channel `liveId` at a definition: { url, height,
 * paid } where `url` is the HLS playlist. `session` is the owner's signed-in
 * session, or null to ask anonymously, which only a free game answers.
 */
export async function liveStream(liveId, { height = 720, session = null, fetchImpl = globalThis.fetch } = {}) {
  const guid = randomBytes(16).toString("hex");
  const query = new URLSearchParams({
    cnlid: liveId, host: "sports.qq.com", cmd: "2", qq: "0", guid, txvjsv: "2.0", stream: "2", system: "1",
    sdtfrom: "v1104", platform: PLATFORM, appVer: APP_VERSION, encryptVer: "8.1", cKey: cKey(liveId, { guid }),
    defn: definitionFor(height), otype: "json",
    ...(session ? { vuserid: session.vuserid, vusession: session.vusession } : {}),
  });
  const headers = { "user-agent": BROWSER_USER_AGENT, referer: PAGE, ...(session ? { cookie: session.cookie } : {}) };
  const response = await fetchImpl(`${LIVE_API}?${query}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new YoloError("resolve_failed", `Tencent's live API answered ${response.status}`);
  const body = await response.json();
  const code = Number(body?.iretcode);
  if (code === 0 && body.playurl) {
    const height = Number(DEFINITIONS.find(([name]) => name === body.defn)?.[1]) || null;
    return { url: String(body.playurl), height, paid: body.ispay === 1 || body.ispay === "1" };
  }
  // 25: a paid game for a viewer who is not signed in, or whose session ended.
  if (code === 25) {
    throw new YoloError("forbidden", session
      ? "Tencent did not accept Yolo's sign-in for this game: run npm run yolo -- accounts login on the node's machine"
      : "This game plays only for a signed-in Tencent account: run npm run yolo -- accounts login on the node's machine", { retryable: false });
  }
  // 8: the program ended; the game's replays follow.
  if (code === 8) throw new YoloError("not_found", "This game's live stream has ended; its replay comes later", { retryable: false });
  throw new YoloError("resolve_failed", `Tencent's live API answered ${code}: ${body?.errinfo || "no message"}`);
}
