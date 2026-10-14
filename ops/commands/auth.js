import { existsSync } from "node:fs";
import { cfError, CF_INSTALL, CF_PROFILE, cfPath, cfRunner, finishDeviceLogin, hasPendingLogin, parseCf, startDeviceLogin, waitForDeviceLogin } from "../lib/cf.js";
import { cloudflareAccount, cloudflareApi } from "../lib/cloudflare.js";
import { credentialSource, readStoredToken, withoutCredentials, writeStoredToken } from "../lib/credentials.js";
import { readInstance, setField, withDefaults, writeInstance } from "../lib/instance.js";
import { ensureOperatorToken, findZone, LOGIN_SCOPES } from "../lib/operator-token.js";
import { overall } from "../lib/output.js";

// Cloudflare access for the operator's commands, from any device
// (Agent Note 2026-10-13-agent-deployment): cf's "yolo" profile signs in with
// the OAuth device grant, whose page the owner approves on a phone as well
// as on this machine, then cf makes one account API token that wrangler uses
// from .yolo/cloudflare-token.json. No step needs `wrangler login`.
//
// The device login runs in the background, so the command returns the link
// at once (exit 3); run again after the owner approves, it makes the token.
// --wait instead waits for the approval, for a person at a terminal.

export const summary = "Sign in to Cloudflare from any device, a phone included (cf's device login), and give wrangler an account API token in .yolo/ (idempotent; --rotate rolls it)";
export const usage = "auth [--account-id <id>] [--rotate] [--wait]";
export const options = {
  "account-id": { type: "string" },
  rotate: { type: "boolean" },
  wait: { type: "boolean" },
};

const MANUAL = `cf auth create ${CF_PROFILE} --no-browser --scopes ${LOGIN_SCOPES.join(" ")}`;
const FALLBACK = "without cf, npx wrangler login --device prints a link and a code the same way (the tunnel is then made in the dashboard)";

// The profile's login: { signedIn, missing: [scopes], accounts, email }.
async function profileLogin(cf) {
  const who = await cf(["auth", "whoami"]);
  const value = parseCf(who.stdout);
  const signedIn = value?.authenticated === true && value.tokenValid !== false;
  const scopes = Array.isArray(value?.scopes) ? value.scopes : null;
  const missing = signedIn && scopes ? LOGIN_SCOPES.filter((scope) => !scopes.includes(scope)) : [];
  const accounts = (Array.isArray(value?.accounts) ? value.accounts : [])
    .map((entry) => ({ id: entry?.id ?? entry?.account?.id, name: entry?.name ?? entry?.account?.name ?? "" }))
    .filter((entry) => entry.id);
  return { signedIn, missing, accounts, email: value?.email ?? null };
}

