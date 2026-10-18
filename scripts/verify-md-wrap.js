// Reject Markdown prose paragraphs spanning multiple physical lines. The GFM
// AST distinguishes paragraphs—including those in lists and blockquotes—from
// multiline structural nodes. The checker never rewrites; symlinked instruction
// files are deduped. Frontmatter is masked before parsing. The owning
// convention is the documentation standard in `.agents/notes/AGENTS.md`.

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isMainModule } from "./agent-note-tree.js";
import { parseMarkdown, visitMarkdown } from "./markdown.js";
import { isArchivedAgentNotePath, uniqueRepoFiles } from "./repo-files.js";

const root = resolve(import.meta.dirname, "..");

/** Files to check: the README pair, the Agent Notes, and the root instructions. */
const PATTERNS = [
  "README.md",
  "README.zh.md",
  ".agents/notes/**/*.md",
  "AGENTS.md",
];

function maskFrontmatter(source) {
  const lines = source.split("\n");
  if (lines[0] === "---") {
    const closing = lines.indexOf("---", 1);
    if (closing !== -1) {
      for (let index = 0; index <= closing; index++) lines[index] = "";
    }
  }
  return lines.join("\n");
}

/**
 * Find every hard-wrapped prose paragraph in one Markdown file via its AST.
 * @param {string} absPath
 * @param {string} [scanRoot]
 * @returns {{ file: string, line: number, text: string }[]}
 */
function findWrapViolations(absPath, scanRoot = root) {
  const file = relative(scanRoot, absPath);
  const source = readFileSync(absPath, "utf8");
  const tree = parseMarkdown(maskFrontmatter(source));
  const out = [];

  visitMarkdown(tree, (node) => {
    if (node.type === "paragraph" && node.position) {
      const { start, end } = node.position;
      if (end.line > start.line) {
        const firstLine = source.split("\n")[start.line - 1] ?? "";
        out.push({ file, line: start.line, text: firstLine.trim() });
      }
      // Paragraph children are inline, so no further paragraph can be nested.
      return false;
    }
    return undefined;
  });
  return out;
}

if (isMainModule(import.meta.filename)) {
  const files = uniqueRepoFiles(root, PATTERNS, isArchivedAgentNotePath);
  const all = files.flatMap((file) => findWrapViolations(file.abs));
  const checked = files.length;

  if (all.length === 0) {
    console.log(`verify-md-wrap: ${checked} file(s) checked, no hard-wrapped prose paragraphs.`);
    process.exit(0);
  }

  console.error("verify-md-wrap: hard-wrapped prose paragraphs found (write one physical line per paragraph):");
  for (const v of all) {
    console.error(`  ${v.file}:${v.line}  ${v.text.slice(0, 80)}${v.text.length > 80 ? "…" : ""}`);
  }
  process.exit(1);
}
