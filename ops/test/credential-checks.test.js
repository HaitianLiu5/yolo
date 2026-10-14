import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialChecks } from "../lib/capabilities.js";
import { CloudflareApiError } from "../lib/cloudflare.js";
import { credentialSource } from "../lib/credentials.js";
import { withDefaults } from "../lib/instance.js";
import { ACCOUNT_PERMISSIONS, ZONE_PERMISSIONS } from "../lib/operator-token.js";
import { paths } from "../lib/paths.js";

// doctor's account of wrangler's credential: which one it is, and whether it
// can do each operation of the operator's commands
// (Agent Note 2026-10-13-agent-deployment).

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = { id: "aaaabbbbccccddddeeeeffff00001111", name: "example.com" };
const ALL = [...ACCOUNT_PERMISSIONS, ...ZONE_PERMISSIONS].map((entry) => entry.name);

// The API with reads that answer, except the paths in `denied`.
function fakeApi(denied = []) {
  const calls = [];
  return {
    calls,
    async call(path) {
      calls.push(path);
      if (denied.some((prefix) => path.startsWith(prefix))) throw new CloudflareApiError("Authentication error", { status: 403, codes: [10000] });
      if (path.startsWith("/zones?name=example.com")) return [ZONE];
      if (path.startsWith("/zones?")) return [];
      return [];
    },
  };
}

function scratch(t, record) {
  const dir = mkdtempSync(join(tmpdir(), "yolo-credential-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = paths({ env: { YOLO_INSTANCE: join(dir, "yolo.instance.json") } });
  if (record) {
    mkdirSync(p.state, { recursive: true });
    writeFileSync(p.cloudflareToken, JSON.stringify({ token: "secret-value", id: "tok_1", name: "Yolo operator", accountId: ACCOUNT, ...record }));
  }
  return p;
}

const byId = (checks) => Object.fromEntries(checks.map((check) => [check.id, check]));
const domain = withDefaults({ version: 1, domain: "yolo.example.com" });
const workersDev = withDefaults({ version: 1, domain: null, workersDev: true, host: "yolo-k3x9q2.home.workers.dev" });

test("doctor names the stored token, checks its permission groups, and reads each area with it", async (t) => {
  const p = scratch(t, { zone: ZONE, permissions: ALL });
  const source = credentialSource(p, {});
  const api = fakeApi();
  const checks = byId(await credentialChecks({ p, source, instance: domain, accountId: ACCOUNT, api }));
  assert.equal(checks["cloudflare.credential"].status, "ok");
  assert.match(checks["cloudflare.credential"].message, /^Wrangler acts with the account API token "Yolo operator" in .*cloudflare-token\.json/);
  for (const id of ["account", "workers", "d1", "kv", "tunnel", "vpc", "analytics", "zone"]) assert.equal(checks[`cloudflare.can.${id}`].status, "ok", id);
  assert.ok(api.calls.includes(`/accounts/${ACCOUNT}/cfd_tunnel?per_page=1`));
  assert.ok(api.calls.includes(`/zones/${ZONE.id}/workers/routes`));
  assert.doesNotMatch(JSON.stringify(checks), /secret-value/);
});

test("a token without a group, or made before the domain, fails the operations that need it", async (t) => {
  const p = scratch(t, { zone: null, permissions: ALL.filter((name) => name !== "Cloudflare Tunnel Write") });
  const checks = byId(await credentialChecks({ p, source: credentialSource(p, {}), instance: domain, accountId: ACCOUNT, api: fakeApi() }));
  assert.equal(checks["cloudflare.can.tunnel"].status, "fail");
  assert.match(checks["cloudflare.can.tunnel"].message, /lacks Cloudflare Tunnel Write/);
  assert.equal(checks["cloudflare.can.tunnel"].fix, "npm run yolo -- auth (sets the token's permissions; its value stays)");
  assert.equal(checks["cloudflare.can.zone"].status, "fail");
  assert.match(checks["cloudflare.can.zone"].message, /no zone permissions/);
  assert.equal(checks["cloudflare.can.d1"].status, "ok");

  // Cloudflare refusing a read fails that operation even with the group listed.
  const refused = byId(await credentialChecks({ p, source: credentialSource(p, {}), instance: workersDev, accountId: ACCOUNT, api: fakeApi([`/accounts/${ACCOUNT}/d1`]) }));
  assert.equal(refused["cloudflare.can.d1"].status, "fail");
  assert.match(refused["cloudflare.can.d1"].message, /Authentication error/);
  assert.equal(refused["cloudflare.can.zone"], undefined);
});

test("wrangler's own login is named, with what it cannot do", async (t) => {
  const p = scratch(t, null);
  const scopes = ["account:read", "workers_scripts:write", "workers_kv:write", "d1:write", "zone:read", "workers_routes:write"];
  const checks = byId(await credentialChecks({ p, source: credentialSource(p, {}), instance: domain, accountId: ACCOUNT, scopes, api: fakeApi() }));
  assert.equal(checks["cloudflare.credential"].status, "info");
  assert.match(checks["cloudflare.credential"].message, /wrangler's own login/);
  assert.match(checks["cloudflare.credential"].fix, /^npm run yolo -- auth/);
  assert.equal(checks["cloudflare.can.tunnel"].status, "warn");
  assert.equal(checks["cloudflare.can.vpc"].status, "fail");
  assert.match(checks["cloudflare.can.vpc"].message, /connectivity:admin/);
  assert.equal(checks["cloudflare.can.workers"].status, "ok");

  // An exported CLOUDFLARE_API_TOKEN wins over the stored one.
  const env = byId(await credentialChecks({ p, source: credentialSource(scratch(t, { permissions: ALL }), { CLOUDFLARE_API_TOKEN: "x" }), instance: workersDev, accountId: ACCOUNT, api: fakeApi() }));
  assert.match(env["cloudflare.credential"].message, /CLOUDFLARE_API_TOKEN from the environment/);
  assert.match(env["cloudflare.can.kv"].message, /write permission is not checked/);
});
