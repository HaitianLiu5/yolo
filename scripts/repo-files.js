// Shared repository file discovery for the documentation gates.

import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Whether a repository path is frozen Agent Note history, not evolving source prose.
 * @param {string} path
 * @returns {boolean}
 */
export function isArchivedAgentNotePath(path) {
  return path.replaceAll("\\", "/").startsWith(".agents/notes/archived/");
}

/**
 * Whether a pattern segment matches a directory or file name. Supports `*` and
 * `?` inside a segment and mirrors node's glob `dot: false`: a segment whose
 * first character is a wildcard does not match dot names. `**` is handled as a
 * whole segment by the walker, never here.
 */
function segmentMatches(pattern, name) {
  if (name.startsWith(".") && (pattern.startsWith("*") || pattern.startsWith("?"))) return false;
  let expression = "";
  for (const character of pattern) {
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`).test(name);
}

/**
 * Reject glob syntax the walker does not model. Node's `fs.glob` understands
 * character classes, brace alternation, and extglobs; expanding those
 * silently as literals would match nothing and quietly shrink a gate's
 * corpus, so a pattern segment using them fails loudly instead.
 */
const UNSUPPORTED_GLOB = /[[\]{}()!+@\\]/;

function assertSupportedSegment(segment) {
  if (UNSUPPORTED_GLOB.test(segment)) {
    throw new TypeError(`repo-files walker does not model glob syntax in segment: ${segment}`);
  }
}

/** Whether a pattern segment contains `*` or `?` and is therefore wildcard. */
function hasWildcard(segment) {
  return segment.includes("*") || segment.includes("?");
}

/**
 * Walk `root` matching one repository-relative glob without node's `fs.glob`,
 * which from some 24.x releases throws ENOTDIR on symlinked files while
 * expanding `**` (instruction files such as `CLAUDE.md` are symlinks). Literal
 * segments resolve through `stat`, so they enter symlinked directories;
 * wildcard segments and `**` resolve through dirent types, so they never enter
 * symlinked directories and never match dot names. The final segment matches
 * files and symlinks. Segments support `*`, `?`, and plain literals; other glob
 * syntax, `..`, empty segments, and a trailing `**` are rejected loudly.
 * @param {string} root Absolute directory to walk.
 * @param {string} pattern Repository-relative glob.
 * @returns {string[]} Repository-relative slash paths, sorted.
 */
function expandGlob(root, pattern) {
  const segments = [];
  for (const segment of pattern.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") throw new TypeError(`repo-files walker does not model .. segments in pattern: ${pattern}`);
    if (segment === "") throw new TypeError(`repo-files walker does not model empty segments in pattern: ${pattern}`);
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new TypeError(`repo-files walker does not model a pattern with no segments: ${pattern}`);
  }
  for (const segment of segments) {
    if (segment !== "**") assertSupportedSegment(segment);
  }
  if (segments[segments.length - 1] === "**") {
    throw new TypeError(`repo-files walker does not model a trailing ** segment in pattern: ${pattern}`);
  }
  const out = [];

  const visit = (dirAbs, dirRel, index) => {
    if (index >= segments.length) return;
    if (segments[index] !== "**") {
      visitSegment(dirAbs, dirRel, index);
      return;
    }
    // `**` consumes zero directories here and one directory per recursion.
    visitSegment(dirAbs, dirRel, index + 1);
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
      visit(join(dirAbs, entry.name), dirRel === "." ? entry.name : `${dirRel}/${entry.name}`, index);
    }
  };

  const visitSegment = (dirAbs, dirRel, index) => {
    if (index >= segments.length) return;
    const segment = segments[index];
    if (segment === undefined) return;
    if (segment === "**") {
      visit(dirAbs, dirRel, index);
      return;
    }
    const last = index === segments.length - 1;
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      if (!segmentMatches(segment, entry.name)) continue;
      const childAbs = join(dirAbs, entry.name);
      const childRel = dirRel === "." ? entry.name : `${dirRel}/${entry.name}`;
      if (last) {
        // Files and symlinks match; a broken or cyclic symlink then fails
        // loudly in the caller's realpathSync rather than shrinking the corpus.
        if (entry.isFile() || entry.isSymbolicLink()) out.push(childRel);
        continue;
      }
      if (entry.isDirectory()) {
        visitSegment(childAbs, childRel, index + 1);
        continue;
      }
      if (!entry.isSymbolicLink() || hasWildcard(segment)) continue;
      let target;
      try {
        target = statSync(childAbs);
      } catch {
        // A broken symlink matches nothing under a literal segment, as node glob does.
        continue;
      }
      if (!target.isDirectory()) continue;
      visitSegment(childAbs, childRel, index + 1);
    }
  };

  visit(root, ".", 0);
  return out.sort();
}

/**
 * Expand repository-relative globs and deduplicate symlinked files.
 * @param {string} root Absolute repository root.
 * @param {readonly string[]} patterns Repository-relative glob patterns, processed in order.
 * @param {(relativePath: string) => boolean} [isExcluded] Optional predicate over each matched relative path.
 * @returns {{ abs: string, real: string }[]} Matched files in stable first-seen order.
 */
export function uniqueRepoFiles(root, patterns, isExcluded = () => false) {
  const seen = new Set();
  const files = [];
  for (const pattern of patterns) {
    for (const repoPath of expandGlob(root, pattern)) {
      if (isExcluded(repoPath)) continue;
      const abs = resolve(root, repoPath);
      const real = realpathSync(abs);
      if (seen.has(real)) continue;
      seen.add(real);
      files.push({ abs, real });
    }
  }
  return files;
}
