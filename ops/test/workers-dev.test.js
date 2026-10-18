import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run as init } from "../commands/init.js";
import { readEnvFile } from "../lib/env-file.js";
import { paths } from "../lib/paths.js";

// `init` without a domain, on the account's workers.dev subdomain, with
// Cloudflare replaced (Agent Note 2026-10-13-no-domain-deployment). An origin
// change invalidates every passkey, so init never makes one unasked.

const ACCOUNT = "0123456789abcdef0123456789abcdef";

function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), "yolo-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = { ...paths(), instance: join(dir, "yolo.instance.json"), envFile: join(dir, ".env"), generated: join(dir, "wrangler.instance.jsonc") };
  const cf = { subdomain: "home-ab12cd", loggedIn: false, registered: [] };
  const deps = {
    account: async () => (cf.loggedIn
      ? { status: "ok", message: "Cloudflare account Owner", accountId: ACCOUNT, accounts: [{ id: ACCOUNT, name: "Owner" }], chosen: true, email: "owner@example.com" }
      : { status: "needs_human", message: "Wrangler is not signed in to Cloudflare", fix: "npm run yolo -- auth" }),
    api: async () => ({}),
    subdomain: async () => cf.subdomain,
    register: async (_api, _account, name) => (cf.registered.push(name), (cf.subdomain = name)),
  };
  return { p, cf, yolo: (values = {}) => init({ values, p, deps }), instance: () => JSON.parse(readFileSync(p.instance, "utf8")) };
}

test("init serves a new instance on workers.dev, and moves its origin or registers a subdomain only with the owner's approval", async (t) => {
  const h = harness(t);
  assert.equal((await h.yolo()).status, "needs_human", "before sign-in the local half is done");
  assert.match(h.instance().worker, /^yolo-[a-z0-9]{6}$/);
  h.cf.loggedIn = true;
  const done = await h.yolo();
  const { worker, host } = h.instance();
  assert.deepEqual([done.status, host, readEnvFile(h.p.envFile).PUBLIC_ORIGIN], ["ok", `${worker}.home-ab12cd.workers.dev`, `https://${host}`]);
  assert.ok(readEnvFile(h.p.envFile).NODE_SECRET);

  h.cf.subdomain = "renamed-77";
  const renamed = await h.yolo();
  assert.deepEqual([renamed.status, renamed.approve, h.instance().host], ["needs_approval", "npm run yolo -- init --change-domain", host]);
  assert.match(renamed.summary, /invalidates every passkey/);
  assert.equal((await h.yolo({ domain: "yolo.example.com" })).status, "needs_approval");

  h.cf.subdomain = null;
  writeFileSync(h.p.instance, JSON.stringify({ version: 1, domain: null, workersDev: true }));
  assert.equal((await h.yolo()).status, "needs_approval");
  assert.deepEqual(h.cf.registered, []);
  await h.yolo({ "workers-subdomain": "quiet-harbor" });
  assert.deepEqual(h.cf.registered, ["quiet-harbor"]);

  // A domain instance is never turned into workers.dev by init alone.
  writeFileSync(h.p.instance, JSON.stringify({ version: 1, domain: "yolo.example.com" }));
  assert.equal((await h.yolo({ "node-port": "9300" })).status, "ok");
  assert.deepEqual(h.instance(), { version: 1, domain: "yolo.example.com", node: { port: 9300 } });
});
