import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, parseChangelog, upgradePath } from "../lib/changelog.js";
import { cloudflareAccount, withAccount } from "../lib/cloudflare.js";
import { deployContext } from "../lib/context.js";
import { backupD1 } from "../lib/d1.js";
import { record } from "../lib/deployments.js";
import { readEnvFile } from "../lib/env-file.js";
import { waitForNode } from "../lib/node-health.js";
import { overall } from "../lib/output.js";
import { parseJsonOutput, run as exec, wrangler } from "../lib/run.js";
import { serviceStatus } from "../lib/service.js";
import { currentWorkerVersion } from "./deploy.js";

export const summary = "Move this deploy checkout to a newer release: back up D1, migrate, restart the node, deploy the Worker, then doctor";
export const usage = "upgrade [--to vX.Y.Z] [--approve] [--remote <name>] [--allow-branch]";
export const options = {
  to: { type: "string" },
  approve: { type: "boolean" },
  remote: { type: "string" },
  "allow-branch": { type: "boolean" },
};

const git = (p, args, options = {}) => exec("git", args, { cwd: p.root, timeoutMs: 120_000, ...options });

// The checkout's own CLI after it moved to the target release: the steps
// after the checkout run with the new release's code.
export async function cli(p, args, { log }) {
  const result = await exec(process.execPath, [join(p.root, "ops/yolo.js"), ...args, "--json"], { cwd: p.root, timeoutMs: 30 * 60_000, onOutput: (text) => log(text.trimEnd()) });
  try {
    return parseJsonOutput(result.stdout);
  } catch {
    return { status: "failed", summary: `npm run yolo -- ${args.join(" ")} printed no result (exit ${result.code})`, steps: [] };
  }
}

const tagsOf = (text) => [...text.matchAll(/^v(\d+\.\d+\.\d+)$/gm)].map((match) => match[1]);

