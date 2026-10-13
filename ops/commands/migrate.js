import { deployContext } from "../lib/context.js";
import { applyMigrations, appliedMigrations, backupD1, localMigrations, restoreCommand } from "../lib/d1.js";
import { record } from "../lib/deployments.js";
import { overall } from "../lib/output.js";

export const summary = "Back up the remote D1 database, then apply this checkout's pending migrations";
export const usage = "migrate [--skip-backup]";
export const options = {
  "skip-backup": { type: "boolean" },
};

// The steps of one migration run; `label` names the backup file.
export async function migrateSteps(p, ctx, { skipBackup = false, label = "migrate", log = () => {} } = {}) {
  const steps = [];
  const local = localMigrations(p.migrations);
  const applied = await appliedMigrations(p, ctx.instance, ctx.env);
  if (!applied.ok) {
    steps.push({ id: "migrations", status: "fail", message: `Cannot read D1's migrations: ${applied.error}`, fix: "npm run yolo -- provision d1" });
    return steps;
  }
  const pending = local.filter((name) => !applied.names.includes(name));
  if (!pending.length) {
    steps.push({ id: "migrations", status: "unchanged", message: `D1 has every migration (${applied.names.at(-1) ?? "none"})` });
    return steps;
  }
  let backup = null;
  if (applied.names.length && !skipBackup) {
    log(`Backing up D1 before ${pending.join(", ")}…`);
    backup = await backupD1(p, ctx.instance, ctx.env, `before-${pending[0]}`);
    if (!backup.ok) {
      steps.push({ id: "backup", status: "fail", message: `The backup failed, so nothing was migrated: ${backup.error}`, fix: "npm run yolo -- doctor" });
      return steps;
    }
    steps.push({ id: "backup", status: "done", message: `Backed up D1 to ${backup.file}${backup.bookmark ? ` (Time Travel bookmark ${backup.bookmark})` : ""}` });
  } else if (!applied.names.length) {
    steps.push({ id: "backup", status: "info", message: "D1 is new: nothing to back up" });
  }
  log(`Applying ${pending.join(", ")}…`);
  const result = await applyMigrations(p, ctx.instance, ctx.env, { onOutput: (text) => log(text.trimEnd()) });
  record(p, { kind: "migrate", version: ctx.version, applied: result.ok ? pending : [], backup: backup?.file ?? null, bookmark: backup?.bookmark ?? null, ok: result.ok, error: result.error ?? null });
  steps.push(result.ok
    ? { id: "migrations", status: "done", message: `Applied ${pending.join(", ")}` }
    : { id: "migrations", status: "fail", message: `Applying the migrations failed: ${result.error}`, fix: backup?.bookmark ? `To return to the backup, after the owner approves: ${restoreCommand(ctx.instance, backup.bookmark)}` : "npm run yolo -- doctor" });
  return steps;
}

export async function run({ values, p }) {
  const ctx = await deployContext(p);
  if (!ctx.ok) return { command: "migrate", status: overall(ctx.steps), summary: "Not ready to migrate", steps: ctx.steps };
  const log = (line) => process.stderr.write(`${line}\n`);
  const steps = [...ctx.steps, ...(await migrateSteps(p, ctx, { skipBackup: Boolean(values["skip-backup"]), log }))];
  return { command: "migrate", status: overall(steps), summary: overall(steps) === "ok" ? "D1 is up to date" : "Migration stopped", steps };
}
