import { cloudflareEnv } from "./credentials.js";
import { parseJsonOutput, wrangler } from "./run.js";

// Who wrangler acts as, and in which account. Every command that changes
// Cloudflare resources goes through here first.

// The login works from any device: `auth` prints a link with the code filled
// in, which the owner opens on a phone (Agent Note 2026-10-13-agent-deployment).
export const LOGIN_FIX = "npm run yolo -- auth: it prints a link the owner approves on any device, a phone included, then gives wrangler an account API token (without cf: npx wrangler login --device)";

// { status, message, fix, accountId, accounts } where status is ok,
// needs_human (not signed in, or several accounts and none chosen), or fail.
export async function cloudflareAccount(p, instance, env = process.env) {
  const result = await wrangler(p, ["whoami", "--json"], { config: null, env, timeoutMs: 30_000 });
  let info = null;
  try {
    info = parseJsonOutput(result.stdout);
  } catch {
    // Not JSON: not signed in, or no network.
  }
  if (!info?.loggedIn) {
    return { status: "needs_human", message: "Wrangler is not signed in to Cloudflare", fix: LOGIN_FIX, accountId: null, accounts: [] };
  }
  const email = info.email ?? null;
  const accounts = info.accounts ?? [];
  // The OAuth scopes of `wrangler login`; an API token lists none.
  const scopes = Array.isArray(info.tokenPermissions) ? info.tokenPermissions : null;
  const wanted = instance.accountId || env.CLOUDFLARE_ACCOUNT_ID || null;
  if (wanted) {
    const account = accounts.find((entry) => entry.id === wanted);
    if (!account) return { status: "fail", message: `Wrangler's credential cannot see account ${wanted}`, fix: "npm run yolo -- auth in the account that owns the instance, or fix accountId in the instance file", accountId: null, accounts };
    return { status: "ok", message: `Cloudflare account ${account.name} (${account.id})`, accountId: account.id, accounts, email, scopes };
  }
  if (accounts.length === 1) return { status: "ok", message: `Cloudflare account ${accounts[0].name} (${accounts[0].id})`, accountId: accounts[0].id, accounts, chosen: true, email, scopes };
  return {
    status: "needs_human",
    message: `Wrangler sees ${accounts.length} accounts: ${accounts.map((entry) => `${entry.name} (${entry.id})`).join(", ")}`,
    fix: "Ask the owner which account Yolo lives in, then: npm run yolo -- init --account-id <id>",
    accountId: null,
    accounts,
  };
}

export const withAccount = (env, accountId) => (accountId ? { ...env, CLOUDFLARE_ACCOUNT_ID: accountId } : env);

// The Cloudflare API with the credentials wrangler acts with: the API token in
// CLOUDFLARE_API_TOKEN or of `npm run yolo -- auth`, or the OAuth token of
// `wrangler login` (`wrangler auth token`). CLOUDFLARE_API_BASE_URL moves it,
// as it moves wrangler, for tests.
export async function apiToken(p, env = process.env) {
  const token = cloudflareEnv(p, env).CLOUDFLARE_API_TOKEN;
  if (token) return token;
  const result = await wrangler(p, ["auth", "token", "--json"], { config: null, env, timeoutMs: 30_000 });
  try {
    return parseJsonOutput(result.stdout).token || null;
  } catch {
    return null;
  }
}

class CloudflareApiError extends Error {
  constructor(message, { status, codes = [] } = {}) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
    this.codes = codes;
  }
}

// `call(path, { method, body })` → the response's `result`, or a
// CloudflareApiError; `graphql(query, variables)` → its `data`.
export function cloudflareApi(token, { env = process.env, fetchImpl = fetch } = {}) {
  const base = env.CLOUDFLARE_API_BASE_URL || "https://api.cloudflare.com/client/v4";
  const send = async (path, { method = "GET", body } = {}) => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await response.json().catch(() => null);
    return { response, json };
  };
  return {
    async call(path, options) {
      const { response, json } = await send(path, options);
      if (json?.success) return json.result;
      const errors = json?.errors ?? [];
      throw new CloudflareApiError(errors.map((error) => error.message).join("; ") || `HTTP ${response.status}`, { status: response.status, codes: errors.map((error) => error.code) });
    },
    async graphql(query, variables) {
      const { response, json } = await send("/graphql", { method: "POST", body: { query, variables } });
      if (json?.data && !json.errors?.length) return json.data;
      throw new CloudflareApiError(json?.errors?.map((error) => error.message).join("; ") || `HTTP ${response.status}`, { status: response.status });
    },
  };
}

// The account's workers.dev subdomain, or null when it has none yet. Reading
// it changes nothing; registering one is public and permanent, so only an
// approved `init --workers-subdomain` calls registerWorkersSubdomain.
export async function workersSubdomain(api, accountId) {
  try {
    const result = await api.call(`/accounts/${accountId}/workers/subdomain`);
    return result?.subdomain || null;
  } catch (error) {
    if (error.status === 404 || error.codes?.includes(10007) || /not found|no subdomain/i.test(error.message)) return null;
    throw error;
  }
}

export async function registerWorkersSubdomain(api, accountId, subdomain) {
  const result = await api.call(`/accounts/${accountId}/workers/subdomain`, { method: "PUT", body: { subdomain } });
  return result?.subdomain || subdomain;
}

// The zone in `accountId` that holds `host`: the longest suffix of it that is
// a zone there, as { id, name }, or null.
export async function zoneFor(api, accountId, host) {
  const labels = String(host).toLowerCase().split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    const name = labels.slice(index).join(".");
    const zones = await api.call(`/zones?name=${encodeURIComponent(name)}&account.id=${accountId}`);
    const zone = (zones ?? []).find((entry) => entry.name === name);
    if (zone) return { id: zone.id, name: zone.name };
  }
  return null;
}
