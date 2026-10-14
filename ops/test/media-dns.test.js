import assert from "node:assert/strict";
import { test } from "node:test";
import { CF_LOGIN, provisionMediaDns, SECRET, TOKEN_NAME, tokenTemplateUrl } from "../lib/media-dns.js";

// `provision media-dns` with a fake cf and a fake Worker
// (Agent Note 2026-10-13-no-domain-deployment).

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = { id: "aaaabbbbccccddddeeeeffff00001111", name: "example.com" };
const instance = { domain: "yolo.example.com", workersDev: false, accountId: ACCOUNT };
const VALUE = "token-value-never-shown";
const GROUPS = { "DNS Write": "4755a26eedb94da69e1066d98aa820be", "Zone Read": "c8fed203ed3043cba015a93ad1616f1f" };

function fakes({ scopes = ["account_api_tokens:create", "dns.write", "zone.read"], tokens = [], secrets = [] } = {}) {
  const calls = [];
  const stored = new Map(secrets.map((name) => [name, "old"]));
  const ok = (value) => ({ code: 0, stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: "" });
  const cf = async (args) => {
    calls.push(args);
    const [group, , action] = args;
    if (group === "auth") return ok({ authenticated: scopes !== null, scopes: scopes ?? [] });
    if (action === "list") return ok(tokens);
    if (action === "permission-groups") {
      const name = decodeURIComponent(args[args.indexOf("--name") + 1]);
      return ok([{ id: GROUPS[name], name, scopes: ["com.cloudflare.api.account.zone"] }]);
    }
    if (action === "create") return ok({ id: "tok_new", name: TOKEN_NAME, status: "active", value: VALUE });
    if (action === "roll") return ok(VALUE);
    if (action === "update") return ok({ id: args[3] });
    throw new Error(`unexpected cf ${args.join(" ")}`);
  };
  const worker = {
    list: async () => [...stored.keys()],
    put: async (name, value) => {
      stored.set(name, value);
      return { ok: true };
    },
  };
  return { cf, calls, worker, stored };
}

test("without a domain there is no zone and no token to make", async () => {
  const result = await provisionMediaDns({ instance: { domain: null, workersDev: true } }, {});
  assert.equal(result.status, "unchanged");
});

test("cf creates an account token for the zone only and the value goes straight to the Worker secret", async () => {
  const f = fakes();
  const result = await provisionMediaDns({ instance, zone: ZONE }, { cf: f.cf, secrets: f.worker });
  assert.equal(result.status, "done");
  assert.equal(f.stored.get(SECRET), VALUE);
  assert.equal(JSON.stringify(result).includes(VALUE), false);
  const create = f.calls.find((args) => args[2] === "create");
  assert.deepEqual(JSON.parse(create[create.indexOf("--policies") + 1]), [{
    effect: "allow",
    resources: { [`com.cloudflare.api.account.zone.${ZONE.id}`]: "*" },
    permission_groups: [{ id: GROUPS["DNS Write"] }, { id: GROUPS["Zone Read"] }],
  }]);
  assert.equal(create[create.indexOf("--name") + 1], TOKEN_NAME);

  // Run again: the Worker has the secret, nothing changes.
  const again = fakes({ secrets: [SECRET], tokens: [{ id: "tok_new", name: TOKEN_NAME, status: "active" }] });
  assert.equal((await provisionMediaDns({ instance, zone: ZONE }, { cf: again.cf, secrets: again.worker })).status, "unchanged");
  assert.deepEqual(again.calls, []);
});

test("an existing token of that name is rolled, and pointed at the zone first when it covers another", async () => {
  const elsewhere = { id: "tok_old", name: TOKEN_NAME, status: "active", policies: [{ effect: "allow", resources: { "com.cloudflare.api.account.zone.other": "*" } }] };
  const f = fakes({ tokens: [elsewhere], secrets: [SECRET] });
  const result = await provisionMediaDns({ instance, zone: ZONE, rotate: true }, { cf: f.cf, secrets: f.worker });
  assert.equal(result.status, "done");
  assert.deepEqual(f.calls.filter((args) => ["update", "roll", "create"].includes(args[2])).map((args) => args.slice(2, 4)), [["update", "tok_old"], ["roll", "tok_old"]]);
  assert.equal(f.stored.get(SECRET), VALUE);
});

test("without cf, or without the owner's consent, the owner gets the pre-filled dashboard page", async () => {
  const url = tokenTemplateUrl({ accountId: ACCOUNT, zoneId: ZONE.id });
  assert.equal(url, `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent('[{"key":"dns","type":"edit"},{"key":"zone","type":"read"}]')}&accountId=${ACCOUNT}&zoneId=${ZONE.id}&name=Yolo%20media%20DNS`);
  const noCf = await provisionMediaDns({ instance, zone: ZONE }, { cf: null, secrets: fakes().worker });
  assert.equal(noCf.status, "needs_human");
  assert.ok(noCf.fix.includes(url));
  assert.match(noCf.fix, /npm run wrangler -- secret put MEDIA_DNS_TOKEN/);
  const f = fakes({ scopes: ["zone.read"] });
  const noScopes = await provisionMediaDns({ instance, zone: ZONE }, { cf: f.cf, secrets: f.worker });
  assert.equal(noScopes.status, "needs_human");
  assert.ok(noScopes.fix.startsWith(CF_LOGIN));
  assert.match(noScopes.message, /account_api_tokens:create, dns.write/);
  assert.deepEqual(f.calls, [["auth", "whoami"]]);
});
