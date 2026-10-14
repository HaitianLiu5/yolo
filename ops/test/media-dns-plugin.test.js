import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { validateInstance, withDefaults } from "../lib/instance.js";
import { findDnsPlugin, listDnsPlugin, lookupNameservers, pluginDnsChecks, provisionPluginDns } from "../lib/media-dns.js";
import { renderText } from "../lib/output.js";
import { ROOT } from "../lib/paths.js";
import { readSecret } from "../lib/secret-input.js";
import { readTemplate, renderInstanceConfig } from "../lib/wrangler-config.js";

// The media names through a DNS provider plugin, deSEC first, as the
// operator's command line sets them up and checks them
// (Agent Note 2026-10-14-dns-provider-plugins). deSEC's API is a stand-in:
// nothing here reaches desec.io.

const template = readTemplate(join(ROOT, "service/control/wrangler.jsonc"));
const example = JSON.parse(readFileSync(join(ROOT, "yolo.instance.example.json"), "utf8"));
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ids = { d1: { id: "00000000-0000-4000-8000-000000000000" }, kv: { id: ACCOUNT }, vpc: { serviceId: "00000000-0000-4000-8000-000000000002" } };
const workersDev = { version: 1, domain: null, workersDev: true, worker: "yolo-k3x9q2", host: "yolo-k3x9q2.home-ab12cd.workers.dev", ...ids };
const desec = { media: { dns: { provider: "desec", zone: "home.dedyn.io" } } };
const TOKEN = "desec-token-never-shown";

// A checkout whose yolo.config.json lists the deSEC plugin, as provision leaves it.
const listed = mkdtempSync(join(tmpdir(), "yolo-dns-listed-"));
after(() => rmSync(listed, { recursive: true, force: true }));
writeFileSync(join(listed, "yolo.config.json"), JSON.stringify({ plugins: [join(ROOT, "plugins/dns-desec")] }));
const foundDesec = () => findDnsPlugin({ root: listed, env: {}, provider: "desec" });

test("the instance file chooses the DNS provider and its zone, and a named provider brings the remote listener's name back", () => {
  assert.deepEqual(withDefaults(example).media.dns, { provider: "cloudflare", zone: null });
  const plain = renderInstanceConfig(template, example);
  assert.deepEqual([plain.vars.MEDIA_DNS_PROVIDER, plain.vars.MEDIA_DNS_ZONE], ["cloudflare", ""]);

  const raw = { ...workersDev, ...desec };
  assert.deepEqual(validateInstance(raw), []);
  assert.equal(withDefaults(raw).media.wan.certificate, "name", "without a domain the remote listener is named too");
  const config = renderInstanceConfig(template, raw);
  assert.deepEqual([config.vars.MEDIA_DNS_PROVIDER, config.vars.MEDIA_DNS_ZONE, config.vars.WAN_CERTIFICATE], ["desec", "home.dedyn.io", "name"]);
  assert.equal(withDefaults({ ...raw, media: { ...desec.media, wan: { certificate: "ip" } } }).media.wan.certificate, "ip", "the owner may keep it by address");

  const fields = (dns, base = workersDev) => validateInstance({ ...base, media: { dns } }).map((problem) => problem.field);
  assert.deepEqual(fields({ provider: "desec" }), ["media.dns.zone"], "a plugin's provider needs its zone");
  assert.deepEqual(fields({ provider: "desec", zone: "https://home.dedyn.io" }), ["media.dns.zone"]);
  assert.deepEqual(fields({ provider: "De Sec", zone: "home.dedyn.io" }), ["media.dns.provider"]);
  assert.deepEqual(fields({ provider: "cloudflare", zone: "home.dedyn.io" }), ["media.dns.zone"], "Cloudflare uses the domain's zone");
  assert.deepEqual(fields({ provider: "desec", zone: "example.com" }, { version: 1, domain: "yolo.example.com", ...ids }), ["media.dns.zone"], "the control plane never sits in the media zone");
  assert.deepEqual(validateInstance({ ...workersDev, media: { wan: { certificate: "name" } } }).map((problem) => problem.field), ["media.wan.certificate"], "without a domain or a provider there is no name");
});

