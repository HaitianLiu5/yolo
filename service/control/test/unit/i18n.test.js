import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LANGUAGE_COOKIE } from "@useyolo/core";
import { createAuthApp } from "../../src/auth/app.js";
import { pageLanguage, wordsIn } from "../../src/auth/i18n.js";
import zhHans from "../../src/auth/locales/zh-Hans.js";
import { accountPage, approvePage, consentPage, deviceCodeForm, deviceConfirmPage, deviceDeniedPage, devicePairedPage, loginPage, messagePage } from "../../src/auth/pages.js";
import { createSession } from "../../src/auth/session.js";
import { writeAccountLanguage } from "../../src/store/language-settings.js";
import { createPluginRequest } from "../../src/store/plugin-requests.js";
import { ensureOwner } from "../../src/store/users.js";
import { createTestD1 } from "../helpers/d1.js";
import { createFakeNode, createMemoryKv } from "../helpers/fakes.js";

// The owner's pages in English and Simplified Chinese (Agent Note
// 2026-10-26-player-language).

const ORIGIN = "https://yolo.example.com";
const AUTH = fileURLToPath(new URL("../../src/auth/", import.meta.url));

test("a page takes this browser's choice from its cookie, then the account's language, then the browser's languages, where any Chinese is Simplified Chinese", async () => {
  const db = createTestD1();
  const owner = await ensureOwner(db);
  const request = (acceptLanguage, cookie) => new Request(ORIGIN, { headers: { ...(acceptLanguage ? { "accept-language": acceptLanguage } : {}), ...(cookie ? { cookie } : {}) } });
  const languageOf = (acceptLanguage, cookie) => pageLanguage(request(acceptLanguage, cookie), db);
  for (const [header, language] of [
    [null, "en"],
    ["zh-CN,zh;q=0.9,en;q=0.8", "zh-Hans"],
    ["zh-TW", "zh-Hans"],
    ["en-US,zh-Hans;q=0.8", "en"],
    ["ja-JP,zh;q=0.5", "zh-Hans"],
    ["ja-JP", "en"],
    ["en;q=0.5,zh-CN;q=0.9", "zh-Hans"],
    ["zh;q=0,en", "en"],
    ["*", "en"],
  ]) assert.equal(await languageOf(header), language, String(header));
  assert.equal(await languageOf("en-US", `other=1; ${LANGUAGE_COOKIE}=zh-Hans`), "zh-Hans");
  assert.equal(await languageOf("zh-CN", `${LANGUAGE_COOKIE}=en`), "en");
  for (const bad of ["fr", "constructor", "%E0%A4%A", '"><script>']) assert.equal(await languageOf("zh-CN", `${LANGUAGE_COOKIE}=${bad}`), "zh-Hans", bad);

  await writeAccountLanguage(db, owner.id, "zh-Hans");
  assert.equal(await languageOf("en-US"), "zh-Hans", "the account's language over the browser's");
  assert.equal(await languageOf("zh-CN", `${LANGUAGE_COOKIE}=en`), "en", "this browser's choice over the account's");
  await writeAccountLanguage(db, owner.id, "ja");
  assert.equal(await languageOf("zh-CN"), "zh-Hans", "a language the pages do not show is none");
  const failing = { prepare: () => { throw new Error("no such table: language_settings"); } };
  assert.equal(await pageLanguage(request("zh-CN"), failing), "zh-Hans", "a read that fails is none, and the page still renders");
});

