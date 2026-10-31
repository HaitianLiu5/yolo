import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { COOKIES_FILE, createTencentAccount, readSignIn, removeSignIn, signInWithCode, STATE_FILE, wechatCode, writeSignIn } from "../src/tencent-account.js";
import { createYtdlp } from "../src/ytdlp.js";

// Yolo's own Tencent sign-in (tencent-account.js): started from the cookies
// file's WeChat sign-in or a QR code, its Tencent Video session renewed on
// demand, kept in the plugin's state directory, and handed to yt-dlp for
// Tencent Video pages only.

const root = mkdtempSync(join(tmpdir(), "yolo-tencent-account-"));
after(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const dir = () => mkdtempSync(join(root, `${dirs++}-`));
const quiet = { warn() {}, info() {} };

const line = (host, name, value) => [host, "TRUE", "/", "FALSE", "0", name, value].join("\t");
const COOKIES = [
  "# Netscape HTTP Cookie File",
  line(".sports.qq.com", "main_login", "wx"),
  line(".sports.qq.com", "appid", "wxapp"),
  line(".sports.qq.com", "openid", "open-1"),
  line(".sports.qq.com", "refresh_token", "refresh-1"),
  line(".video.qq.com", "vusession", "stale"),
  line(".bilibili.com", "SESSDATA", "kept"),
].join("\n");

// Tencent Sports' init API: refresh renews the WeChat token, login gives a
// Tencent Video session of `ttl` seconds.
function sports({ ttl = 6600, fail = false } = {}) {
  const asked = [];
  let sessions = 0;
  const fetchImpl = async (url, options = {}) => {
    asked.push({ url: new URL(url), cookie: options.headers?.cookie ?? "" });
    if (fail) return new Response(JSON.stringify({ code: -1, msg: "expired" }));
    if (url.includes("/init/refresh")) return new Response(JSON.stringify({ code: 0, data: { cookie: [{ name: "vusession", value: "" }], wxReply: { access_token: "access-2" } } }));
    sessions += 1;
    return new Response(JSON.stringify({ code: 0, data: { tokenTTL: ttl, cookie: [{ name: "vuserid", value: "123456789" }, { name: "vusession", value: `session-${sessions}` }] } }));
  };
  return { asked, fetchImpl };
}

test("the cookies file's WeChat sign-in starts Yolo's own, renewed once and kept, private, until it ends soon", async () => {
  const stateDir = dir();
  const cookiesFile = join(stateDir, "cookies.txt");
  writeFileSync(cookiesFile, COOKIES);
  let clock = 1_000_000;
  const { asked, fetchImpl } = sports();
  const account = createTencentAccount({ stateDir, cookiesFile, fetchImpl, now: () => clock, logger: quiet });

  assert.deepEqual(account.status(), { signedIn: true, via: "cookies", sessionUntil: null });
  const session = await account.session();
  assert.deepEqual([session.vuserid, session.vusession], ["123456789", "session-1"]);
  assert.match(session.cookie, /main_login=wx; appid=wxapp; openid=open-1; access_token=access-2; refresh_token=refresh-1; vuserid=123456789; vusession=session-1/);
  assert.deepEqual(asked.map(({ url }) => url.pathname), ["/init/refresh", "/init/login"]);
  assert.equal(asked[0].url.searchParams.get("refresh_token"), "refresh-1");
  assert.equal(statSync(join(stateDir, STATE_FILE)).mode & 0o777, 0o600);

  // Reused while it lasts; renewed in its last ten minutes.
  clock += 5900 * 1000;
  assert.equal((await account.session()).vusession, "session-1");
  clock += 300 * 1000;
  assert.equal((await account.session()).vusession, "session-2");
  assert.equal(asked.length, 4);

  // yt-dlp's copy of the cookies file: this session in place of the stale
  // Tencent Video cookie, every other cookie kept.
  const merged = readFileSync(await account.ytdlpCookies(), "utf8");
  assert.match(merged, /\.video\.qq\.com\tTRUE\t\/\tFALSE\t\d+\tvusession\tsession-2/);
  assert.doesNotMatch(merged, /stale/);
  assert.match(merged, /SESSDATA\tkept/);
  assert.equal(statSync(join(stateDir, COOKIES_FILE)).mode & 0o777, 0o600);
});

test("a sign-in `accounts login` writes is used at once, one `accounts logout` removes is dropped at once; a failed renewal plays anonymously and waits a minute", async () => {
  const stateDir = dir();
  let clock = 1_000_000;
  const { asked, fetchImpl } = sports();
  const account = createTencentAccount({ stateDir, fetchImpl, now: () => clock, logger: quiet });
  assert.deepEqual(account.status(), { signedIn: false });

  const signIn = { cookies: { main_login: "wx", appid: "wxapp", refresh_token: "refresh-9", vuserid: "1", vusession: "fresh" }, until: clock + 3600_000, via: "wechat", at: clock };
  writeSignIn(stateDir, signIn);
  assert.equal((await account.session()).vusession, "fresh");

  // Logged out while the node runs: nothing plays with it, and nothing renews it back.
  removeSignIn(stateDir);
  assert.equal(await account.session(), null);
  clock += 3600_000;
  assert.equal(await account.session(), null);
  assert.deepEqual([asked.length, readSignIn(stateDir)], [0, null]);
  writeSignIn(stateDir, { ...signIn, until: clock + 3600_000 });

  const warnings = [];
  const failing = sports({ fail: true });
  const expired = createTencentAccount({ stateDir, fetchImpl: failing.fetchImpl, now: () => clock, logger: { warn: (text) => warnings.push(text) } });
  clock += 3600_000;
  assert.equal(await expired.session(), null);
  assert.equal(await expired.session(), null);
  assert.equal(failing.asked.length, 1);
  assert.match(warnings[0], /accounts login/);
  assert.doesNotMatch(warnings[0], /refresh-9|fresh/);
});

test("a WeChat QR code is confirmed, scanned once, and its code becomes a sign-in with its first session", async () => {
  const answers = ["window.wx_errcode=408;window.wx_code='';", "window.wx_errcode=404;window.wx_code='';", "window.wx_errcode=404;window.wx_code='';", "window.wx_errcode=405;window.wx_code='code-1';"];
  let scanned = 0;
  const code = await wechatCode("uuid-1", { fetchImpl: async () => new Response(answers.shift()), onScanned: () => { scanned += 1; } });
  assert.deepEqual([code, scanned], ["code-1", 1]);
  await assert.rejects(wechatCode("uuid-2", { fetchImpl: async () => new Response("window.wx_errcode=402;window.wx_code='';") }), /expired/);

  const { asked, fetchImpl } = sports();
  const oauth = async (url, options) => {
    if (!url.includes("/wx/oAuth")) return fetchImpl(url, options);
    assert.equal(new URL(url).searchParams.get("code"), "code-1");
    const headers = new Headers();
    for (const cookie of ["openid=open-2; domain=.sports.qq.com", "access_token=access-3; path=/", "refresh_token=refresh-3; path=/"]) headers.append("set-cookie", cookie);
    return new Response("", { status: 302, headers });
  };
  const signIn = await signInWithCode("code-1", { fetchImpl: oauth, now: 0 });
  assert.deepEqual([signIn.via, signIn.cookies.refresh_token, signIn.cookies.vusession, signIn.until], ["wechat", "refresh-3", "session-1", 6600 * 1000]);
  assert.deepEqual(asked.map(({ url }) => url.pathname), ["/init/login"]);

  const stateDir = dir();
  writeSignIn(stateDir, signIn);
  assert.equal(readSignIn(stateDir).cookies.openid, "open-2");
});

test("yt-dlp reads a Tencent Video page with the session's cookies file, and every other page with the owner's", async () => {
  const runs = [];
  const exec = (binary, args, options, callback) => {
    runs.push(args);
    callback(null, JSON.stringify({ title: "video" }), "");
  };
  const ytdlp = createYtdlp({ exec, cookies: ["--cookies", "/owner.txt"], cookiesFor: async (url) => (url.includes("v.qq.com") ? ["--cookies", "/tencent.txt"] : null) });
  await ytdlp.info("https://v.qq.com/x/cover/c/v.html");
  await ytdlp.info("https://www.bilibili.com/video/BV1");
  await ytdlp.publicInfo("https://v.qq.com/x/cover/c/v.html");
  const cookies = runs.map((args) => (args.includes("--cookies") ? args[args.indexOf("--cookies") + 1] : null));
  assert.deepEqual(cookies, ["/tencent.txt", "/owner.txt", null]);
});
