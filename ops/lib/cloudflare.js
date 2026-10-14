import { parseJsonOutput, wrangler } from "./run.js";

// Who wrangler acts as, and in which account. Every command that changes
// Cloudflare resources goes through here first.

export const LOGIN_FIX = "A human signs wrangler in: `npx wrangler login` (approve in the browser). A headless agent uses an API token instead: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (permissions in skills/yolo-deploy)";

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
  const wanted = instance.accountId || env.CLOUDFLARE_ACCOUNT_ID || null;
  if (wanted) {
    const account = accounts.find((entry) => entry.id === wanted);
    if (!account) return { status: "fail", message: `Wrangler's login cannot see account ${wanted}`, fix: "Sign in to the account that owns the instance (npx wrangler login), or fix accountId in the instance file", accountId: null, accounts };
    return { status: "ok", message: `Cloudflare account ${account.name} (${account.id})`, accountId: account.id, accounts, email };
  }
  if (accounts.length === 1) return { status: "ok", message: `Cloudflare account ${accounts[0].name} (${accounts[0].id})`, accountId: accounts[0].id, accounts, chosen: true, email };
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
// CLOUDFLARE_API_TOKEN, or the OAuth token of `wrangler login`
// (`wrangler auth token`). CLOUDFLARE_API_BASE_URL moves it, as it moves
// wrangler, for tests.
export async function apiToken(p, env = process.env) {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN;
  const result = await wrangler(p, ["auth", "token", "--json"], { config: null, env, timeoutMs: 30_000 });
  try {
    return parseJsonOutput(result.stdout).token || null;
  } catch {
    return null;
  }
}

export class CloudflareApiError extends Error {
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