// Every English text the pages show has its Chinese: each t() of a literal
// under auth/. The catalog holds nothing else.
const CALL = /(?<![\w.$])t\(\s*("(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.)*`)/g;

test("every text the pages show has its Simplified Chinese, and the catalog nothing else", () => {
  const used = new Map();
  for (const name of readdirSync(AUTH).filter((file) => file.endsWith(".js"))) {
    for (const match of readFileSync(`${AUTH}${name}`, "utf8").matchAll(CALL)) {
      const quoted = match[1];
      used.set(quoted.startsWith("`") ? quoted.slice(1, -1) : JSON.parse(quoted), name);
    }
  }
  const missing = [...used].filter(([text]) => !(text in zhHans)).map(([text, file]) => `${file}: ${text}`);
  assert.deepEqual(missing, [], "texts without Simplified Chinese");
  assert.deepEqual(Object.keys(zhHans).filter((text) => !used.has(text)), [], "catalog entries nothing shows");
  // A value named in English is named in Chinese too.
  const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join();
  assert.deepEqual(Object.entries(zhHans).filter(([en, zh]) => names(en) !== names(zh)).map(([en]) => en), [], "values named differently");
});

// Each page and each of its states, with values that read the same in both.
const PLUGIN = { title: { en: "Fixture title", zh: "示例标题" }, summary: { en: "Fixture summary", zh: "示例简介" }, privacy: { en: "Fixture privacy", zh: "示例隐私" }, origin: "local", hosts: ["a.example"] };
const CHANGES = [{ enabled: true }, { enabled: false }, { options: { 选项: 1 } }];
const SCREEN = { deviceName: "客厅", userCode: "BCDF-GHJK", requestedAt: 0, profiles: [] };
const renderings = async (t) => [
  loginPage(t, { hasPasskey: false }),
  loginPage(t, { hasPasskey: true }),
  ...["device", "consent", "settings"].map((kind) => loginPage(t, { hasPasskey: true, context: { kind, deviceName: "客厅", deviceKind: "car" } })),
  consentPage(t, { clientName: "代理", clientDomain: "a.example", redirectHost: "a.example", redirectIsLoopback: true }, "h"),
  consentPage(t, { redirectHost: "a.example" }, "h"),
  accountPage(t, { signedIn: true, origin: ORIGIN }),
  accountPage(t, { signedIn: false, origin: ORIGIN }),
  deviceCodeForm(t),
  deviceConfirmPage(t, { ...SCREEN, deviceKind: "tv" }),
  ...CHANGES.map((change) => approvePage(t, { id: "r", client: "代理", what: "示例", change, plugins: [PLUGIN], expiresAt: 0 })),
  approvePage(t, { id: "r", what: "示例", change: {}, plugins: [{ title: "示例" }], expiresAt: 0 }),
  ...await Promise.all(["car", "browser", "phone", "tv", "other"].map((deviceKind) => devicePairedPage(t, { deviceName: "客厅", deviceKind }).text())),
  await deviceDeniedPage(t, { deviceName: "客厅" }).text(),
  await messagePage(t, "标题", "一句话", 400).text(),
];
const scripts = (html) => [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const visible = (html) => [
  ...html.slice(html.indexOf("<title>")).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").split(/\s+/),
  ...[...html.matchAll(/\s(?:aria-label|placeholder|title|alt)="([^"]+)"/g)].map((match) => match[1]),
].join(" ");
// A quoted sentence in a page's script: what a person would read.
const SENTENCE = /["'`][A-Z][a-z]+ [^"'`]*["'`]/;
// Names, marks, and the words Yolo keeps in English in Chinese too.
const KEPT = /Yolo|UTC|npm run owner-code|agent|app|XXXX-XXXX|BCDF-GHJK|a\.example|https:\/\/yolo\.example\.com\/mcp/g;

test("each page shows only Chinese or only English, its own script's words too, with the right lang", async () => {
  for (const html of await renderings(wordsIn("zh-Hans"))) {
    assert.match(html, /<html lang="zh-Hans">/);
    assert.doesNotMatch(visible(html).replace(KEPT, ""), /[A-Za-z]{2,}/, visible(html));
    for (const script of scripts(html)) {
      assert.doesNotMatch(script, SENTENCE);
      new Function(script); // Translations did not break its quoting.
    }
  }
  for (const html of await renderings(wordsIn("en"))) {
    assert.match(html, /<html lang="en">/);
    assert.doesNotMatch(visible(html).replace(/客厅|代理|示例[一-鿿]*|标题|一句话|选项/g, ""), /[一-鿿]/, visible(html));
    for (const script of scripts(html)) assert.doesNotMatch(script, /[一-鿿]/);
  }
});

test("each route answers in the request's language, and a plugin's own text follows it", async () => {
  const db = createTestD1();
  const kv = createMemoryKv();
  const owner = await ensureOwner(db);
  const session = (await createSession(kv, owner.id)).split(";")[0];
  const catalog = { plugins: [{ name: "@x/plugin", ...PLUGIN }], places: [] };
  const app = createAuthApp({ nodeClient: () => createFakeNode(), servicesFor: () => ({ plugins: async () => catalog }) });
  const { id } = await createPluginRequest(db, owner.id, { plugin: "@x/plugin", change: { enabled: true } });
  const env = { PUBLIC_ORIGIN: ORIGIN, DB: db, OAUTH_KV: kv };
  const ask = async (path, headers, init = {}) => {
    const response = await app.request(path, { ...init, headers: { "accept-language": "zh-CN", ...headers } }, env);
    return /<html lang="([^"]+)"/.exec(await response.text())?.[1];
  };
  for (const [path, headers = {}] of [["/login"], ["/account"], ["/device", { cookie: session }], ["/approve/none"], [`/approve/${id}`]]) {
    assert.equal(await ask(path, headers), "zh-Hans", path);
    assert.equal(await ask(path, { ...headers, "accept-language": "en-US" }), "en", path);
  }
  assert.equal(await ask("/device", { cookie: `${LANGUAGE_COOKIE}=en; ${session}` }), "en", "the player's choice over the browser's");
  for (const path of ["/device", "/oauth/authorize"]) {
    assert.equal(await ask(path, { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, { method: "POST", body: "code=BCDF-GHJK" }), "zh-Hans", `the answer to a form on ${path}`);
  }
  const approve = await (await app.request(`/approve/${id}`, { headers: { "accept-language": "zh-CN" } }, env)).text();
  assert.match(approve, /示例标题/);
  assert.doesNotMatch(approve, /Fixture/);
});
