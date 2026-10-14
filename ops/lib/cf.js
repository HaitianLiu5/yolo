import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withoutCredentials } from "./credentials.js";
import { run, which } from "./run.js";

// Cloudflare's own CLI, `cf` (npm package `cf`), under an auth profile of
// Yolo's own, "yolo", so the owner's other cf logins stay as they are
// (Agent Note 2026-10-13-agent-deployment). cf signs in with the OAuth
// device authorization grant: it prints a page and a code, and the owner
// approves on any device, a phone included, so the agent and the browser
// need not share a machine as `wrangler login`'s localhost callback does.

export const CF_PROFILE = "yolo";
export const CF_INSTALL = "npm install -g cf";
export const DEVICE_PAGE = "https://dash.cloudflare.com/oauth2/device/verify";

// The verify page with the code filled in: one tap on a phone.
export function verifyLink(code, page = DEVICE_PAGE) {
  const url = new URL(page);
  url.searchParams.set("user_code", code);
  return url.toString();
}

// cf acts with CLOUDFLARE_API_TOKEN when it is set, ignoring --profile, and
// refuses to sign a profile in. Yolo's own token is in the environment of
// every operator command, so cf always runs without it.
export const cfEnv = (env = process.env) => ({ ...withoutCredentials(env), NO_COLOR: "1", FORCE_COLOR: "0", CF_SEND_TELEMETRY: "false" });

export const cfPath = (env = process.env) => which("cf", env);

// (args) → { code, stdout, stderr } for `cf --profile yolo <args>`, or null
// when cf is not installed.
export function cfRunner(env = process.env, { profile = CF_PROFILE, path = cfPath(env), timeoutMs = 60_000 } = {}) {
  if (!path) return null;
  return (args) => run(path, ["--profile", profile, ...args], { env: cfEnv(env), timeoutMs });
}

// cf prints JSON, sometimes in the API's { success, result } envelope.
export function parseCf(stdout) {
  const text = String(stdout ?? "").trim();
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && "result" in value && "success" in value ? value.result : value;
  } catch {
    return text;
  }
}

// The reason a cf command failed. cf prints errors in a box ("┌ APIError",
// "│ [1001] …", "└"): keep the text lines. A command that returns a token's
// value goes through tokenFailure instead.
export const cfError = (result) => String(`${result?.stderr ?? ""}\n${result?.stdout ?? ""}`)
  .split("\n").map((line) => line.replace(/^[\s┌│└]+/, "").trim()).filter(Boolean).join(" ").slice(0, 400) || `exit code ${result?.code}`;

// Why a command that returns a token's value failed: its output only when
// it exited with an error, and so carries no value.
export const tokenFailure = (result) => (result?.code !== 0 ? cfError(result) : "cf printed no token");

// The page and code from cf's device login output:
//   To authorize …, please visit:
//     https://dash.cloudflare.com/oauth2/device/verify
//   and enter the code:
//     ABCD-EFGH
//   You have 5 minutes to approve this request.
// Only a page on cloudflare.com is accepted. → { page, code, link, expires } or null.
export function parseDeviceLogin(text) {
  const plain = String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const pages = plain.match(/https:\/\/[^\s"'<>]+\/oauth2\/device\/verify[^\s"'<>]*/g) ?? [];
  let page = null;
  let code = null;
  for (const candidate of pages) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.hostname !== "cloudflare.com" && !url.hostname.endsWith(".cloudflare.com")) continue;
    code ??= url.searchParams.get("user_code");
    url.search = "";
    page ??= url.toString();
  }
  code ??= /enter the code:?\s+([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/i.exec(plain)?.[1] ?? /"user_code"\s*:\s*"([^"]+)"/.exec(plain)?.[1] ?? null;
  if (!page || !code) return null;
  const expires = /You have (.+?) to approve/i.exec(plain)?.[1] ?? null;
  return { page, code, link: verifyLink(code, page), expires };
}

// Whether the recorded login still runs: its pid is alive and is still cf's
// `auth create`, not another process that reused the pid.
function waiting(pending) {
  if (!pending?.pid) return false;
  try {
    process.kill(pending.pid, 0);
    return /\bauth\s+create\b/.test(execFileSync("ps", ["-p", String(pending.pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return false;
  }
}

// cf's OAuth scopes ask what the profile may do itself and what it may
// grant the tokens it creates.
export const loginArgs = (scopes, profile = CF_PROFILE) => ["auth", "create", profile, "--no-browser", "--device", "--scopes", ...scopes];

// The device login of the "yolo" profile, started in the background so the
// command can return the link at once: the agent passes it to the owner,
// and runs the command again after the approval. A login that is still
// waiting is reused rather than started again.
//
// → { status: "pending", page, code, link, expires, reused } once the link is
// known, or { status: "failed", error }.
export async function startDeviceLogin(p, { path, env = process.env, scopes, profile = CF_PROFILE, now = Date.now, waitMs = 30_000 } = {}) {
  const pending = readPending(p);
  if (waiting(pending) && pending.expiresAt > now()) return { status: "pending", ...pending.login, reused: true };
  stop(pending);
  mkdirSync(dirname(p.cfLoginLog), { recursive: true, mode: 0o700 });
  const log = openSync(p.cfLoginLog, "w", 0o600);
  let child;
  try {
    child = spawn(path, loginArgs(scopes, profile), { env: cfEnv(env), detached: true, stdio: ["ignore", log, log] });
  } catch (error) {
    closeSync(log);
    return { status: "failed", error: error.message };
  }
  closeSync(log);
  let exited = null;
  child.once("exit", (code) => {
    exited = code ?? 1;
  });
  child.once("error", (error) => {
    exited = error.message;
  });
  child.unref();
  const deadline = now() + waitMs;
  for (;;) {
    const text = existsSync(p.cfLoginLog) ? readFileSync(p.cfLoginLog, "utf8") : "";
    const login = parseDeviceLogin(text);
    if (login) {
      // cf gives the owner at most 5 minutes.
      writeFileSync(p.cfLogin, `${JSON.stringify({ pid: child.pid, login, expiresAt: now() + 5 * 60_000 }, null, 2)}\n`, { mode: 0o600 });
      return { status: "pending", ...login, reused: false };
    }
    if (exited !== null || now() > deadline) {
      if (exited === null) child.kill();
      return { status: "failed", error: cfError({ stdout: text, code: exited }) };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function readPending(p) {
  try {
    return JSON.parse(readFileSync(p.cfLogin, "utf8"));
  } catch {
    return null;
  }
}

// Waits until the background login ends (approved, denied, or expired).
export async function waitForDeviceLogin(p, { now = Date.now } = {}) {
  const pending = readPending(p);
  while (waiting(pending) && now() < pending.expiresAt + 15_000) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

// A login left over from an earlier run.
function stop(pending) {
  if (!waiting(pending)) return;
  try {
    process.kill(pending.pid);
  } catch {
    // Already gone.
  }
}

// The login's output, for the reason it failed; then forget it, stopping it
// if it still waits.
export function finishDeviceLogin(p) {
  stop(readPending(p));
  const text = existsSync(p.cfLoginLog) ? readFileSync(p.cfLoginLog, "utf8") : "";
  rmSync(p.cfLogin, { force: true });
  rmSync(p.cfLoginLog, { force: true });
  return text;
}

export const hasPendingLogin = (p) => waiting(readPending(p));
