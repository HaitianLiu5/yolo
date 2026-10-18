import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { validateInstance, withDefaults } from "../lib/instance.js";
import { findDnsPlugin, provisionMediaDns, provisionPluginDns, SECRET, TOKEN_NAME } from "../lib/media-dns.js";
import { ROOT } from "../lib/paths.js";
import { readTemplate, renderInstanceConfig } from "../lib/wrangler-config.js";

// `provision media-dns`: a DNS provider plugin's token (deSEC), and the
// built-in Cloudflare one (Agent Notes 2026-10-14-dns-provider-plugins,
// 2026-10-13-no-domain-deployment). Nothing reaches deSEC or Cloudflare, and
// no token value ever reaches the result.

const template = readTemplate(join(ROOT, "service/control/wrangler.jsonc"));
const TOKEN = "token-value-never-shown";
const ids = { d1: { id: "00000000-0000-4000-8000-000000000000" }, kv: { id: "0123456789abcdef0123456789abcdef" }, vpc: { serviceId: "00000000-0000-4000-8000-000000000002" } };
const raw = { version: 1, domain: null, workersDev: true, worker: "yolo-k3x9q2", host: "yolo-k3x9q2.home-ab12cd.workers.dev", ...ids, media: { dns: { provider: "desec", zone: "home.dedyn.io" } } };
const listed = mkdtempSync(join(tmpdir(), "yolo-dns-listed-"));
after(() => rmSync(listed, { recursive: true, force: true }));
writeFileSync(join(listed, "yolo.config.json"), JSON.stringify({ plugins: [join(ROOT, "plugins/dns-desec")] }));

function worker(secrets = []) {
  const stored = new Map(secrets.map((name) => [name, "old"]));
  return { stored, list: async () => [...stored.keys()], put: async (name, value) => (stored.set(name, value), { ok: true }) };
}

test("the instance names the provider and zone the Worker gets; the plugin is found through the plugin config, never the official list", async () => {
  const config = renderInstanceConfig(template, raw);
  assert.deepEqual([config.vars.MEDIA_DNS_PROVIDER, config.vars.MEDIA_DNS_ZONE, config.vars.WAN_CERTIFICATE], ["desec", "home.dedyn.io", "name"]);
  assert.deepEqual(validateInstance({ ...raw, media: { dns: { provider: "desec", zone: "https://home.dedyn.io" } } }).map((problem) => problem.field), ["media.dns.zone"]);
  assert.equal((await findDnsPlugin({ root: ROOT, env: {}, provider: "desec" })).plugin, null, "opt-in");
  assert.equal((await findDnsPlugin({ root: listed, env: {}, provider: "desec" })).plugin?.name, "@useyolo/dns-desec");
});

test("a plugin's token is checked with one read and stored as its Worker secret; a rejected one stores nothing", async () => {
  const found = await findDnsPlugin({ root: listed, env: {}, provider: "desec" });
  const instance = withDefaults(raw);
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    requests.push(`${init.method ?? "GET"} ${new URL(input).pathname}`);
    const ok = new Headers(init.headers).get("authorization") === `Token ${TOKEN}`;
    return ok ? Response.json({ name: "home.dedyn.io", minimum_ttl: 60 }) : Response.json({ detail: "Invalid token." }, { status: 401 });
  };
  const w = worker();
  const api = "https://desec.test/api/v1";
  const wrong = await provisionPluginDns({ instance, found, readToken: async () => "typo" }, { secrets: w, fetchImpl, api });
  assert.deepEqual([wrong.status, [...w.stored.keys()]], ["fail", []]);
  const stored = await provisionPluginDns({ instance, found, readToken: async () => `${TOKEN}\n` }, { secrets: w, fetchImpl, api });
  assert.deepEqual([stored.status, w.stored.get("DESEC_TOKEN"), JSON.stringify(stored).includes(TOKEN)], ["done", TOKEN, false]);
  assert.deepEqual(requests, ["GET /api/v1/domains/home.dedyn.io/", "GET /api/v1/domains/home.dedyn.io/"], "no write to deSEC");
});

test("the built-in token is made with cf for the zone only, and its value goes straight to the Worker secret", async () => {
  const zone = { id: "aaaabbbbccccddddeeeeffff00001111", name: "example.com" };
  const calls = [];
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
  const cf = async (args) => {
    calls.push(args);
    if (args[0] === "auth") return ok({ authenticated: true, scopes: ["account_api_tokens:create", "dns.write", "zone.read"] });
    if (args[2] === "list") return ok([]);
    const name = decodeURIComponent(args[args.indexOf("--name") + 1]);
    if (args[2] === "permission-groups") return ok([{ id: `pg-${name}`, name, scopes: ["com.cloudflare.api.account.zone"] }]);
    if (args[2] === "create") return ok({ id: "tok_new", name: TOKEN_NAME, status: "active", value: TOKEN });
    throw new Error(`unexpected cf ${args.join(" ")}`);
  };
  const w = worker();
  const result = await provisionMediaDns({ instance: { domain: "yolo.example.com", workersDev: false, accountId: "acc" }, zone }, { cf, secrets: w });
  assert.deepEqual([result.status, w.stored.get(SECRET), JSON.stringify(result).includes(TOKEN)], ["done", TOKEN, false]);
  const create = calls.find((args) => args[2] === "create");
  assert.deepEqual(JSON.parse(create[create.indexOf("--policies") + 1]), [{
    effect: "allow", resources: { [`com.cloudflare.api.account.zone.${zone.id}`]: "*" }, permission_groups: [{ id: "pg-DNS Write" }, { id: "pg-Zone Read" }],
  }]);
});
