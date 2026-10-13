import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployContext } from "../lib/context.js";
import { appliedMigrations, localMigrations } from "../lib/d1.js";
import { record } from "../lib/deployments.js";
import { overall } from "../lib/output.js";
import { parseJsonOutput, run as exec, wrangler, wranglerError } from "../lib/run.js";

export const summary = "Build, then deploy the Worker with the rendered config and NODE_SECRET from .env, and check it serves this version";
export const usage = "deploy [--message <text>] [--skip-build] [--no-verify]";
export const options = {
  message: { type: "string" },
  "skip-build": { type: "boolean" },
  "no-verify": { type: "boolean" },
};

// The Worker version serving 100% now, or null before the first deploy.
export async function currentWorkerVersion(p, env) {
  const status = await wrangler(p, ["deployments", "status", "--json"], { env, timeoutMs: 60_000 });
  try {
    const deployment = parseJsonOutput(status.stdout);
    return deployment.versions?.slice().sort((a, b) => b.percentage - a.percentage)[0]?.version_id ?? null;
  } catch {
    return null;
  }
}

async function commit(root) {
  const result = await exec("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

// Waits until the Worker reports `version` at /.well-known/yolo.
export async function waitForWorker(origin, version, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/.well-known/yolo`, { signal: AbortSignal.timeout(10_000) });
      const body = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
      last = body?.version ?? `HTTP ${response.status}`;
      if (body?.version === version) return { ok: true, seen: last };
    } catch (error) {
      last = error.cause?.code ?? error.name;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return { ok: false, seen: last };
}

export async function deploySteps(p, ctx, { message = null, skipBuild = false, verify = true, log = () => {} } = {}) {
  const steps = [];
  const applied = await appliedMigrations(p, ctx.instance, ctx.env);
  const pending = applied.ok ? localMigrations(p.migrations).filter((name) => !applied.names.includes(name)) : [];
  if (!applied.ok || pending.length) {
    steps.push({ id: "migrations", status: "fail", message: applied.ok ? `D1 misses ${pending.join(", ")}, which this code needs` : `Cannot read D1's migrations: ${applied.error}`, fix: "npm run yolo -- migrate" });
    return steps;
  }
  if (!skipBuild) {
    log("Building the player and the Worker…");
    const built = await exec("npm", ["run", "build"], { cwd: p.root, timeoutMs: 15 * 60_000, onOutput: (text) => log(text.trimEnd()) });
    if (built.code !== 0) {
      steps.push({ id: "build", status: "fail", message: `npm run build failed: ${wranglerError(built)}`, fix: "npm ci, then npm run build" });
      return steps;
    }
    steps.push({ id: "build", status: "done", message: "Built the player and the Worker" });
  }
  const previous = await currentWorkerVersion(p, ctx.env);
  const sha = await commit(p.root);
  // NODE_SECRET travels with the deploy, so the Worker always holds the
  // node's value; other secrets (LAN_DNS_TOKEN) stay as they are.
  const dir = mkdtempSync(join(tmpdir(), "yolo-deploy-"));
  const secrets = join(dir, "secrets.json");
  writeFileSync(secrets, JSON.stringify({ NODE_SECRET: ctx.secret }), { mode: 0o600 });
  let deployed;
  try {
    log(`Deploying ${ctx.instance.worker} to ${ctx.instance.publicOrigin}…`);
    deployed = await wrangler(p, ["deploy", "--secrets-file", secrets, "--tag", `v${ctx.version}`, "--message", message ?? `Yolo ${ctx.version}${sha ? ` (${sha.slice(0, 7)})` : ""}`], { env: ctx.env, timeoutMs: 15 * 60_000, onOutput: (text) => log(text.trimEnd()) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const versionId = /Current Version ID: (\S+)/.exec(deployed.stdout)?.[1] ?? null;
  record(p, { kind: "deploy", version: ctx.version, commit: sha, workerVersionId: versionId, previousWorkerVersionId: previous, ok: deployed.code === 0 });
  if (deployed.code !== 0) {
    steps.push({ id: "deploy", status: "fail", message: `wrangler deploy failed: ${wranglerError(deployed)}`, fix: "npm run yolo -- doctor" });
    return steps;
  }
  steps.push({ id: "deploy", status: "done", message: `Deployed Yolo ${ctx.version} as Worker version ${versionId ?? "(unknown)"}${previous ? `; the previous version was ${previous}` : ""}` });
  if (verify) {
    const seen = await waitForWorker(ctx.instance.publicOrigin, ctx.version);
    steps.push(seen.ok
      ? { id: "verify", status: "ok", message: `${ctx.instance.publicOrigin} serves Yolo ${ctx.version}` }
      : { id: "verify", status: "warn", message: `${ctx.instance.publicOrigin} does not report ${ctx.version} yet (last: ${seen.seen})`, fix: "A new custom domain can take minutes for its certificate; run npm run yolo -- doctor in a few minutes" });
  }
  return steps;
}

export async function run({ values, p }) {
  const ctx = await deployContext(p);
  if (!ctx.ok) return { command: "deploy", status: overall(ctx.steps), summary: "Not ready to deploy", steps: ctx.steps };
  const log = (line) => process.stderr.write(`${line}\n`);
  const steps = [...ctx.steps, ...(await deploySteps(p, ctx, { message: values.message, skipBuild: Boolean(values["skip-build"]), verify: !values["no-verify"], log }))];
  const status = overall(steps);
  return {
    command: "deploy",
    status,
    summary: status === "ok" ? `Yolo ${ctx.version} is deployed at ${ctx.instance.publicOrigin}` : "Deploy stopped",
    steps,
    next: status === "ok" ? ["npm run yolo -- doctor"] : [],
  };
}
