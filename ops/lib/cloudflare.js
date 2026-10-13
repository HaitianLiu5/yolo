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
  const accounts = info.accounts ?? [];
  const wanted = instance.accountId || env.CLOUDFLARE_ACCOUNT_ID || null;
  if (wanted) {
    const account = accounts.find((entry) => entry.id === wanted);
    if (!account) return { status: "fail", message: `Wrangler's login cannot see account ${wanted}`, fix: "Sign in to the account that owns the instance (npx wrangler login), or fix accountId in the instance file", accountId: null, accounts };
    return { status: "ok", message: `Cloudflare account ${account.name} (${account.id})`, accountId: account.id, accounts };
  }
  if (accounts.length === 1) return { status: "ok", message: `Cloudflare account ${accounts[0].name} (${accounts[0].id})`, accountId: accounts[0].id, accounts, chosen: true };
  return {
    status: "needs_human",
    message: `Wrangler sees ${accounts.length} accounts: ${accounts.map((entry) => `${entry.name} (${entry.id})`).join(", ")}`,
    fix: "Ask the owner which account Yolo lives in, then: npm run yolo -- init --account-id <id>",
    accountId: null,
    accounts,
  };
}

export const withAccount = (env, accountId) => (accountId ? { ...env, CLOUDFLARE_ACCOUNT_ID: accountId } : env);
