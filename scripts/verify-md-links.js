// Verify that relative Markdown links, images, and definitions resolve — the
// target file must exist AND a `#fragment` onto a Markdown target (including
// a same-file `#anchor`) must name a real heading slug or explicit `<a id>`.
// URL and root-absolute targets are excluded; query strings do not affect
// resolution against the source file. The checker never rewrites, and
// symlinked instruction files are deduped.

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isMainModule } from "./agent-note-tree.js";
import { markdownHeadingLines, parseMarkdown, visitMarkdown } from "./markdown.js";
import { isArchivedAgentNotePath, uniqueRepoFiles } from "./repo-files.js";

const root = resolve(import.meta.dirname, "..");

/** Repo-authored Markdown checked for relative links. */
const PATTERNS = [
  "*.md",
  ".github/*.md",
  ".agents/notes/**/*.md",
  ".agents/skills/**/*.md",
  "skills/**/*.md",
];

/**
 * Discover authored Markdown sources, deduplicating symlinks.
 * Archived notes are excluded as sources, but links to them remain checked.
 * @param {string} [scanRoot] Absolute repository root; pass the same root to findViolations for matching diagnostics.
 * @returns {string[]} Forward-slash source paths relative to scanRoot.
 */
export function markdownLinkSourcePaths(scanRoot = root) {
  return uniqueRepoFiles(scanRoot, PATTERNS, isArchivedAgentNotePath)
    .map((file) => relative(scanRoot, file.abs).replaceAll("\\", "/"));
}

/**
 * True for targets this gate must NOT check: scheme-qualified URLs (`https:`,
 * `mailto:`, …), protocol-relative (`//host`), and root-absolute (`/path`).
 * Pure in-page anchors (`#frag`) ARE checked, against the source file itself.
 */
function isExternal(url) {
  if (url.startsWith("//")) return true;
  if (url.startsWith("/")) return true;
  // A scheme like `https:` / `mailto:` — a colon before any slash, dot, or hash.
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
}

/**
 * Strip the `#fragment` and `?query` from a link target, then percent-decode
 * the remaining path so an encoded target probes the real filename on disk,
 * the way a Markdown renderer resolves it.
 */
function pathPart(url) {
  const raw = url.replace(/[#?].*$/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed percent-escape is a path no renderer resolves; the existence
    // check then reports it broken.
    return raw;
  }
}

/** The percent-decoded `#fragment` of a link target, or null when it has none. */
function fragmentPart(url) {
  const hash = url.indexOf("#");
  if (hash === -1) return null;
  const raw = url.slice(hash + 1).replace(/\?.*$/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape names no anchor anyone meant; it is reported missing.
    return raw;
  }
}

/**
 * GitHub's heading-slug algorithm (lowercase; drop everything but letters,
 * numbers, underscores, spaces, hyphens; spaces become hyphens).
 * @param {string} heading The RENDERED heading text (Markdown syntax already gone).
 * @returns {string} The anchor GitHub assigns the first occurrence of the heading.
 */
export function githubSlug(heading) {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replaceAll(" ", "-");
}

/**
 * Every anchor one Markdown document exposes: each heading's GitHub slug —
 * computed from the RENDERED heading text — plus every explicit `<a id="…">`
 * that appears in real HTML flow (a fenced or inline code sample and a
 * commented-out anchor register nothing). Repeated slugs get GitHub's
 * occupied-set `-1`, `-2`, … suffixes. Matching is exact — element ids are
 * case-sensitive.
 * @param {string} source The document's full Markdown text.
 * @returns {Set<string>} The set of valid fragments for links into this document.
 */
export function documentAnchors(source) {
  const anchors = new Set();
  const occurrences = new Map();
  for (const heading of markdownHeadingLines(source)) {
    const base = githubSlug(heading.text);
    let result = base;
    let bump = occurrences.get(base) ?? 0;
    while (anchors.has(result)) {
      bump += 1;
      result = `${base}-${bump}`;
    }
    occurrences.set(base, bump);
    anchors.add(result);
  }
  visitMarkdown(parseMarkdown(source), (node) => {
    if (node.type !== "html") return;
    const html = node.value.replace(/<!--[\s\S]*?-->/g, "");
    for (const match of html.matchAll(/<a id="([^"]+)"/g)) anchors.add(match[1] ?? "");
  });
  return anchors;
}

/**
 * Lazily collect and cache the anchor set of any existing Markdown file —
 * shared across all scanned sources so a target parses once.
 * @returns {(absPath: string) => Set<string>} The memoized absolute-path → anchor-set lookup.
 */
export function anchorCache() {
  const cache = new Map();
  return (absPath) => {
    const hit = cache.get(absPath);
    if (hit) return hit;
    const anchors = documentAnchors(readFileSync(absPath, "utf8"));
    cache.set(absPath, anchors);
    return anchors;
  };
}

/**
 * Find every broken relative cross-link in one Markdown file via its AST: a
 * relative target that does not exist, or a fragment onto a Markdown file
 * (same-file `#anchor` links included) that names no heading slug or explicit
 * `<a id>` there. Fragments onto non-Markdown targets (`file.js#L10`) carry
 * renderer-owned semantics and are not judged.
 * @param {string} absPath Absolute path of the Markdown source to scan.
 * @param {(abs: string) => Set<string>} anchorsOf Anchor lookup shared across files for cross-link checks.
 * @param {string} [scanRoot] Repository root violations are reported relative to.
 * @returns {{ file: string, line: number, url: string, reason: "target" | "anchor" }[]} One entry per broken link, in document order.
 */
export function findViolations(absPath, anchorsOf, scanRoot = root) {
  const file = relative(scanRoot, absPath);
  const dir = dirname(absPath);
  const source = readFileSync(absPath, "utf8");
  const tree = parseMarkdown(source);
  const out = [];

  const check = (url, node) => {
    if (isExternal(url)) return;
    const target = pathPart(url);
    const resolved = target === "" ? absPath : resolve(dir, target);
    if (!existsSync(resolved)) {
      out.push({ file, line: node.position?.start.line ?? 0, url, reason: "target" });
      return;
    }
    const fragment = fragmentPart(url);
    if (fragment === null || !resolved.endsWith(".md")) return;
    if (!anchorsOf(resolved).has(fragment)) {
      out.push({ file, line: node.position?.start.line ?? 0, url, reason: "anchor" });
    }
  };

  visitMarkdown(tree, (node) => {
    if ((node.type === "link" || node.type === "image" || node.type === "definition") && "url" in node) {
      check(node.url, node);
    }
  });
  return out;
}

if (isMainModule(import.meta.filename)) {
  const files = markdownLinkSourcePaths(root);
  const anchorsOf = anchorCache();
  const all = files.flatMap((file) => findViolations(resolve(root, file), anchorsOf));
  const checked = files.length;

  if (all.length === 0) {
    console.log(`verify-md-links: ${checked} file(s) checked, all relative cross-links and fragments resolve.`);
    process.exit(0);
  }

  console.error("verify-md-links: broken relative cross-links found:");
  for (const v of all) {
    console.error(`  ${v.file}:${v.line}  ${v.url}  (${v.reason === "target" ? "target does not exist" : "no such anchor in target"})`);
  }
  process.exit(1);
}