export async function run({ values, p }) {
  const command = "upgrade";
  const log = (line) => line && process.stderr.write(`${line}\n`);
  const steps = [];
  const fail = (summary, extra = {}) => ({ command, status: "failed", summary, steps, ...extra });

  // --- The checkout -------------------------------------------------------
  const dirty = await git(p, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.code !== 0) return fail(`This is not a git checkout: ${dirty.stderr.trim()}`);
  if (dirty.stdout.trim()) return fail(`Tracked files have local changes:\n${dirty.stdout.trimEnd()}`, { next: ["Commit or move them; a deploy checkout carries no edits"] });
  const branch = (await git(p, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (branch && !values["allow-branch"]) {
    return fail(`This checkout is on branch ${branch}. Upgrades move a deploy checkout between release tags (detached HEAD); running one here would move your branch's working tree.`, {
      next: ["Use the deploy checkout (skills/yolo-upgrade, \"The deploy checkout\")", "Or pass --allow-branch to move this checkout anyway"],
    });
  }
  const fromCommit = (await git(p, ["rev-parse", "HEAD"])).stdout.trim();
  const current = JSON.parse(readFileSync(join(p.root, "package.json"), "utf8")).version;

  // --- The target release ---------------------------------------------------
  const remote = values.remote ?? "origin";
  const fetched = await git(p, ["fetch", "--tags", remote]);
  steps.push(fetched.code === 0
    ? { id: "fetch", status: "done", message: `Fetched release tags from ${remote}` }
    : { id: "fetch", status: "warn", message: `Cannot fetch from ${remote} (${fetched.stderr.trim().split("\n").at(-1)}); using the tags already here` });
  const tags = tagsOf((await git(p, ["tag", "-l", "v*"])).stdout).sort(compareVersions);
  const target = values.to ? values.to.replace(/^v/, "") : tags.at(-1);
  if (!target) return fail("No release tags (vX.Y.Z) exist yet", { next: ["Upgrades follow release tags; see .agents/skills/yolo-release"] });
  if (!tags.includes(target)) return fail(`No tag v${target}`, { next: [`Known releases: ${tags.map((tag) => `v${tag}`).join(", ") || "none"}`] });
  if (compareVersions(target, current) === 0) return { command, status: "ok", summary: `Already at v${current}`, steps };
  if (compareVersions(target, current) < 0) return fail(`v${target} is older than this checkout's v${current}`, { next: ["npm run yolo -- rollback returns to the release before the last upgrade"] });

  const changelog = await git(p, ["show", `v${target}:CHANGELOG.md`]);
  const path = upgradePath(changelog.code === 0 ? parseChangelog(changelog.stdout) : [], current, target);
  for (const error of path.errors) steps.push({ id: "changelog", status: "warn", message: error });
  if (!path.releases.length) steps.push({ id: "changelog", status: "warn", message: `CHANGELOG.md at v${target} describes no release after v${current}; read the commits before approving` });

  // The plan needs only this checkout and the instance file; the Cloudflare
  // login is checked after it, so the owner sees the plan either way.
  const ctx = await deployContext(p, { account: false });
  steps.push(...ctx.steps);
  if (!ctx.ok) return { command, status: overall(ctx.steps), summary: "The instance is not ready to upgrade", steps };
  const node = await serviceStatus(ctx.instance.services.node);
  const plan = [
    `Back up D1 (${ctx.instance.d1.name}) to ${p.backups} and record a Time Travel bookmark`,
    `Check out v${target} here (from v${current}, ${fromCommit.slice(0, 7)}) and run npm ci`,
    path.migrations.length ? `Apply D1 migrations ${path.migrations.join(", ")}; each still works with v${current}'s code` : "No D1 migrations",
    node.loaded ? `Restart the node service ${ctx.instance.services.node} and wait for it to report v${target}` : `Restart the node yourself (no service ${ctx.instance.services.node} is loaded)`,
    `Deploy the Worker (tag v${target}) with NODE_SECRET from .env`,
    "Run npm run yolo -- doctor and require one version everywhere",
    path.rollback === "restore"
      ? `Rolling back later also restores D1 from this backup, which loses what changed after the upgrade`
      : `Rolling back later needs no D1 restore: v${current}'s code runs on v${target}'s database`,
  ];
  const upgradeInfo = {
    from: current,
    to: target,
    releases: path.releases,
    protocol: path.protocol,
    migrations: path.migrations,
    newSecrets: path.secrets,
    newSettings: path.settings,
    resources: path.resources,
    humanActions: path.human,
    rollback: path.rollback,
  };
  const account = await cloudflareAccount(p, ctx.instance);
  steps.push({ id: "account", status: account.status, message: account.message, fix: account.fix });
  if (account.status !== "ok") return { command, status: overall(steps), summary: `Upgrade v${current} → v${target} needs Cloudflare access`, upgrade: upgradeInfo, plan, steps };
  ctx.env = withAccount(process.env, account.accountId);

  // What the owner must provide before the upgrade can finish.
  const envValues = readEnvFile(p.envFile) ?? {};
  const missingSettings = path.settings.filter((setting) => setting.required && !envValues[setting.name]);
  let missingSecrets = [];
  if (path.secrets.some((secret) => secret.required)) {
    const listed = await wrangler(p, ["secret", "list", "--format", "json"], { env: ctx.env, timeoutMs: 60_000 });
    let names = [];
    try {
      names = parseJsonOutput(listed.stdout).map((entry) => entry.name);
    } catch {
      // Treated as missing below.
    }
    missingSecrets = path.secrets.filter((secret) => secret.required && !names.includes(secret.name));
  }
  for (const setting of missingSettings) steps.push({ id: `setting.${setting.name}`, status: "needs_human", message: `v${target} needs ${setting.name} in ${p.envFile}`, fix: setting.how ?? `Ask the owner for ${setting.name}` });
  for (const secret of missingSecrets) steps.push({ id: `secret.${secret.name}`, status: "needs_human", message: `v${target} needs the Worker secret ${secret.name}`, fix: secret.how ?? `The owner runs: npm run wrangler -- secret put ${secret.name}` });
  if (missingSettings.length || missingSecrets.length) {
    return { command, status: "needs_human", summary: `v${target} needs settings or secrets from the owner first`, upgrade: upgradeInfo, plan, steps };
  }
  if (!values.approve) {
    return {
      command,
      status: "needs_approval",
      summary: `Upgrade v${current} → v${target}. Show the owner the release notes, human actions, and rollback mode, and ask for approval.`,
      upgrade: upgradeInfo,
      plan,
      steps,
      approve: `npm run yolo -- upgrade --to v${target} --approve`,
    };
  }

  // --- Approved: run it -------------------------------------------------------
  const previousWorker = await currentWorkerVersion(p, ctx.env);
  record(p, { kind: "upgrade-start", from: current, to: target, fromCommit, workerVersionId: previousWorker });
  const backup = await backupD1(p, ctx.instance, ctx.env, `before-v${target}`);
  if (!backup.ok) return fail(`The D1 backup failed, so nothing changed: ${backup.error}`);
  steps.push({ id: "backup", status: "done", message: `Backed up D1 to ${backup.file}${backup.bookmark ? ` (bookmark ${backup.bookmark})` : ""}` });
  const finished = (outcome, summary) => {
    record(p, { kind: "upgrade", ok: outcome === "ok", from: current, to: target, fromCommit, workerVersionId: previousWorker, backup: backup.file, bookmark: backup.bookmark, rollback: path.rollback });
    const status = outcome === "ok" && steps.some((step) => step.status === "needs_human") ? "needs_human" : outcome;
    return { command, status, summary, upgrade: upgradeInfo, steps, next: outcome === "ok" ? path.human : ["npm run yolo -- rollback (shows the plan, then asks for approval)"] };
  };

  const checkout = await git(p, ["checkout", "--detach", `v${target}`]);
  if (checkout.code !== 0) return fail(`git checkout v${target} failed: ${checkout.stderr.trim()}`);
  log(`Installing v${target}'s dependencies…`);
  const installed = await exec("npm", ["ci"], { cwd: p.root, timeoutMs: 20 * 60_000, onOutput: (text) => log(text.trimEnd()) });
  if (installed.code !== 0) {
    steps.push({ id: "install", status: "fail", message: "npm ci failed", fix: `Nothing on Cloudflare changed yet: git checkout --detach ${fromCommit} && npm ci` });
    return finished("failed", "Upgrade stopped before changing the deployment");
  }
  steps.push({ id: "checkout", status: "done", message: `Checked out v${target} and installed its dependencies` });

  const sub = async (id, args) => {
    const result = await cli(p, args, { log });
    steps.push({ id, status: result.status === "ok" ? "done" : result.status === "needs_human" ? "needs_human" : "fail", message: result.summary, ...(result.steps ? { detail: result.steps } : {}) });
    return result.status === "ok";
  };
  if (!(await sub("migrate", ["migrate", "--skip-backup"]))) return finished("failed", "Migration failed");
  if (node.loaded) {
    if (!(await sub("restart", ["service", "restart", "node"]))) return finished("failed", "The node did not restart");
    const seen = await waitForNode({ secret: ctx.secret, host: envValues.NODE_HOST || "127.0.0.1", port: Number(envValues.NODE_PORT || 9191) }, target);
    steps.push(seen.ok ? { id: "node", status: "done", message: `The node runs v${target}` } : { id: "node", status: "fail", message: `The node did not come back as v${target} (last: ${seen.seen})`, fix: "npm run yolo -- service logs node" });
    if (!seen.ok) return finished("failed", "The node did not come back");
  } else {
    steps.push({ id: "node", status: "needs_human", message: `Restart the node from this checkout now (no service ${ctx.instance.services.node} is loaded)`, fix: "npm run yolo -- service install node" });
  }
  if (!(await sub("deploy", ["deploy", "--message", `Upgrade to v${target}`]))) return finished("failed", "The Worker deploy failed");
  const doctor = await cli(p, ["doctor"], { log });
  const versions = doctor.versions ?? {};
  const same = versions.worker === target && (versions.node === target || !node.loaded);
  steps.push({ id: "doctor", status: doctor.status === "ok" && same ? "done" : "fail", message: `${doctor.summary}; Worker ${versions.worker ?? "?"}, node ${versions.node ?? "?"}`, detail: doctor.checks?.filter((check) => check.status === "fail" || check.status === "warn") });
  return finished(doctor.status === "ok" && same ? "ok" : "failed", doctor.status === "ok" && same ? `Upgraded to v${target}` : "Upgraded, but doctor found problems");
}
