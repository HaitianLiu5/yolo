import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cookieHeader, createDanmaku, danmakuCid, parseDanmakuSegment, parseDanmakuXml } from "../src/danmaku.js";
import { createYtdlpSource, SOURCE_ID } from "../src/node.js";
import { createYtdlp } from "../src/ytdlp.js";

const XML = readFileSync(new URL("./fixtures/danmaku.xml", import.meta.url), "utf8");
const OFFICIAL_XML = "https://comment.bilibili.com/10001.xml";
const PAGE = "https://www.bilibili.com/video/BV1fixture";

// What the fixture's comments are, in time order: the scripted (mode 7),
// special-pool, and blank ones are dropped; mode 6 scrolls; `weight` is
// Bilibili's rank for its smart blocking.
const EXPECTED = [
  { t: 3.2, text: "开头 & 片头 <3", mode: "top", color: "#ff0000", size: 1, weight: 9 },
  { t: 7, text: "字幕君：你好", mode: "bottom", color: "#00ff00", size: 0.72, weight: 8 },
  { t: 8, text: "逆向弹幕", mode: "scroll", color: "#0000ff", size: 1.44, weight: 7 },
  { t: 12.5, text: "前方高能", mode: "scroll", color: "#ffffff", size: 1, weight: 10 },
  { t: 20.25, text: "😀哈哈哈", mode: "scroll", color: "#ffffff", size: 1, weight: 3 },
];

// A protobuf segment with the same comments, as Bilibili's seg.so sends it.
function varint(value) {
  const bytes = [];
  let rest = BigInt(value);
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest) byte |= 0x80;
    bytes.push(byte);
  } while (rest);
  return bytes;
}
const field = (number, wire, payload) => [...varint(number * 8 + wire), ...payload];
const bytesField = (number, bytes) => field(number, 2, [...varint(bytes.length), ...bytes]);
function elem({ id, ms, mode, size, color, text, weight = 10, pool = 0 }) {
  return [
    ...field(1, 0, varint(id)), // a 64-bit id
    ...field(2, 0, varint(ms)),
    ...field(3, 0, varint(mode)),
    ...field(4, 0, varint(size)),
    ...field(5, 0, varint(color)),
    ...bytesField(6, [...Buffer.from("midhash")]),
    ...bytesField(7, [...Buffer.from(text)]),
    ...field(8, 0, varint(1791891607)),
    ...field(9, 0, varint(weight)),
    ...field(11, 0, varint(pool)),
    ...field(15, 1, [1, 2, 3, 4, 5, 6, 7, 8]), // an unknown fixed64 field
  ];
}
const SEGMENT = Uint8Array.from([
  ...bytesField(1, elem({ id: 2221306820516301568n, ms: 12_500, mode: 1, size: 25, color: 16777215, text: "前方高能" })),
  ...bytesField(1, elem({ id: 2, ms: 3_200, mode: 5, size: 25, color: 16711680, text: "开头", weight: 2 })),
  ...bytesField(1, elem({ id: 3, ms: 9_000, mode: 7, size: 25, color: 1, text: "[scripted]" })),
  ...bytesField(1, elem({ id: 4, ms: 10_000, mode: 1, size: 25, color: 1, text: "special", pool: 2 })),
  ...field(2, 0, varint(1)), // the reply's state
]);

test("the comment XML parses into timed comments with mode, colour, and size", () => {
  assert.deepEqual(parseDanmakuXml(XML), EXPECTED);
  assert.equal(danmakuCid(OFFICIAL_XML), "10001");
  assert.equal(danmakuCid("http://127.0.0.1:9/10001.xml"), null);
});

test("a protobuf segment parses the same way, skipping unknown fields", () => {
  assert.deepEqual(parseDanmakuSegment(SEGMENT), [
    { t: 3.2, text: "开头", mode: "top", color: "#ff0000", size: 1, weight: 2 },
    { t: 12.5, text: "前方高能", mode: "scroll", color: "#ffffff", size: 1, weight: 10 },
  ]);
  assert.throws(() => parseDanmakuSegment(SEGMENT.subarray(0, 20)), /ends inside|runs past/);
});

