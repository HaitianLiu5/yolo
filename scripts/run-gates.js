// Run a named aggregate of documentation gates. Each leaf gate runs as its own
// Node process (shell-free), all leaves run concurrently, and output is
// buffered per gate so a failure prints its full diagnostics once. The
// aggregate fails when any leaf fails; it never stops early, so one run
// reports every broken gate.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isMainModule } from "./agent-note-tree.js";

const scriptsDir = import.meta.dirname;

/**
 * One leaf gate: an id, a human label, and the script (with arguments) it runs.
 * @typedef {{ id: string, label: string, script: string, args?: string[] }} Gate
 */

/** @type {Record<string, Gate[]>} */
export const MODES = {
  "doc-sync": [
    { id: "agent-note-classification", label: "agent note classification", script: "verify-agent-note-classification.js" },
    { id: "agent-note-format", label: "agent note format", script: "verify-agent-note-format.js" },
    { id: "archived-agent-notes", label: "archived agent notes", script: "verify-archived-agent-notes.js" },
    { id: "translation-pairing", label: "translation pairing", script: "verify-translation-pairing.js" },
    { id: "markdown-links", label: "markdown links", script: "verify-md-links.js" },
    { id: "markdown-wrap", label: "markdown wrap", script: "verify-md-wrap.js" },
  ],
};

/**
 * Run one gate process to completion with buffered output.
 * @param {Gate} gate
 * @param {string} dir Directory holding the gate scripts.
 * @returns {Promise<{ gate: Gate, status: "passed" | "failed", output: string, seconds: string, reason: string }>}
 */
function runGate(gate, dir) {
  const started = performance.now();
  return new Promise((resolvePromise) => {
    const chunks = [];
    const child = spawn(process.execPath, [resolve(dir, gate.script), ...(gate.args ?? [])], {
      cwd: resolve(dir, ".."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    let spawnError;
    child.on("error", (error) => {
      spawnError = `failed to start command: ${error.message}`;
    });
    child.on("close", (code, signal) => {
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const passed = code === 0 && signal === null && spawnError === undefined;
      resolvePromise({
        gate,
        status: passed ? "passed" : "failed",
        output: Buffer.concat(chunks).toString("utf8"),
        seconds,
        reason: spawnError ?? (signal === null ? `exit code ${code}` : `signal ${signal}`),
      });
    });
  });
}

/**
 * Run every gate of one aggregate and report each result.
 * @param {string} mode Aggregate name, a key of {@link MODES}.
 * @param {object} [options]
 * @param {Gate[]} [options.gates] Override the aggregate's gates (tests).
 * @param {string} [options.dir] Directory holding the gate scripts.
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.error]
 * @returns {Promise<number>} The process exit status.
 */
export async function runGates(mode, {
  gates = MODES[mode],
  dir = scriptsDir,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  if (gates === undefined) {
    error(`run-gates: expected mode ${Object.keys(MODES).join(" | ")}, got ${JSON.stringify(mode)}.`);
    return 2;
  }
  const started = performance.now();
  log(`run-gates: ${mode} running ${gates.length} gate(s).`);
  const results = await Promise.all(gates.map((gate) => runGate(gate, dir)));
  for (const result of results) {
    if (result.status === "passed") {
      log(`run-gates: PASS ${result.gate.label} (${result.seconds}s)`);
      continue;
    }
    error(`\nrun-gates: FAIL ${result.gate.label} (${result.seconds}s)`);
    error(`command: node scripts/${result.gate.script}${(result.gate.args ?? []).map((arg) => ` ${arg}`).join("")}`);
    error(`outcome: ${result.reason}`);
    if (result.output.trim() !== "") error(result.output.trimEnd());
  }
  const failed = results.filter((result) => result.status === "failed");
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  log(`\nrun-gates: ${results.length - failed.length} passed, ${failed.length} failed in ${seconds}s.`);
  if (failed.length === 0) return 0;
  error("run-gates: unsuccessful gates:");
  for (const result of failed) error(`  - FAILED ${result.gate.label} (${result.reason})`);
  return 1;
}

if (isMainModule(import.meta.filename)) {
  process.exitCode = await runGates(process.argv[2] ?? "");
}
