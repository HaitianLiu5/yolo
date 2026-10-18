import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deployContext } from "../lib/context.js";
import { restoreCommand } from "../lib/d1.js";
import { history, record } from "../lib/deployments.js";
import { readEnvFile } from "../lib/env-file.js";
import { waitForNode } from "../lib/node-health.js";
import { overall } from "../lib/output.js";
import { run as exec, wrangler, wranglerError } from "../lib/run.js";
import { restartService, serviceStatus } from "../lib/service.js";
import { cli } from "./upgrade.js";

export const summary = "Return to the release before the last upgrade: the Worker version, the checkout, and the node (D1 only when asked)";
export const usage = "rollback [--approve] [--restore-d1]";
export const options = {
  approve: { type: "boolean" },
  "restore-d1": { type: "boolean" },
};

// The newest upgrade not already rolled back.
function lastUpgrade(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind === "rollback") return null;
    if (entry.kind === "upgrade") return entry;
  }
  return null;
}

export async function run({ values, p }) {
  const command = "rollback";
  const log = (line) => line && process.stderr.write(`${line}\n`);
  const steps = [];
  const upgrade = lastUpgrade(history(p));
  if (!upgrade) {
    return { command, status: "failed", summary: `No upgrade to roll back in ${p.deployments}`, next: ["A single bad deploy: npm run wrangler -- rollback (Cloudflare lists the Worker's versions)"] };
  }
  const ctx = await deployContext(p);
  steps.push(...ctx.steps);
  if (!ctx.ok) return { command, status: overall(ctx.steps), summary: "The instance is not ready to roll back", steps };

  const restore = Boolean(values["restore-d1"]);
  const node = await serviceStatus(ctx.instance.services.node);
  const plan = [
    upgrade.workerVersionId ? `Roll the Worker back to version ${upgrade.workerVersionId} (v${upgrade.from})` : "No earlier Worker version was recorded: redeploy from the old checkout instead",
    restore && upgrade.bookmark ? `Restore D1 to the bookmark taken before the upgrade (${upgrade.bookmark}); changes since then are lost` : upgrade.rollback === "restore" ? `D1 stays as it is, but v${upgrade.to}'s notes say v${upgrade.from} needs the old database: add --restore-d1` : `D1 stays as it is: v${upgrade.from} runs on it`,
    `Check out ${upgrade.fromCommit.slice(0, 7)} (v${upgrade.from}) here and run npm ci`,
    node.loaded ? `Restart the node service ${ctx.instance.services.node}` : "Restart the node yourself",
    "Run npm run yolo -- doctor",
  ];
  if (!values.approve) {
    return {
      command,
      status: "needs_approval",
      summary: `Roll back v${upgrade.to} → v${upgrade.from}. Show the owner this plan and ask for approval.`,
      rollback: { from: upgrade.to, to: upgrade.from, workerVersionId: upgrade.workerVersionId, backup: upgrade.backup, bookmark: upgrade.bookmark, restoreAdvised: upgrade.rollback === "restore" },
      plan,
      steps,
      approve: `npm run yolo -- rollback --approve${upgrade.rollback === "restore" ? " --restore-d1" : ""}`,
    };
  }

  // The Worker first: the newer node still accepts the older protocol.
  if (upgrade.workerVersionId) {
    const rolled = await wrangler(p, ["rollback", upgrade.workerVersionId, "--message", `Roll back to v${upgrade.from}`, "--yes"], { env: ctx.env, timeoutMs: 5 * 60_000, onOutput: (text) => log(text.trimEnd()) });
    steps.push(rolled.code === 0 ? { id: "worker", status: "done", message: `The Worker serves version ${upgrade.workerVersionId} again` } : { id: "worker", status: "fail", message: `wrangler rollback failed: ${wranglerError(rolled)}` });
    if (rolled.code !== 0) return { command, status: "failed", summary: "Rollback stopped at the Worker", steps };
  }
  if (restore) {
    if (!upgrade.bookmark) {
      steps.push({ id: "d1", status: "needs_human", message: "No Time Travel bookmark was recorded", fix: `Restore from the SQL export ${upgrade.backup} with wrangler d1 execute --remote --file, after the owner approves` });
    } else {
      const restored = await wrangler(p, ["d1", "time-travel", "restore", ctx.instance.d1.name, "--bookmark", upgrade.bookmark], { env: ctx.env, timeoutMs: 10 * 60_000, onOutput: (text) => log(text.trimEnd()) });
      steps.push(restored.code === 0 ? { id: "d1", status: "done", message: `Restored D1 to ${upgrade.bookmark}` } : { id: "d1", status: "fail", message: `The D1 restore failed: ${wranglerError(restored)}`, fix: restoreCommand(ctx.instance, upgrade.bookmark) });
    }
  }
  const checkout = await exec("git", ["checkout", "--detach", upgrade.fromCommit], { cwd: p.root, timeoutMs: 120_000 });
  if (checkout.code !== 0) {
    steps.push({ id: "checkout", status: "fail", message: `git checkout ${upgrade.fromCommit} failed: ${checkout.stderr.trim()}` });
    return { command, status: "failed", summary: "Rollback stopped at the checkout", steps };
  }
  const installed = await exec("npm", ["ci"], { cwd: p.root, timeoutMs: 20 * 60_000, onOutput: (text) => log(text.trimEnd()) });
  steps.push(installed.code === 0 ? { id: "checkout", status: "done", message: `Checked out ${upgrade.fromCommit.slice(0, 7)} and installed its dependencies` } : { id: "checkout", status: "fail", message: "npm ci failed", fix: "npm ci" });
  if (installed.code !== 0) return { command, status: "failed", summary: "Rollback stopped at npm ci", steps };
  const version = JSON.parse(readFileSync(join(p.root, "package.json"), "utf8")).version;
  if (node.loaded) {
    steps.push({ id: "restart", ...(await restartService(ctx.instance.services.node)) });
    const envValues = readEnvFile(p.envFile) ?? {};
    const seen = await waitForNode({ secret: ctx.secret, host: envValues.NODE_HOST || "127.0.0.1", port: Number(envValues.NODE_PORT || 9191) }, version);
    steps.push(seen.ok ? { id: "node", status: "done", message: `The node runs v${version}` } : { id: "node", status: "fail", message: `The node did not come back as v${version} (last: ${seen.seen})`, fix: "npm run yolo -- service logs node" });
  } else {
    steps.push({ id: "node", status: "needs_human", message: "Restart the node from this checkout now" });
  }
  const doctor = await cli(p, ["doctor"], { log });
  steps.push({ id: "doctor", status: doctor.status === "ok" ? "done" : "warn", message: doctor.summary, detail: doctor.checks?.filter((check) => check.status === "fail" || check.status === "warn") });
  record(p, { kind: "rollback", from: upgrade.to, to: upgrade.from, commit: upgrade.fromCommit, workerVersionId: upgrade.workerVersionId, restoredD1: restore && Boolean(upgrade.bookmark) });
  return { command, status: overall(steps), summary: `Rolled back to v${version}`, steps };
}
