import assert from "node:assert/strict";
import { test } from "node:test";
import { createDanmaku } from "../src/danmaku.js";
import { createYtdlp } from "../src/ytdlp.js";

// Bilibili's timed comments (Agent Note 2026-10-13-danmaku). test/e2e reads
// the comment XML through the stack; this is the fallback it never takes:
// Bilibili's protobuf segment API, with the cookies file's cookies.

const PAGE = "https://www.bilibili.com/video/BV1fixture";
const XML = "https://comment.bilibili.com/10001.xml";
const varint = (value) => {
  const bytes = [];
  do bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0)); while ((value >>>= 7));
  return bytes;
};
const field = (number, wire, payload) => [...varint(number * 8 + wire), ...payload];
const bytesField = (number, bytes) => field(number, 2, [...varint(bytes.length), ...bytes]);
const elem = ({ ms, mode, color, text }) => [...field(2, 0, varint(ms)), ...field(3, 0, varint(mode)), ...field(4, 0, varint(25)), ...field(5, 0, varint(color)), ...bytesField(7, [...Buffer.from(text)]), ...field(9, 0, varint(10))];
const SEGMENT = Uint8Array.from([
  ...bytesField(1, elem({ ms: 12_500, mode: 1, color: 0xffffff, text: "前方高能" })),
  ...bytesField(1, elem({ ms: 9_000, mode: 7, color: 1, text: "[scripted]" })),
]);

test("a failing comment XML falls back to the protobuf segment that holds the start, with the host's cookies", async () => {
  const requests = [];
  const exec = (binary, args, options, callback) => callback(null, JSON.stringify({ title: "Fixture", http_headers: { Referer: PAGE }, subtitles: { danmaku: [{ ext: "xml", url: XML }] } }), "");
  const comments = createDanmaku({
    ytdlp: createYtdlp({ exec }), cookiesFile: "/cookies.txt", logger: { warn() {} },
    readText: async () => ".bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tabc\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tnope",
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: init.headers });
      if (url === XML) return new Response("", { status: 503 });
      return url.includes("segment_index=1") ? new Response(SEGMENT) : new Response(null, { status: 304 });
    },
  });
  assert.deepEqual(await comments(PAGE, { start: 10 }), { comments: [{ t: 12.5, text: "前方高能", mode: "scroll", color: "#ffffff", size: 1, weight: 10 }], start: 0, end: 360 });
  const segment = requests.find((request) => request.url.includes("seg.so"));
  assert.match(segment.url, /oid=10001&segment_index=1$/);
  assert.equal(segment.headers.Cookie, "SESSDATA=abc");
  // Past the item's end the API answers 304: no comments there.
  assert.deepEqual(await comments(PAGE, { start: 400 }), { comments: [], start: 360, end: 720 });
});
