import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

// Child processes without a shell: arguments are never parsed twice.
export function run(command, args = [], { cwd, env = process.env, input, timeoutMs = 10 * 60_000, onOutput } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      onOutput?.(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      onOutput?.(String(chunk));
    });
    if (input != null) child.stdin.end(input);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error: null });
    });
  });
}

// The executable's absolute path on PATH, or null.
export function which(name, env = process.env) {
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

// Wrangler from this checkout, in service/control, with the rendered
// instance config unless `config` says otherwise. Output is plain text.
export function wrangler(p, args, { config = p.generated, env = process.env, timeoutMs, onOutput } = {}) {
  const configArgs = config ? ["--config", config] : [];
  return run(process.execPath, [p.wrangler, ...args, ...configArgs], {
    cwd: p.control,
    env: { ...env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
    timeoutMs,
    onOutput,
  });
}

// The last line of wrangler's output that explains a failure.
export function wranglerError(result) {
  if (result.error) return result.error.message;
  const text = `${result.stderr}\n${result.stdout}`.split("\n").map((value) => value.trim()).filter(Boolean);
  const marked = text.filter((value) => /✘|ERROR|Error:/.test(value));
  return (marked.at(-1) ?? text.at(-1) ?? `exit code ${result.code}`).replace(/^✘\s*\[ERROR\]\s*/, "");
}

// Parse a JSON value from a command's stdout, skipping any banner lines
// wrangler prints before it.
export function parseJsonOutput(stdout) {
  const start = stdout.search(/^[[{]/m);
  if (start === -1) throw new Error("no JSON in the output");
  return JSON.parse(stdout.slice(start));
}
