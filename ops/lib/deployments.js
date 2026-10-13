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