export async function run({ values, p, env = process.env, deps = {} }) {
  const command = "auth";
  const steps = [];
  const log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
  const done = (status, summary, extra = {}) => ({ command, status, summary, steps, ...extra });

  const path = cfPath(env);
  if (!path) {
    steps.push({ id: "cf", status: "fail", message: "cf, Cloudflare's CLI, is not installed", fix: `${CF_INSTALL}, then npm run yolo -- auth; ${FALLBACK}` });
    return done("failed", `Install cf first: ${CF_INSTALL}`);
  }
  steps.push({ id: "cf", status: "ok", message: `cf at ${path}` });
  const cf = cfRunner(env, { path });

  const current = readInstance(p.instance);
  if (current.error) return done("failed", current.error);
  const raw = current.exists ? current.raw : null;
  const instance = raw ? withDefaults(raw) : null;
  const domain = instance && !instance.workersDev ? instance.domain : null;
  const stored = readStoredToken(p);

  // --- The device login -----------------------------------------------------
  // A login that just ended counts even if Cloudflare names the scopes
  // differently, so a mismatch never asks the owner twice.
  const ended = existsSync(p.cfLogin) && !hasPendingLogin(p);
  let login = await profileLogin(cf);
  if (!login.signedIn || (login.missing.length && !ended)) {
    if (ended && !login.signedIn) {
      const text = finishDeviceLogin(p);
      steps.push({ id: "login", status: "info", message: `The last device login ended without an approval: ${cfError({ stdout: text })}` });
    }
    const why = login.signedIn ? `cf's "${CF_PROFILE}" profile lacks ${login.missing.join(", ")}` : `cf's "${CF_PROFILE}" profile is not signed in`;
    const started = await startDeviceLogin(p, { path, env, scopes: LOGIN_SCOPES, now: deps.now, waitMs: deps.waitMs });
    if (started.status !== "pending") {
      steps.push({ id: "login", status: "fail", message: `${why}, and cf could not start its device login: ${started.error}`, fix: `The owner runs ${MANUAL}, then npm run yolo -- auth; ${FALLBACK}` });
      return done("failed", "cf's device login did not start");
    }
    const ask = {
      id: "login",
      status: "needs_human",
      message: `${why}. The owner opens ${started.link} on any device, a phone included, signs in to Cloudflare, and approves (code ${started.code}, valid for ${started.expires ?? "5 minutes"}).`,
      fix: "After the owner approves, run npm run yolo -- auth again",
    };
    if (!values.wait) {
      steps.push(ask);
      return done("needs_human", `Give the owner this link and code: ${started.link} (code ${started.code})`, { link: started.link, code: started.code, next: ["npm run yolo -- auth, after the owner approves"] });
    }
    log(`\nOpen ${started.link} on any device, a phone included, and approve (code ${started.code}). Waiting…\n`);
    await waitForDeviceLogin(p, { now: deps.now });
    login = await profileLogin(cf);
    if (!login.signedIn) {
      const text = finishDeviceLogin(p);
      steps.push({ id: "login", status: "fail", message: `The device login ended without an approval: ${cfError({ stdout: text })}`, fix: "npm run yolo -- auth (a new link)" });
      return done("failed", "Not signed in");
    }
  }
  if (existsSync(p.cfLogin)) finishDeviceLogin(p);
  steps.push({ id: "login", status: "ok", message: `cf's "${CF_PROFILE}" profile is signed in${login.email ? ` as ${login.email}` : ""}` });
  if (login.missing.length) steps.push({ id: "login.scopes", status: "warn", message: `cf does not list ${login.missing.join(", ")} among the profile's scopes; if the token below fails with error 1001, run: ${MANUAL}` });

  // --- The account and the zone -------------------------------------------------
  const flag = values["account-id"] ?? null;
  if (flag && instance?.accountId && flag !== instance.accountId) {
    steps.push({ id: "account", status: "fail", message: `The instance is in account ${instance.accountId}, not ${flag}`, fix: "Drop --account-id, or fix accountId in the instance file" });
    return done("failed", "Two accounts named");
  }
  const wanted = flag ?? instance?.accountId ?? stored?.accountId ?? null;
  let account = wanted ? login.accounts.find((entry) => entry.id === wanted) ?? (login.accounts.length ? null : { id: wanted, name: "" }) : null;
  if (wanted && !account) {
    steps.push({ id: "account", status: "fail", message: `cf's login cannot see account ${wanted}; it sees ${login.accounts.map((entry) => `${entry.name} (${entry.id})`).join(", ")}`, fix: `The owner signs in to the account that holds Yolo: cf auth delete ${CF_PROFILE}, then npm run yolo -- auth` });
    return done("failed", "Wrong Cloudflare account");
  }
  if (!account) {
    if (login.accounts.length !== 1) {
      steps.push({
        id: "account",
        status: login.accounts.length ? "needs_human" : "fail",
        message: login.accounts.length ? `cf sees ${login.accounts.length} accounts: ${login.accounts.map((entry) => `${entry.name} (${entry.id})`).join(", ")}` : "cf sees no Cloudflare account",
        fix: login.accounts.length ? "Ask the owner which account Yolo lives in, then: npm run yolo -- auth --account-id <id>" : "npm run yolo -- auth --account-id <id>",
      });
      return done(overall(steps), "Choose the Cloudflare account");
    }
    account = login.accounts[0];
  }
  steps.push({ id: "account", status: "ok", message: `Cloudflare account ${account.name ? `${account.name} (${account.id})` : account.id}` });
  if (raw && !raw.accountId) {
    setField(raw, "accountId", account.id);
    writeInstance(p.instance, raw);
    steps.push({ id: "instance", status: "done", message: `Recorded the account in ${p.instance}` });
  }

  // cf's account commands act on CLOUDFLARE_ACCOUNT_ID.
  const cfAccount = cfRunner({ ...env, CLOUDFLARE_ACCOUNT_ID: account.id }, { path });
  let zone = null;
  if (domain) {
    const found = await findZone(cfAccount, account.id, domain);
    if (found.error) {
      steps.push({ id: "zone", status: "fail", message: `Cannot list the account's zones: ${found.error}`, fix: "npm run yolo -- auth" });
      return done("failed", "No zone");
    }
    if (!found.zone) {
      steps.push({ id: "zone", status: "fail", message: `No zone in account ${account.id} holds ${domain}`, fix: "The domain's DNS must be on Cloudflare in this account (skills/yolo-deploy, H2)" });
      return done("failed", "No zone");
    }
    zone = found.zone;
    steps.push({ id: "zone", status: "ok", message: `${domain} is in the zone ${zone.name} (${zone.id})` });
  }

  // --- The token -----------------------------------------------------------------
  const ensured = await ensureOperatorToken({ accountId: account.id, zone, worker: raw?.worker ?? null, stored, rotate: Boolean(values.rotate) }, { cf: cfAccount });
  steps.push({ id: "token", ...ensured.step });
  if (ensured.step.status === "fail") return done("failed", "No API token for wrangler");
  if (ensured.record) {
    writeStoredToken(p, ensured.record);
    steps.push({ id: "store", status: "done", message: `Stored it in ${p.cloudflareToken} (mode 600); its value was not printed` });
  }
  const token = ensured.record?.token ?? stored.token;

  // --- A harmless read with it, then wrangler's own view --------------------------
  const api = deps.api ?? cloudflareApi(token, { env });
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let verified = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3 && !verified; attempt += 1) {
    try {
      verified = await api.call(`/accounts/${account.id}/tokens/verify`);
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }
  if (verified?.status !== "active") {
    steps.push({ id: "verify", status: "fail", message: `Cloudflare does not accept the token: ${lastError?.message ?? `status ${verified?.status}`}`, fix: "npm run yolo -- auth --rotate" });
    return done("failed", "The token does not work");
  }
  steps.push({ id: "verify", status: "ok", message: "Cloudflare accepts the token (a read of its own status)" });
  // The stored token, even where the environment carries another credential.
  const seen = await cloudflareAccount(p, { accountId: account.id }, withoutCredentials(env));
  if (seen.status !== "ok") {
    steps.push({ id: "wrangler", status: "fail", message: `Wrangler with the token: ${seen.message}`, fix: `${seen.fix ?? "npm run yolo -- doctor"}; removing ${p.cloudflareToken} returns wrangler to its own login` });
    return done("failed", "Wrangler cannot use the token");
  }
  steps.push({ id: "wrangler", status: "ok", message: `Wrangler acts with the token: ${seen.message}` });
  if (credentialSource(p, env).kind === "env") {
    steps.push({ id: "env", status: "warn", message: "CLOUDFLARE_API_TOKEN (or a key) is set in this environment, so wrangler uses it instead of the stored token", fix: "Unset it before running the operator's commands" });
  }

  const status = overall(steps);
  return done(status, status === "ok" ? `Wrangler uses the account API token in ${p.cloudflareToken}; no browser login is needed for the operator's commands` : "Signed in, with warnings", {
    next: !instance
      ? ["npm run yolo -- init (workers.dev) or npm run yolo -- init --domain <host>; with a domain, run npm run yolo -- auth again to add the zone (no new approval)"]
      : ["npm run yolo -- provision", "npm run yolo -- doctor"],
  });
}