test("a cookies file gives the host's cookies only", () => {
  const file = [
    "# Netscape HTTP Cookie File",
    ".bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tabc",
    "#HttpOnly_.bilibili.com\tTRUE\t/\tFALSE\t4102444800\tbili_jct\tdef",
    ".bilibili.com\tTRUE\t/\tFALSE\t1\texpired\tx",
    ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tnope",
  ].join("\n");
  assert.equal(cookieHeader(file, "https://comment.bilibili.com/1.xml"), "SESSDATA=abc; bili_jct=def");
  assert.equal(cookieHeader(file, "https://example.com/"), null);
});

function fixtures({ xml = XML, xmlStatus = 200 } = {}) {
  const calls = [];
  const requests = [];
  const exec = (binary, args, options, callback) => {
    calls.push(args);
    callback(null, JSON.stringify({ title: "Fixture", http_headers: { Referer: PAGE }, subtitles: { danmaku: [{ ext: "xml", url: OFFICIAL_XML }] } }), "");
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers });
    if (url === OFFICIAL_XML) return new Response(xml, { status: xmlStatus, headers: { "content-type": "text/xml" } });
    if (url.includes("segment_index=1")) return new Response(SEGMENT, { headers: { "content-type": "application/octet-stream" } });
    return new Response(null, { status: 304 });
  };
  return { calls, requests, ytdlp: createYtdlp({ exec }), fetchImpl };
}

test("the source reads Bilibili's comment XML once yt-dlp names it, with the plugin's headers and cookies", async () => {
  const { calls, requests, ytdlp, fetchImpl } = fixtures();
  const source = createYtdlpSource(ytdlp, { fetchImpl, cookiesFile: "/cookies.txt", logger: { warn() {} } });
  const item = { plugin: SOURCE_ID, id: "https://bilibili.com/video/BV1fixture", url: PAGE };
  const answer = await source.comments(item, { start: 0, end: 360 });
  assert.deepEqual(answer, { comments: EXPECTED, start: 0, end: null });
  assert.ok(calls[0].includes("--write-subs") && calls[0].includes("all,-live_chat") && calls[0].at(-1) === PAGE);
  assert.equal(requests[0].headers.Referer, PAGE);
  assert.match(requests[0].headers["User-Agent"], /Chrome/);

  // yt-dlp's answer is kept for the page: the next call reads the XML only.
  await source.comments(item, { start: 400, end: 760 });
  assert.equal(calls.length, 1);

  // Other sites have no danmaku, and yt-dlp is not asked.
  assert.equal(await source.comments({ plugin: SOURCE_ID, id: "https://youtube.com/watch?v=a", url: "https://youtu.be/a" }, { start: 0, end: 360 }), null);
  assert.equal(calls.length, 1);
});

test("a failing XML falls back to the segment that holds the start", async () => {
  const { ytdlp, fetchImpl, requests } = fixtures({ xmlStatus: 503 });
  const comments = createDanmaku({
    ytdlp, fetchImpl, cookiesFile: "/cookies.txt", logger: { warn() {} },
    readText: async () => ".bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tabc",
  });
  const first = await comments(PAGE, { start: 10 });
  assert.deepEqual([first.start, first.end, first.comments.length], [0, 360, 2]);
  const segment = requests.find((request) => request.url.includes("seg.so"));
  assert.match(segment.url, /oid=10001&segment_index=1$/);
  assert.equal(segment.headers.Cookie, "SESSDATA=abc");
  // Past the item's end, the API answers 304: no comments there.
  assert.deepEqual(await comments(PAGE, { start: 400 }), { comments: [], start: 360, end: 720 });
});