test("the provider's plugin is found through the plugin config, by its setup entry", async (t) => {
  const official = await findDnsPlugin({ root: ROOT, env: {}, provider: "desec" });
  assert.deepEqual([official.plugin, official.configPath], [null, join(ROOT, "plugins/official.json")], "opt-in: the official list does not load it");
  const found = await foundDesec();
  assert.equal(found.plugin?.name, "@useyolo/dns-desec");
  assert.deepEqual([found.setup.provider, found.setup.secret], ["desec", "DESEC_TOKEN"]);

  const root = mkdtempSync(join(tmpdir(), "yolo-dns-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "yolo.config.json"), JSON.stringify({ plugins: [join(ROOT, "plugins/source-ytdlp")] }));
  const missing = await findDnsPlugin({ root, env: {}, provider: "desec" });
  assert.deepEqual([missing.plugin, missing.configPath], [null, join(root, "yolo.config.json")]);
  writeFileSync(join(root, "yolo.config.json"), JSON.stringify({ plugins: [{ source: join(ROOT, "plugins/dns-desec"), enabled: false }] }));
  assert.equal((await findDnsPlugin({ root, env: {}, provider: "desec" })).plugin, null, "a plugin turned off is not there");
});

test("choosing deSEC on the official list writes a yolo.config.json with the official plugins and deSEC's, and never touches an owner's own", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yolo-dns-official-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plugins"));
  writeFileSync(join(root, "plugins/official.json"), JSON.stringify({ plugins: [{ source: "./source-plex" }, { source: join(ROOT, "plugins/source-ytdlp"), options: { binary: "yt-dlp" } }] }));

  const file = listDnsPlugin({ root, env: {}, provider: "desec", checkout: root });
  assert.equal(file, join(root, "yolo.config.json"));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { plugins: [
    { source: "./plugins/source-plex" },
    { source: join(ROOT, "plugins/source-ytdlp"), options: { binary: "yt-dlp" } },
    { source: "./plugins/dns-desec" },
  ] }, "the official plugins as they were, paths from the repository root, then deSEC's");

  const before = readFileSync(file, "utf8");
  assert.equal(listDnsPlugin({ root, env: {}, provider: "desec", checkout: root }), null, "an existing yolo.config.json is the owner's");
  assert.equal(listDnsPlugin({ root: mkdtempSync(join(tmpdir(), "yolo-dns-own-")), env: { YOLO_CONFIG: file }, provider: "desec" }), null, "so is YOLO_CONFIG");
  assert.equal(listDnsPlugin({ root, env: {}, provider: "elsewhere" }), null, "only official DNS plugins are listed");
  assert.equal(readFileSync(file, "utf8"), before);

  // From another checkout the plugin's path is absolute, and the provider is found.
  rmSync(file);
  listDnsPlugin({ root, env: {}, provider: "desec", checkout: ROOT });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).plugins.at(-1).source, join(ROOT, "plugins/dns-desec"));
  writeFileSync(file, JSON.stringify({ plugins: [join(ROOT, "plugins/source-ytdlp"), join(ROOT, "plugins/dns-desec")] }));
  assert.equal((await findDnsPlugin({ root, env: {}, provider: "desec" })).plugin?.name, "@useyolo/dns-desec");
});

