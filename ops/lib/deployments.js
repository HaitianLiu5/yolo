import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// .yolo/deployments.jsonl next to the instance file: one JSON line per
// deploy, migration, upgrade, and rollback, so a rollback knows the Worker
// version, git ref, and D1 backup to return to.

export function record(p, entry) {
  mkdirSync(dirname(p.deployments), { recursive: true });
  const line = { at: new Date().toISOString(), ...entry };
  appendFileSync(p.deployments, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  return line;
}

export function history(p) {
  if (!existsSync(p.deployments)) return [];
  return readFileSync(p.deployments, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function last(p, predicate) {
  return history(p).reverse().find(predicate) ?? null;
}

// The newest upgrade not already rolled back. An `upgrade-start` met before
// its `upgrade` is one that was cut off: it carries the same facts (`backup`
// among them; the starts earlier releases wrote, before anything changed,
// carry none and are passed over).
//
// `migrated` says whether the upgrade got as far as its migrations, which is
// when a rollback may need the old database back. An upgrade marks that with
// an `upgrade-migrate` record before it runs them, since a migration that
// fails or is cut off may have applied some. Records from releases that did
// not mark it (no `marksMigrate` on the start, no `migrated` on the
// `upgrade`) count as migrated, as rollback read them before.
export function lastUpgrade(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    // One that failed part way (`ok: false`) left the upgrade to roll back.
    if (entry.kind === "rollback" && entry.ok !== false) return null;
    if (entry.kind === "upgrade") return { ...entry, migrated: entry.migrated ?? true };
    if (entry.kind === "upgrade-start" && "backup" in entry) {
      const migrated = !entry.marksMigrate || entries.slice(index + 1).some((later) => later.kind === "upgrade-migrate" && later.to === entry.to);
      return { ...entry, migrated };
    }
  }
  return null;
}

// The upgrade to `target` that was cut off, or failed, and not finished
// since: the newest upgrade is its `upgrade-start` or an `upgrade` with
// `ok: false`, and no deploy of `target` succeeded after it (the last step
// of finishing one by hand). The checkout is then already on `target` with
// its migrations, node, or Worker possibly not done.
export function unfinishedUpgrade(entries, target) {
  const upgrade = lastUpgrade(entries);
  if (!upgrade || upgrade.to !== target) return null;
  if (upgrade.kind !== "upgrade-start" && !(upgrade.kind === "upgrade" && upgrade.ok === false)) return null;
  const since = entries.slice(entries.findLastIndex((entry) => entry.kind === upgrade.kind && entry.at === upgrade.at && entry.to === target) + 1);
  return since.some((entry) => entry.kind === "deploy" && entry.ok && entry.version === target) ? null : upgrade;
}
