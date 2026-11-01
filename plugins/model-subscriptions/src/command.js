import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

// Running the owner's agent CLIs, codex and claude, as the borrowed sources do
// (Agent Note 2026-10-25-models-for-plugins).

// Where installers put the CLIs, for a service whose PATH is not the login
// shell's (launchd and systemd units read no profile).
function candidates(command, home) {
  return [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
    join(home, ".local/bin", command),
    join(home, ".npm-global/bin", command),
    ...(command === "claude" ? [join(home, ".claude/local/claude")] : []),
  ];
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The command to run: an absolute path as given, else the first match on
// PATH, else a usual install location; null when there is none.
export function findCommand(command, { env = process.env, home = env.HOME || homedir(), isExecutable = executable } = {}) {
  if (isAbsolute(command)) return isExecutable(command) ? command : null;
  for (const dir of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    const path = join(dir, command);
    if (isExecutable(path)) return path;
  }
  return candidates(command, home).find(isExecutable) ?? null;
}

// The child's environment: the node's, without Yolo's secrets and other
// credentials from its .env. The CLIs sign in with their own logins.
const SECRET_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|CREDENTIAL|COOKIE/i;

export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !SECRET_NAME.test(key)));
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Runs `command` with `args`, writes `input` to its stdin and closes it (a
 * CLI waiting on an open stdin never ends), and resolves with its exit code
 * and output. `signal` kills it.
 */
export function runCommand(command, args, { input = "", env = process.env, cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const kill = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk) => { if (stdout.length < MAX_OUTPUT) stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { if (stderr.length < MAX_OUTPUT) stderr += chunk; });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", kill);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      if (signal?.aborted) reject(signal.reason);
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
