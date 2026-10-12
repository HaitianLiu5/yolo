// Enforce Agent Note lifecycle/class paths and dated filenames. Structural rules
// are shared with `agent-note-tree.js`; the closed classification rules live
// in `.agents/notes/README.md`.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { agentNoteRoot, isMainModule, walkAgentNoteTree } from "./agent-note-tree.js";

/** Former homes of project documentation, kept unavailable so knowledge cannot silently escape the notes tree. */
const LEGACY_ROOTS = ["docs"];

/**
 * Check the Agent Note tree and the retired documentation homes.
 * @param {string} [noteRoot] The `.agents/notes` directory.
 * @param {string} [repoRoot] The repository root the legacy homes are resolved against.
 * @returns {{ notes: import("./agent-note-tree.js").AgentNote[], errors: string[] }}
 */
export function agentNoteClassification(noteRoot = agentNoteRoot, repoRoot = resolve(noteRoot, "../..")) {
  const { notes, errors } = walkAgentNoteTree(noteRoot);
  for (const legacyRoot of LEGACY_ROOTS) {
    if (existsSync(resolve(repoRoot, legacyRoot))) {
      errors.push(`legacy-path: ${legacyRoot}/ is forbidden — project knowledge lives in Agent Notes under .agents/notes/`);
    }
  }
  return { notes, errors };
}

if (isMainModule(import.meta.filename)) {
  const { notes, errors } = agentNoteClassification();
  if (errors.length === 0) {
    console.log(`verify-agent-note-classification: ${notes.length} Agent Note(s) checked, structure consistent.`);
    process.exit(0);
  }
  console.error("verify-agent-note-classification: violations found:");
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