test("a preview without the name writes no yolo.config.json and still finds the official plugin's steps; recording the choice lists it", async (t) => {
  const { dnsPluginFor } = await import("../lib/media-dns.js");
  const root = mkdtempSync(join(tmpdir(), "yolo-dns-preview-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plugins"));
  writeFileSync(join(root, "plugins/official.json"), JSON.stringify({ plugins: [join(ROOT, "plugins/source-ytdlp")] }));

  const preview = await dnsPluginFor({ root, env: {}, provider: "desec", checkout: ROOT, record: false });
  assert.deepEqual([preview.plugin?.name, preview.setup?.provider, preview.listed], ["@useyolo/dns-desec", "desec", null]);
  assert.equal(existsSync(join(root, "yolo.config.json")), false, "a preview changes nothing");

  const recorded = await dnsPluginFor({ root, env: {}, provider: "desec", checkout: ROOT, record: true });
  assert.deepEqual([recorded.plugin?.name, recorded.listed], ["@useyolo/dns-desec", join(root, "yolo.config.json")]);
});

test("a plugin whose setup entry cannot be loaded is skipped, and the others are still found", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yolo-dns-broken-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const broken = join(root, "broken-setup");
  mkdirSync(broken);
  writeFileSync(join(broken, "package.json"), JSON.stringify({ name: "@fixture/broken-setup", type: "module", yolo: { control: "./control.js", setup: "./setup.js" } }));
  writeFileSync(join(broken, "control.js"), "export default () => {};\n");
  writeFileSync(join(broken, "setup.js"), "throw new Error(\"broken setup\");\n");
  writeFileSync(join(root, "yolo.config.json"), JSON.stringify({ plugins: [broken, join(ROOT, "plugins/dns-desec")] }));
  const found = await findDnsPlugin({ root, env: {}, provider: "desec" });
  assert.equal(found.plugin?.name, "@useyolo/dns-desec");
  assert.match(found.skipped?.[0] ?? "", /@fixture\/broken-setup.*broken setup/);
  const checks = pluginDnsChecks({ instance: withDefaults({ ...workersDev, ...desec }), found });
  assert.deepEqual(checks.filter((check) => check.id === "config.plugin-setup").map(({ status }) => status), ["warn"], "doctor names the broken plugin and carries on");
  assert.equal(checks.find((check) => check.id === "config.media-dns")?.status, "ok");
});

test("--provider and --zone are recorded only when valid; a provider without its name yet only shows the steps", async () => {
  const { chooseDnsProvider } = await import("../commands/provision.js");
  const raw = structuredClone(workersDev);
  assert.deepEqual(chooseDnsProvider(raw, {}), {});

  const preview = chooseDnsProvider(raw, { provider: "desec" });
  assert.deepEqual(preview.preview?.media.dns, { provider: "desec", zone: null });
  assert.equal(raw.media, undefined, "nothing recorded without a name");

  const refused = chooseDnsProvider(raw, { provider: "desec", zone: "https://home.dedyn.io" });
  assert.equal(refused.refused?.status, "fail");
  assert.equal(raw.media, undefined);

  assert.deepEqual(chooseDnsProvider(raw, { provider: "desec", zone: "Home.dedyn.io" }), {});
  assert.deepEqual(raw.media, { dns: { provider: "desec", zone: "home.dedyn.io" } });
  assert.deepEqual(chooseDnsProvider(raw, { provider: "cloudflare" }), {}, "back to the domain's zone: the instance has none, so nothing is named");
  assert.deepEqual(raw.media, {});
});

// The Worker's secrets and deSEC's API as provision sees them.
function fakes({ secrets = [], answer = (request) => (request.authorization === `Token ${TOKEN}` ? Response.json({ name: "home.dedyn.io", minimum_ttl: 60 }) : Response.json({ detail: "Invalid token." }, { status: 401 })) } = {}) {
  const stored = new Map(secrets.map((name) => [name, "old"]));
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    assert.notEqual(url.hostname, "desec.io", "tests never call deSEC itself");
    const request = { method: init.method ?? "GET", path: url.pathname, authorization: new Headers(init.headers).get("authorization") };
    requests.push(request);
    return answer(request);
  };
  const worker = {
    list: async () => [...stored.keys()],
    put: async (name, value) => {
      stored.set(name, value);
      return { ok: true };
    },
  };
  return { stored, requests, fetchImpl, worker };
}

