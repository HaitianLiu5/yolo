// Verify and append-seal the frozen Agent Note archive.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_NOTE_CLASSES, agentNoteRoot, isMainModule } from "./agent-note-tree.js";
import {
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
} from "./archived-agent-notes.js";

const manifestRepoPath = ".agents/notes/archived/manifest.json";
const allowedRootFiles = new Set(["AGENTS.md", "manifest.json"]);

/**
 * Check the archive tree and, in write mode, append seals for new artifacts.
 * @param {object} [options]
 * @param {string} [options.noteRoot] The `.agents/notes` directory.
 * @param {boolean} [options.writeMode] Append new artifact hashes to the manifest.
 * @param {string} [options.baselineRef] The trusted commit whose manifest every seal must extend.
 * @returns {{ errors: string[], artifacts: number, kinds: number, added: number }}
 */
function verifyArchivedAgentNotes({
  noteRoot = agentNoteRoot,
  writeMode = false,
  baselineRef = process.env.YOLO_ARCHIVE_BASE_REF ?? "HEAD",
} = {}) {
  const archiveRoot = resolve(noteRoot, "archived");
  const manifestPath = resolve(archiveRoot, "manifest.json");
  const repoRoot = resolve(noteRoot, "../..");
  const errors = [];
  const kinds = new Set();

  if (!existsSync(resolve(archiveRoot, "AGENTS.md"))) errors.push("archived/AGENTS.md is required");
  const artifacts = new Map();
  for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
    if (entry.isFile()) {
      if (!allowedRootFiles.has(entry.name)) errors.push(`archived/${entry.name}: unexpected root file`);
      continue;
    }
    if (!entry.isDirectory()) {
      errors.push(`archived/${entry.name}: only regular files and kind directories are allowed`);
      continue;
    }
    if (!AGENT_NOTE_CLASSES.includes(entry.name)) {
      errors.push(`archived/${entry.name}/: unknown Agent Note kind`);
      continue;
    }
    kinds.add(entry.name);
    for (const child of readdirSync(resolve(archiveRoot, entry.name), { withFileTypes: true })) {
      const rel = `${entry.name}/${child.name}`;
      if (!child.isFile()) {
        errors.push(`${rel}: archived kind directories contain regular files only`);
        continue;
      }
      artifacts.set(rel, readFileSync(resolve(archiveRoot, rel)));
    }
  }
  // Git tracks no empty directory, so a kind with no archived note has no
  // folder; the closed set is enforced on the folders that exist.
  errors.push(...validateArchiveArtifacts(artifacts));

  const runGit = (args) => {
    const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || `git exited with status ${result.status}`);
    return result.stdout;
  };

  const readBaselineManifest = (ref) => {
    runGit(["cat-file", "-e", `${ref}^{commit}`]);
    const manifestEntry = runGit(["ls-tree", "--name-only", ref, "--", manifestRepoPath]).trim();
    if (manifestEntry === "") return { version: 1, files: {} };
    return parseArchiveManifest(runGit(["show", `${ref}:${manifestRepoPath}`]));
  };

  let manifest = { version: 1, files: {} };
  if (existsSync(manifestPath)) {
    try {
      manifest = parseArchiveManifest(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      errors.push(`archived/manifest.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!writeMode) {
    errors.push("archived/manifest.json is required; seal new artifacts with `npm run verify-archived-agent-notes -- --write`");
  }

  // CI supplies its trusted pre-change commit; local writes compare with committed HEAD.
  try {
    const baseline = readBaselineManifest(baselineRef);
    errors.push(...validateArchiveManifestExtension(baseline, manifest));
  } catch (error) {
    errors.push(`archived/manifest.json: cannot read baseline ${JSON.stringify(baselineRef)}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const extended = extendArchiveManifest(manifest, artifacts);
  errors.push(...extended.errors);
  if (!writeMode) {
    for (const path of extended.added) errors.push(`${path}: archived artifact is not sealed in manifest.json`);
  }

  if (errors.length === 0 && writeMode) {
    const rendered = renderArchiveManifest(extended.files);
    if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== rendered) {
      writeFileSync(manifestPath, rendered);
    }
  }
  return { errors, artifacts: artifacts.size, kinds: kinds.size, added: extended.added.length };
}

if (isMainModule(import.meta.filename)) {
  const args = process.argv.slice(2);
  const writeMode = args.length === 1 && args[0] === "--write";
  if (args.length > 0 && !writeMode) {
    console.error("verify-archived-agent-notes: usage: node scripts/verify-archived-agent-notes.js [--write]");
    process.exit(1);
  }
  const result = verifyArchivedAgentNotes({ writeMode });
  if (result.errors.length > 0) {
    console.error("verify-archived-agent-notes: archive rules violated:");
    for (const error of result.errors) console.error(`  ${error}`);
    process.exit(1);
  }
  if (writeMode) {
    console.log(`verify-archived-agent-notes: sealed ${result.added} new artifact(s); existing seals unchanged.`);
  } else {
    console.log(`verify-archived-agent-notes: ${result.artifacts} frozen artifact(s) checked across ${result.kinds} kind(s).`);
  }
}
