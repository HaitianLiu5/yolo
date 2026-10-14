import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { personalSubdomain, run as init } from "../commands/init.js";
import { readEnvFile } from "../lib/env-file.js";
import { validateInstance, withDefaults } from "../lib/instance.js";
import { paths, ROOT } from "../lib/paths.js";
import { readTemplate, renderInstanceConfig } from "../lib/wrangler-config.js";

// An instance without a domain, served on workers.dev
// (Agent Note 2026-10-13-no-domain-deployment).

const template = readTemplate(join(ROOT, "service/control/wrangler.jsonc"));
const example = JSON.parse(readFileSync(join(ROOT, "yolo.instance.example.json"), "utf8"));
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ids = { d1: { id: "00000000-0000-4000-8000-000000000000" }, kv: { id: ACCOUNT }, vpc: { serviceId: "00000000-0000-4000-8000-000000000002" } };

test("a file from before the tiers is the domain tier, unchanged", () => {
  const old = { version: 1, domain: "yolo.example.com", ...ids };
  const instance = withDefaults(old);
  assert.deepEqual([instance.workersDev, instance.host, instance.publicOrigin, instance.media.wan.certificate], [false, "yolo.example.com", "https://yolo.example.com", "name"]);
  const config = renderInstanceConfig(template, old);
  assert.deepEqual([config.workers_dev, config.preview_urls, config.routes], [false, false, [{ pattern: "yolo.example.com", custom_domain: true }]]);
  assert.deepEqual(validateInstance(example), []);
});

test("a workers.dev instance renders no route, workers_dev on, preview URLs off, and its host as PUBLIC_ORIGIN", () => {
  const raw = { version: 1, domain: null, workersDev: true, worker: "yolo-k3x9q2", host: "yolo-k3x9q2.home-ab12cd.workers.dev", ...ids };
  const instance = withDefaults(raw);
  assert.deepEqual([instance.publicOrigin, instance.media.wan.certificate], ["https://yolo-k3x9q2.home-ab12cd.workers.dev", "ip"]);
  const config = renderInstanceConfig(template, raw);
  assert.equal(config.routes, undefined);
  assert.deepEqual([config.workers_dev, config.preview_urls, config.vars.PUBLIC_ORIGIN, config.name], [true, false, instance.publicOrigin, "yolo-k3x9q2"]);
  assert.equal(withDefaults({ ...raw, media: { wan: { certificate: "name" } } }).media.wan.certificate, "name");

  const fields = (patch) => validateInstance({ ...raw, ...patch }).map((problem) => problem.field);
  assert.deepEqual(fields({ domain: "yolo.example.com" }), ["domain"]);
  assert.deepEqual(fields({ host: "other.home-ab12cd.workers.dev" }), ["host"]);
  assert.deepEqual(fields({ media: { wan: { certificate: "name" } } }), ["media.wan.certificate"]);
  assert.deepEqual(fields({ workersDev: false }), ["domain", "host"]);
  assert.deepEqual(validateInstance({ version: 1, domain: "x.home.workers.dev" }).map((problem) => problem.field), ["domain"]);
  // Until the subdomain is known the file is valid, but nothing deploys.
  assert.deepEqual(validateInstance({ ...raw, host: undefined }), []);
  assert.deepEqual(validateInstance({ ...raw, host: undefined }, { deploy: true }).map((problem) => problem.field), ["host"]);
});

test("a workers.dev subdomain made from the owner's email or name is noticed", () => {
  assert.equal(personalSubdomain("chris-titanbooths-com-s-account", {}), true);
  assert.equal(personalSubdomain("alice-c88", { email: "someone@example.com", names: ["Alice"] }), true);
  assert.equal(personalSubdomain("alice-smith", { email: "alice.smith@example.com" }), true);
  assert.equal(personalSubdomain("home-ab12cd", { email: "alice@example.com", names: ["Alice"] }), false);
});