test("provision stops for the owner's steps at deSEC, then stores the token it reads without showing it", async () => {
  const found = await foundDesec();
  const api = "https://desec.test/api/v1";
  const instance = withDefaults({ ...workersDev, ...desec });

  const noZone = await provisionPluginDns({ instance: withDefaults({ ...workersDev, media: { dns: { provider: "desec" } } }), found }, { secrets: fakes().worker });
  assert.equal(noZone.status, "needs_human");
  assert.match(noZone.instructions.join("\n"), /https:\/\/desec\.io\/[\s\S]*<name>\.dedyn\.io/);
  assert.match(noZone.fix, /--zone/);

  const f = fakes();
  const waiting = await provisionPluginDns({ instance, found }, { secrets: f.worker, fetchImpl: f.fetchImpl, api });
  assert.equal(waiting.status, "needs_human");
  assert.equal(waiting.instructions.length, 3);
  assert.match(waiting.fix, /--token-stdin/);
  assert.match(waiting.fix, /own terminal/);
  assert.match(renderText({ summary: "Provisioning stopped", steps: [{ id: "media-dns", ...waiting }] }), /\n {9}1\. Open https:\/\/desec\.io\//, "the steps print one per line");
  assert.deepEqual([[...f.stored.keys()], f.requests], [[], []]);

  const stored = await provisionPluginDns({ instance, found, readToken: async () => `${TOKEN}\n` }, { secrets: f.worker, fetchImpl: f.fetchImpl, api });
  assert.equal(stored.status, "done");
  assert.equal(f.stored.get("DESEC_TOKEN"), TOKEN);
  assert.match(stored.message, /DESEC_TOKEN/);
  assert.equal(JSON.stringify(stored).includes(TOKEN), false);
  assert.deepEqual(f.requests.map(({ method, path }) => [method, path]), [["GET", "/api/v1/domains/home.dedyn.io/"]], "one read to check the token, no write");

  // Run again: the Worker has the secret.
  assert.equal((await provisionPluginDns({ instance, found }, { secrets: f.worker, fetchImpl: f.fetchImpl, api })).status, "unchanged");
  assert.equal((await provisionPluginDns({ instance, found, rotate: true }, { secrets: f.worker, fetchImpl: f.fetchImpl, api })).status, "needs_human", "--rotate waits for the new token");
});

test("a token deSEC rejects, an empty one, or a missing plugin stores nothing", async () => {
  const found = await foundDesec();
  const api = "https://desec.test/api/v1";
  const instance = withDefaults({ ...workersDev, ...desec });
  const f = fakes();

  const wrong = await provisionPluginDns({ instance, found, readToken: async () => "typo" }, { secrets: f.worker, fetchImpl: f.fetchImpl, api });
  assert.equal(wrong.status, "fail");
  assert.match(wrong.message, /rejected the token/);
  const empty = await provisionPluginDns({ instance, found, readToken: async () => "  \n" }, { secrets: f.worker, fetchImpl: f.fetchImpl, api });
  assert.equal(empty.status, "fail");
  assert.deepEqual([...f.stored.keys()], []);

  const absent = await provisionPluginDns({ instance, found: { plugin: null, setup: null, configPath: "/home/owner/yolo/yolo.config.json" }, readToken: async () => TOKEN }, { secrets: f.worker, fetchImpl: f.fetchImpl, api });
  assert.equal(absent.status, "fail");
  assert.match(absent.message, /desec/);
  assert.match(absent.fix, /\.\/plugins\/dns-desec[\s\S]*yolo\.config\.json[\s\S]*deploy/);
  assert.deepEqual([[...f.stored.keys()], f.requests.length], [[], 1]);
});

test("a token is read from stdin without echo: hidden on a terminal, whole from a pipe", async () => {
  assert.equal(await readSecret({ input: Readable.from(["piped-", "token\n"]), output: { write: () => {} } }), "piped-token");

  const terminal = Object.assign(new EventEmitter(), {
    isTTY: true, raw: false, setRawMode(on) {
      this.raw = on;
    }, setEncoding() {}, resume() {}, pause() {},
  });
  const written = [];
  const reading = readSecret({ input: terminal, output: { write: (text) => written.push(text) }, prompt: "Token: " });
  terminal.emit("data", "s3cx");
  terminal.emit("data", "\u007fr");
  terminal.emit("data", "et\r");
  assert.equal(await reading, "s3cret");
  assert.equal(terminal.raw, false, "the terminal is restored");
  assert.equal(written.join("").includes("s3c"), false, "nothing typed is echoed");
  assert.equal(written[0], "Token: ");

  const cancelled = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, setEncoding() {}, resume() {}, pause() {} });
  const aborted = readSecret({ input: cancelled, output: { write: () => {} } });
  cancelled.emit("data", "abc\u0003");
  await assert.rejects(aborted, /Cancelled/);
});

