import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The credential wrangler acts with (Agent Note 2026-10-13-agent-deployment).
// `npm run yolo -- auth` stores one account API token in
// .yolo/cloudflare-token.json, mode 600, and every wrangler the operator's
// commands start (and `npm run wrangler`) gets it as CLOUDFLARE_API_TOKEN, so
// wrangler needs no browser login of its own. A CLOUDFLARE_API_TOKEN the
// owner exported wins over the file; without either, wrangler uses its own
// OAuth login (`wrangler login`).
//
// The file holds { token, id, name, accountId, zone: { id, name } | null,
// permissions: [names], updatedAt }. Only `token` is secret; nothing here
// prints it.

// What makes wrangler and cf act with an API token or key instead of a login.
export const CREDENTIAL_ENV = Object.freeze(["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "CLOUDFLARE_EMAIL", "CF_EMAIL"]);

export function withoutCredentials(env) {
  const clean = { ...env };
  for (const key of CREDENTIAL_ENV) delete clean[key];
  return clean;
}

const fromEnvironment = (env) => Boolean(env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || ((env.CLOUDFLARE_API_KEY || env.CF_API_KEY) && (env.CLOUDFLARE_EMAIL || env.CF_EMAIL)));

// The stored record, or null when there is none or it is unreadable.
export function readStoredToken(p) {
  if (!p.cloudflareToken || !existsSync(p.cloudflareToken)) return null;
  try {
    const record = JSON.parse(readFileSync(p.cloudflareToken, "utf8"));
    return typeof record?.token === "string" && record.token ? record : null;
  } catch {
    return null;
  }
}

// Writes through a temporary file, so a reader never sees half a token.
export function writeStoredToken(p, record) {
  mkdirSync(dirname(p.cloudflareToken), { recursive: true, mode: 0o700 });
  const temporary = `${p.cloudflareToken}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, p.cloudflareToken);
}

// `env` with the stored token as CLOUDFLARE_API_TOKEN (and its account as
// CLOUDFLARE_ACCOUNT_ID unless one is set), unless env already carries a
// credential of its own.
export function cloudflareEnv(p, env = process.env) {
  if (fromEnvironment(env)) return env;
  const stored = readStoredToken(p);
  if (!stored) return env;
  return {
    ...env,
    CLOUDFLARE_API_TOKEN: stored.token,
    ...(!env.CLOUDFLARE_ACCOUNT_ID && stored.accountId ? { CLOUDFLARE_ACCOUNT_ID: stored.accountId } : {}),
  };
}

// Which credential wrangler acts with, without its value:
// { kind: "env" | "file" | "login", record? }.
export function credentialSource(p, env = process.env) {
  if (fromEnvironment(env)) return { kind: "env" };
  const record = readStoredToken(p);
  if (record) {
    const { token: _token, ...rest } = record;
    return { kind: "file", record: rest };
  }
  return { kind: "login" };
}

export function describeCredential(p, source) {
  if (source.kind === "env") return "CLOUDFLARE_API_TOKEN from the environment";
  if (source.kind === "file") return `the account API token "${source.record.name ?? "Yolo"}" in ${p.cloudflareToken} (npm run yolo -- auth)`;
  return "wrangler's own login (wrangler login)";
}