// init against a scratch instance file, with Cloudflare replaced.
function harness(t, { loggedIn = true, subdomain = "home-ab12cd", email = "owner@example.com" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "yolo-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = { ...paths(), instance: join(dir, "yolo.instance.json"), envFile: join(dir, ".env"), generated: join(dir, "wrangler.instance.jsonc") };
  const cf = { subdomain, registered: [], loggedIn };
  const deps = {
    account: async () => (cf.loggedIn
      ? { status: "ok", message: "Cloudflare account Owner", accountId: ACCOUNT, accounts: [{ id: ACCOUNT, name: "Owner" }], chosen: true, email }
      : { status: "needs_human", message: "Wrangler is not signed in to Cloudflare", fix: "npx wrangler login" }),
    api: async () => ({}),
    subdomain: async () => cf.subdomain,
    register: async (_api, _account, name) => {
      cf.registered.push(name);
      cf.subdomain = name;
      return name;
    },
  };
  const yolo = (values = {}) => init({ values, p, deps });
  const instance = () => JSON.parse(readFileSync(p.instance, "utf8"));
  return { p, cf, yolo, instance };
}

test("init without a domain serves the instance on the account's workers.dev subdomain, with a neutral Worker name", async (t) => {
  const h = harness(t, { loggedIn: false });
  // Before wrangler login: the local half is done, the host waits.
  let result = await h.yolo();
  assert.equal(result.status, "needs_human");
  assert.deepEqual([h.instance().workersDev, h.instance().domain, h.instance().host], [true, null, undefined]);
  assert.match(h.instance().worker, /^yolo-[a-z0-9]{6}$/);
  assert.ok(readEnvFile(h.p.envFile).NODE_SECRET);

  h.cf.loggedIn = true;
  result = await h.yolo();
  const { worker, host, accountId } = h.instance();
  assert.equal(result.status, "ok");
  assert.equal(host, `${worker}.home-ab12cd.workers.dev`);
  assert.equal(accountId, ACCOUNT);
  assert.equal(result.publicOrigin, `https://${host}`);
  assert.equal(readEnvFile(h.p.envFile).PUBLIC_ORIGIN, `https://${host}`);
  // Run again, nothing changes.
  result = await h.yolo();
  assert.equal(result.steps.find((step) => step.id === "instance").status, "unchanged");
  assert.equal(h.instance().host, host);
});

test("a workers.dev subdomain is registered only with the owner's approval", async (t) => {
  const h = harness(t, { subdomain: null });
  const asked = await h.yolo();
  assert.equal(asked.status, "needs_approval");
  assert.match(asked.approve, /^npm run yolo -- init --workers-subdomain home-[a-z0-9]{6}$/);
  assert.deepEqual(h.cf.registered, []);
  const approved = await h.yolo({ "workers-subdomain": "quiet-harbor" });
  assert.equal(approved.status, "ok");
  assert.deepEqual(h.cf.registered, ["quiet-harbor"]);
  assert.match(h.instance().host, /^yolo-[a-z0-9]{6}\.quiet-harbor\.workers\.dev$/);
});

test("moving the origin needs approval: a renamed subdomain, and moving to a domain", async (t) => {
  const h = harness(t);
  await h.yolo();
  const before = h.instance();
  // Cloudflare renamed the account's subdomain.
  h.cf.subdomain = "renamed-77";
  const asked = await h.yolo();
  assert.equal(asked.status, "needs_approval");
  assert.match(asked.summary, /invalidates every passkey/);
  assert.equal(asked.approve, "npm run yolo -- init --change-domain");
  assert.deepEqual(h.instance(), before);
  await h.yolo({ "change-domain": true });
  assert.equal(h.instance().host, `${before.worker}.renamed-77.workers.dev`);

  // Moving to a custom domain keeps the Worker and drops the workers.dev host.
  assert.equal((await h.yolo({ domain: "yolo.example.com" })).status, "needs_approval");
  assert.equal((await h.yolo({ domain: "yolo.example.com", "change-domain": true })).status, "ok");
  const moved = h.instance();
  assert.deepEqual([moved.domain, moved.workersDev, moved.host, moved.worker], ["yolo.example.com", undefined, undefined, before.worker]);
  assert.equal(readEnvFile(h.p.envFile).PUBLIC_ORIGIN, "https://yolo.example.com");
  // And a domain instance stays one when init runs without flags.
  assert.equal((await h.yolo()).status, "ok");
  assert.equal(h.instance().domain, "yolo.example.com");
  assert.equal((await h.yolo({ "workers-dev": true })).status, "needs_approval");
});

test("an instance file with a domain is never turned into workers.dev by init alone", async (t) => {
  const h = harness(t);
  writeFileSync(h.p.instance, JSON.stringify({ version: 1, domain: "yolo.example.com" }));
  const result = await h.yolo({ "node-port": "9300" });
  assert.equal(result.status, "ok");
  assert.deepEqual(h.instance(), { version: 1, domain: "yolo.example.com", node: { port: 9300 } });
});