test("doctor checks the plugin, the secret, the name's delegation, and what the Worker made of them", async () => {
  const found = await foundDesec();
  const instance = withDefaults({ ...workersDev, ...desec });
  const byId = (checks) => Object.fromEntries(checks.map((check) => [check.id, check]));

  const good = byId(pluginDnsChecks({
    instance, found, secretNames: ["NODE_SECRET", "DESEC_TOKEN"], nameservers: ["ns1.desec.io", "ns2.desec.org"],
    media: { lan: { status: "ready", error: null }, remote: { status: "ok" } },
  }));
  assert.deepEqual(Object.values(good).map(({ id, status }) => [id, status]), [
    ["config.media-dns", "ok"], ["cloudflare.media-dns", "ok"], ["dns.delegation", "ok"], ["worker.media-dns", "ok"],
  ]);

  const bad = byId(pluginDnsChecks({
    instance, found, secretNames: ["NODE_SECRET"], nameservers: [],
    media: { lan: { status: "error", error: { step: "zone", message: "deSEC rejected the token in DESEC_TOKEN: it is wrong, expired, or deleted" } } },
  }));
  assert.equal(bad["cloudflare.media-dns"].status, "warn");
  assert.match(bad["cloudflare.media-dns"].fix, /provision media-dns --token-stdin/);
  assert.equal(bad["dns.delegation"].status, "warn");
  assert.match(bad["dns.delegation"].message, /home\.dedyn\.io/);
  assert.equal(bad["worker.media-dns"].status, "warn");
  assert.match(bad["worker.media-dns"].message, /zone: deSEC rejected the token/);

  const stale = byId(pluginDnsChecks({ instance, found, secretNames: ["DESEC_TOKEN"], nameservers: null, media: { lan: { status: "off", error: null } } }));
  assert.equal(stale["dns.delegation"], undefined, "offline: no lookup");
  assert.equal(stale["worker.media-dns"].status, "warn");
  assert.match(stale["worker.media-dns"].fix, /npm run yolo -- deploy/);

  const unbundled = byId(pluginDnsChecks({ instance, found: { plugin: null, setup: null, configPath: join(ROOT, "plugins/official.json") }, secretNames: null, nameservers: null, media: null }));
  assert.equal(unbundled["config.media-dns"].status, "fail");
  assert.match(unbundled["config.media-dns"].fix, /yolo\.config\.json/);

  // Public DNS through DNS over HTTPS, as doctor asks it.
  const answers = await lookupNameservers("home.dedyn.io", { fetchImpl: async (url) => {
    assert.equal(new URL(url).searchParams.get("type"), "NS");
    return Response.json({ Status: 0, Answer: [{ type: 2, data: "ns1.desec.io." }, { type: 2, data: "ns2.desec.org." }] });
  } });
  assert.deepEqual(answers, ["ns1.desec.io", "ns2.desec.org"]);
  assert.deepEqual(await lookupNameservers("nobody.dedyn.io", { fetchImpl: async () => Response.json({ Status: 3 }) }), []);
});
