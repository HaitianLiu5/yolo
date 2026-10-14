import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

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
// instance config unless `config` says otherwise. Output is plain text;
// `input` goes to its stdin, which is how a secret reaches `secret put`.
//
// Wrangler answers arguments it cannot parse with its usage on stdout and one
// error line on stderr, and exits 0 when a command group lacks its
// subcommand. Either way it did nothing, so the result is a failure
// ({ usage: true } and a nonzero code).
export async function wrangler(p, args, { config = p.generated, env = process.env, timeoutMs, onOutput, input } = {}) {
  const configArgs = config ? ["--config", config] : [];
  const result = await run(process.execPath, [p.wrangler, ...args, ...configArgs], {
    cwd: p.control,
    env: { ...env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
    timeoutMs,
    onOutput,
    input,
  });
  return printedUsage(result) ? { ...result, code: result.code || 1, usage: true } : result;
}

const printedUsage = (result) => /^GLOBAL FLAGS\s*$/m.test(stripVTControlCharacters(result.stdout ?? ""));

// The line of wrangler's output that explains a failure, without the colours
// wrangler gives its errors even under NO_COLOR.
export function wranglerError(result) {
  if (result.error) return result.error.message;
  const lines = (text) => stripVTControlCharacters(text ?? "").split("\n").map((value) => value.trim()).filter(Boolean);
  const isError = (value) => /✘|ERROR|Error:/.test(value);
  const clean = (value) => value.replace(/^✘\s*\[ERROR\]\s*/, "");
  if (result.usage || printedUsage(result)) {
    // The usage text is not the reason; wrangler's error line is.
    const reason = lines(result.stderr).filter(isError).at(-1);
    return `wrangler printed its usage instead of running${reason ? `: ${clean(reason)}` : ""}`;
  }
  const text = [...lines(result.stderr), ...lines(result.stdout)];
  return clean(text.filter(isError).at(-1) ?? text.at(-1) ?? `exit code ${result.code}`);
}

// Parse a JSON value from a command's stdout, skipping any banner lines
// wrangler prints before it.
export function parseJsonOutput(stdout) {
  const start = stdout.search(/^[[{]/m);
  if (start === -1) throw new Error("no JSON in the output");
  return JSON.parse(stdout.slice(start));
}
