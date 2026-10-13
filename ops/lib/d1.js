import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseJsonOutput, wrangler, wranglerError } from "./run.js";

// The instance's remote D1 database through wrangler and the rendered config.

// This checkout's migrations, named as D1 records them (no ".sql").
export function localMigrations(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => /^\d+_.*\.sql$/.test(name)).sort().map((name) => name.replace(/\.sql$/, "")) : [];
}

export async function appliedMigrations(p, instance, env) {
  const result = await wrangler(p, ["d1", "execute", instance.d1.name, "--remote", "--json", "--command", "SELECT name FROM d1_migrations ORDER BY id"], { env, timeoutMs: 60_000 });
  try {
    return { ok: true, names: parseJsonOutput(result.stdout)[0].results.map((row) => row.name) };
  } catch {
    const message = wranglerError(result);
    // A new database has no d1_migrations table until the first apply.
    if (/no such table: d1_migrations/i.test(`${result.stdout}${result.stderr}`)) return { ok: true, names: [] };
    return { ok: false, names: [], error: message };
  }
}

// An SQL export into .yolo/backups and the Time Travel bookmark of this
// moment; either alone can restore the database.
export async function backupD1(p, instance, env, label) {
  mkdirSync(p.backups, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(p.backups, `d1-${instance.d1.name}-${stamp}-${label}.sql`);
  const [exported, info] = await Promise.all([
    wrangler(p, ["d1", "export", instance.d1.name, "--remote", "--output", file], { env, timeoutMs: 10 * 60_000 }),
    wrangler(p, ["d1", "time-travel", "info", instance.d1.name, "--json"], { env, timeoutMs: 60_000 }),
  ]);
  let bookmark = null;
  try {
    bookmark = parseJsonOutput(info.stdout).bookmark ?? null;
  } catch {
    // Time Travel is best effort; the export is the backup.
  }
  if (exported.code !== 0) return { ok: false, file: null, bookmark, error: wranglerError(exported) };
  return { ok: true, file, bookmark };
}

export async function applyMigrations(p, instance, env, { onOutput } = {}) {
  const result = await wrangler(p, ["d1", "migrations", "apply", instance.d1.name, "--remote"], { env, timeoutMs: 10 * 60_000, onOutput });
  return result.code === 0 ? { ok: true } : { ok: false, error: wranglerError(result) };
}

export const restoreCommand = (instance, bookmark) => `npm run wrangler -- d1 time-travel restore ${instance.d1.name} --bookmark ${bookmark}`;
