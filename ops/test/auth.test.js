import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { run as auth } from "../commands/auth.js";
import { parseDeviceLogin, verifyLink } from "../lib/cf.js";
import { cloudflareEnv } from "../lib/credentials.js";
import { renderText } from "../lib/output.js";
import { ROOT, paths } from "../lib/paths.js";

// `npm run yolo -- auth` with a fake cf on PATH and a fake Cloudflare API
// that the pinned wrangler talks to (Agent Note 2026-10-13-agent-deployment).
// Nothing reaches Cloudflare, and PATH holds no real cf, so no profile of
// the owner's is touched.

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = "aaaabbbbccccddddeeeeffff00001111";
const CODE = "WDJB-MJHT";
const LINK = `https://dash.cloudflare.com/oauth2/device/verify?user_code=${CODE}`;

// cf, as far as auth uses it. State lives in a JSON file; `auth create`
// prints the device page and code and waits until the test approves.
const FAKE_CF = String.raw`#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const file = process.env.FAKE_CF_STATE;
const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { login: null, tokens: {}, calls: [], next: 1 });
const save = (state) => writeFileSync(file, JSON.stringify(state));
let args = process.argv.slice(2);
let state = load();
state.calls.push({ args, sawToken: Boolean(process.env.CLOUDFLARE_API_TOKEN) });
save(state);
const out = (value) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
const fail = (message) => { process.stderr.write("┌ APIError\n│ " + message + "\n└\n"); process.exit(1); };
const flag = (name) => args[args.indexOf(name) + 1];
if (process.env.CLOUDFLARE_API_TOKEN) fail("You are logged in with an API Token. Unset the CLOUDFLARE_API_TOKEN");
if (args[0] === "--profile") args = args.slice(2);
const [group, sub, action, id] = args;
// Like cf, the account's commands need the account.
if (group === "accounts" && process.env.CLOUDFLARE_ACCOUNT_ID !== "${ACCOUNT}") fail("Could not determine the account: set CLOUDFLARE_ACCOUNT_ID");
if (group === "auth" && sub === "create") {
  process.stdout.write("Attempting to login via OAuth Device Authorization Grant...\nTo authorize Cloudflare CLI, please visit:\n\n  https://dash.cloudflare.com/oauth2/device/verify\n\nand enter the code:\n\n  ${CODE}\n\nYou have 5 minutes to approve this request.\n");
  const scopes = args.slice(args.indexOf("--scopes") + 1);
  const wait = () => {
    if (!existsSync(process.env.FAKE_CF_APPROVE)) return setTimeout(wait, 100);
    state = load();
    state.login = { scopes };
    save(state);
    process.stdout.write("Successfully logged in.\n");
  };
  wait();
} else if (group === "auth" && sub === "whoami") {
  out(state.login ? { authenticated: true, authSource: "OAuth token", tokenValid: true, email: "owner@example.com", accounts: [{ id: "${ACCOUNT}", name: "Owner" }], scopes: state.login.scopes } : { authenticated: false, error: "Not logged in" });
} else if (group === "zones" && sub === "list") {
  out(flag("--name") === "example.com" ? [{ id: "${ZONE}", name: "example.com" }] : []);
} else if (group === "accounts" && sub === "tokens" && action === "permission-groups") {
  const name = decodeURIComponent(flag("--name"));
  out([{ id: "pg-" + name.toLowerCase().replace(/[^a-z]+/g, "-"), name }]);
} else if (group === "accounts" && sub === "tokens" && action === "create") {
  const token = { id: "tok_" + state.next, name: flag("--name"), status: "active", policies: JSON.parse(flag("--policies")), value: "secret-value-" + state.next++ };
  state.tokens[token.id] = token;
  save(state);
  out(token);
} else if (group === "accounts" && sub === "tokens" && action === "get") {
  const token = state.tokens[id];
  if (!token) fail("[1003] Token not found");
  const { value, ...rest } = token;
  out(rest);
} else if (group === "accounts" && sub === "tokens" && action === "update") {
  Object.assign(state.tokens[id], { name: flag("--name"), policies: JSON.parse(flag("--policies")) });
  save(state);
  out({ id });
} else if (group === "accounts" && sub === "tokens" && action === "roll") {
  state.tokens[id].value = "secret-value-" + state.next++;
  save(state);
  out(state.tokens[id].value);
} else {
  fail("unexpected cf " + args.join(" "));
}
`;

// The Cloudflare API: tokens/verify for the stored value, and what wrangler
// whoami asks with an account-owned token.
async function fakeApi(t, state) {
  const seen = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    seen.push({ path: url.pathname, bearer });
    const valid = Object.values(state().tokens).some((token) => token.value === bearer);
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ errors: [], messages: [], ...body }));
    };
    const error = (status, code, message) => send(status, { success: false, errors: [{ code, message }], result: null });
    if (!valid) return error(401, 1000, "Invalid API Token");
    const path = url.pathname.replace(/^\/client\/v4/, "");
    if (path === `/accounts/${ACCOUNT}/tokens/verify`) return send(200, { success: true, result: { id: "tok", status: "active" } });
    if (path === "/user/tokens/verify") return error(401, 1000, "Invalid API Token");
    if (path === "/user") return error(403, 9109, "Unauthorized to access requested resource");
    if (path === "/memberships") return error(403, 10000, "Authentication error");
    if (path === "/accounts") return send(200, { success: true, result: [{ id: ACCOUNT, name: "Owner" }], result_info: { page: 1, per_page: 20, count: 1, total_count: 1, total_pages: 1 } });
    return error(404, 7003, `No route for ${path}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}/client/v4`, seen };
}

function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), "yolo-auth-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "cf"), FAKE_CF);
  chmodSync(join(bin, "cf"), 0o755);
  const stateFile = join(dir, "cf-state.json");
  const approve = join(dir, "approved");
  const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
  t.after(() => {
    // A device login the test never approved.
    try {
      const pending = JSON.parse(readFileSync(join(dir, ".yolo/cf-login.json"), "utf8"));
      process.kill(pending.pid);
    } catch {
      // None left.
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const p = paths({ env: { YOLO_INSTANCE: join(dir, "yolo.instance.json") } });
  return { dir, bin, p, state, stateFile, approve };
}

const lines = [];
const yolo = (h, env, values = {}) => auth({ values, p: h.p, env, deps: { log: (line) => lines.push(line), sleep: async () => {} } });

test("cf's device login gives the owner a link with the code filled in, then one account token that wrangler uses", { timeout: 120_000 }, async (t) => {
  const h = harness(t);
  const api = await fakeApi(t, () => (existsSync(h.stateFile) ? h.state() : { tokens: {} }));
  const home = join(h.dir, "home");
  // No real cf on PATH: only the fake, node, and the system's tools.
  const env = {
    PATH: [h.bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CLOUDFLARE_API_BASE_URL: api.base,
    WRANGLER_HIDE_BANNER: "true",
    FAKE_CF_STATE: h.stateFile,
    FAKE_CF_APPROVE: h.approve,
  };

  // 1. Not signed in: the link, at once, while cf waits in the background.
  const asked = await yolo(h, env);
  assert.equal(asked.status, "needs_human");
  assert.equal(asked.link, LINK);
  assert.equal(asked.code, CODE);
  assert.ok(renderText(asked).includes(LINK));
  assert.match(asked.steps.find((step) => step.id === "login").message, new RegExp(`${LINK.replace(/[?]/g, "\\?")} on any device, a phone included.*code ${CODE}`));
  // Run again before the approval: the same link, no second login.
  const again = await yolo(h, env);
  assert.equal(again.link, LINK);
  const creates = (state) => state.calls.filter((call) => call.args[0] === "auth" && call.args[1] === "create");
  assert.equal(creates(h.state()).length, 1);
  assert.deepEqual(creates(h.state())[0].args.slice(0, 5), ["auth", "create", "yolo", "--no-browser", "--device"]);

  // 2. The owner approves on the phone; the next run makes the token.
  writeFileSync(h.approve, "");
  for (let i = 0; i < 100 && !h.state().login; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  const signed = await yolo(h, env);
  assert.equal(signed.status, "ok", renderText(signed));
  const stored = JSON.parse(readFileSync(h.p.cloudflareToken, "utf8"));
  assert.equal(statSync(h.p.cloudflareToken).mode & 0o777, 0o600);
  assert.deepEqual([stored.token, stored.id, stored.accountId, stored.zone], ["secret-value-1", "tok_1", ACCOUNT, null]);
  const created = h.state().tokens.tok_1;
  assert.deepEqual(created.policies, [{
    effect: "allow",
    resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" },
    permission_groups: ["account-settings-read", "workers-scripts-write", "workers-kv-storage-write", "d-write", "cloudflare-tunnel-write", "connectivity-directory-admin", "account-analytics-read"].map((id) => ({ id: `pg-${id}` })),
  }]);
  // Checked with a harmless read, then through wrangler, which got the
  // stored token from the wrapper: the environment carried none.
  assert.ok(api.seen.some((request) => request.path.endsWith(`/accounts/${ACCOUNT}/tokens/verify`) && request.bearer === "secret-value-1"));
  assert.ok(api.seen.some((request) => request.path === "/client/v4/accounts" && request.bearer === "secret-value-1"));
  assert.equal(signed.steps.find((step) => step.id === "wrangler").status, "ok");
  assert.match(signed.next[0], /npm run yolo -- init/);
  assert.equal(existsSync(h.p.cfLogin), false);

  // 3. Run again, with a token the owner exported: nothing changes, cf
  // never sees a token, and the check still uses the stored one.
  const same = await yolo(h, { ...env, CLOUDFLARE_API_TOKEN: "exported-by-owner" });
  assert.equal(same.steps.find((step) => step.id === "token").status, "unchanged");
  assert.equal(same.steps.find((step) => step.id === "env").status, "warn");
  assert.equal(Object.keys(h.state().tokens).length, 1);

  // 4. A domain: the same token gains the zone, and keeps its value.
  writeFileSync(h.p.instance, JSON.stringify({ version: 1, domain: "yolo.example.com" }));
  const zoned = await yolo(h, env);
  assert.equal(zoned.status, "ok", renderText(zoned));
  assert.match(zoned.steps.find((step) => step.id === "token").message, /value is unchanged/);
  assert.deepEqual(h.state().tokens.tok_1.policies[1], {
    effect: "allow",
    resources: { [`com.cloudflare.api.account.zone.${ZONE}`]: "*" },
    permission_groups: [{ id: "pg-zone-read" }, { id: "pg-workers-routes-write" }, { id: "pg-dns-write" }],
  });
  assert.deepEqual(JSON.parse(readFileSync(h.p.cloudflareToken, "utf8")).zone, { id: ZONE, name: "example.com" });
  assert.equal(JSON.parse(readFileSync(h.p.instance, "utf8")).accountId, ACCOUNT);

  // 5. --rotate rolls the value.
  const rolled = await yolo(h, env, { rotate: true });
  assert.equal(rolled.status, "ok", renderText(rolled));
  assert.equal(JSON.parse(readFileSync(h.p.cloudflareToken, "utf8")).token, "secret-value-2");

  // `npm run wrangler` passes the stored token too.
  const child = spawn(process.execPath, [join(ROOT, "ops/wrangler.js"), "--fallback-template", "whoami", "--json"], { env: { ...env, YOLO_INSTANCE: h.p.instance }, stdio: "ignore" });
  assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 0);
  assert.ok(api.seen.some((request) => request.path === "/client/v4/accounts" && request.bearer === "secret-value-2"));

  // No value ever reached the output, and cf never ran with a token.
  for (const result of [asked, again, signed, same, zoned, rolled]) {
    for (const text of [JSON.stringify(result), renderText(result)]) assert.doesNotMatch(text, /secret-value|exported-by-owner/);
  }
  assert.doesNotMatch(lines.join("\n"), /secret-value/);
  assert.equal(h.state().calls.some((call) => call.sawToken), false);
});

test("without cf, auth names the install command and the fallback", async (t) => {
  const h = harness(t);
  const result = await yolo(h, { PATH: h.dir });
  assert.equal(result.status, "failed");
  assert.match(result.steps[0].fix, /^npm install -g cf, then npm run yolo -- auth; without cf, npx wrangler login --device/);
});

test("the device page and code come from cf's output, and only a cloudflare.com page is passed on", () => {
  const text = "To authorize Cloudflare CLI, please visit:\n\n  https://dash.cloudflare.com/oauth2/device/verify\n\nand enter the code:\n\n  WDJB-MJHT\n\nYou have 5 minutes to approve this request.\n";
  assert.deepEqual(parseDeviceLogin(text), { page: "https://dash.cloudflare.com/oauth2/device/verify", code: CODE, link: LINK, expires: "5 minutes" });
  assert.equal(verifyLink("AB CD"), "https://dash.cloudflare.com/oauth2/device/verify?user_code=AB+CD");
  assert.equal(parseDeviceLogin(text.replace("dash.cloudflare.com", "dash.cloudflare.com.evil.example")), null);
  assert.equal(parseDeviceLogin("Attempting to login via OAuth Device Authorization Grant..."), null);
});

test("wrangler gets the stored token unless the environment carries a credential", (t) => {
  const h = harness(t);
  mkdirSync(h.p.state, { recursive: true });
  assert.deepEqual(cloudflareEnv(h.p, { A: "1" }), { A: "1" });
  writeFileSync(h.p.cloudflareToken, JSON.stringify({ token: "stored", accountId: ACCOUNT }));
  assert.deepEqual(cloudflareEnv(h.p, { A: "1" }), { A: "1", CLOUDFLARE_API_TOKEN: "stored", CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  assert.deepEqual(cloudflareEnv(h.p, { CLOUDFLARE_ACCOUNT_ID: "other" }).CLOUDFLARE_ACCOUNT_ID, "other");
  assert.equal(cloudflareEnv(h.p, { CLOUDFLARE_API_TOKEN: "exported" }).CLOUDFLARE_API_TOKEN, "exported");
});
