import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { anchorCache, documentAnchors, findViolations, markdownLinkSourcePaths } from "./verify-md-links.js";
import { findWrapViolations } from "./verify-md-wrap.js";

// Source discovery and fragment validation for verify-md-links, and the
// one-physical-line-per-paragraph rule of verify-md-wrap.

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function layout(files) {
  const root = mkdtempSync(join(tmpdir(), "md-links-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function violationsIn(root, rel) {
  return findViolations(join(root, rel), anchorCache(), root).map(({ url, reason }) => ({ url, reason }));
}

describe("Markdown source discovery", () => {
  it("checks root documents, notes, skills, and GitHub templates while excluding frozen notes", () => {
    const root = layout({
      "README.md": "[gone](docs/yolo-v1.md)\n",
      "README.zh.md": "[gone](docs/yolo-v1.zh.md)\n",
      ".github/PULL_REQUEST_TEMPLATE.md": "[missing](missing.md)\n",
      ".agents/notes/implemented/process/2026-10-12-x.md": "[missing](missing.md)\n",
      ".agents/skills/example/SKILL.md": "[missing](missing.md)\n",
      "skills/drive-in/SKILL.md": "[missing](missing.md)\n",
      ".agents/notes/archived/process/2026-07-21-frozen.md": "[historical](missing.md)\n",
      "service/node/notes.md": "[unchecked](missing.md)\n",
    });
    const sources = markdownLinkSourcePaths(root);
    const violations = sources.flatMap((file) => findViolations(join(root, file), anchorCache(), root));
    assert.deepEqual(violations.map(({ file }) => file).sort(), [
      join(".agents", "notes", "implemented", "process", "2026-10-12-x.md"),
      join(".agents", "skills", "example", "SKILL.md"),
      join(".github", "PULL_REQUEST_TEMPLATE.md"),
      "README.md",
      "README.zh.md",
      join("skills", "drive-in", "SKILL.md"),
    ]);
  });
});

describe("documentAnchors", () => {
  it("slugs rendered heading text the way GitHub does, suffixes repeats past occupied slugs, and reads explicit <a id> anchors", () => {
    const anchors = documentAnchors([
      "# My Doc", "## Live `events` — mode!", "## Showcase: web_fetch", "## 布局与命名", "## [Install](setup.md)",
      "## Repeat", "## Repeat-1", "## Repeat", "<a id=\"hand-anchor\"></a>", "",
    ].join("\n"));
    assert.deepEqual(anchors, new Set([
      "my-doc", "live-events--mode", "showcase-web_fetch", "布局与命名", "install", "repeat", "repeat-1", "repeat-2", "hand-anchor",
    ]));
  });

  it("ignores <a id> inside code fences, inline code, and HTML comments", () => {
    const anchors = documentAnchors([
      "# Doc", "```md", "<a id=\"fenced\"></a>", "```", "Inline `<a id=\"inline\"></a>` sample.",
      "<!-- <a id=\"commented\"></a> -->", "<a id=\"real\"></a>", "",
    ].join("\n"));
    assert.deepEqual(anchors, new Set(["doc", "real"]));
  });
});

describe("findViolations fragments", () => {
  it("accepts resolving same-file and cross-file fragments, non-md fragments, and externals", () => {
    const root = layout({
      "a.md": "# A\n\n## Deferred work\n\n[self](#deferred-work) [b](b.md#part-two) [code](x.js#L10) [ext](https://x.example/#frag)\n",
      "b.md": "# B\n\n## Part two\n",
      "x.js": "export {};\n",
    });
    assert.deepEqual(violationsIn(root, "a.md"), []);
  });

  it("rejects a same-file fragment that names no heading or <a id>, matching case exactly", () => {
    const root = layout({ "a.md": "# A\n\n## Default Loop\n\n[gone](#deferred-work) [case](#Default-Loop)\n" });
    assert.deepEqual(violationsIn(root, "a.md"), [{ url: "#deferred-work", reason: "anchor" }, { url: "#Default-Loop", reason: "anchor" }]);
  });

  it("rejects a cross-file fragment missing from its target, and a missing target as a target", () => {
    const root = layout({ "a.md": "# A\n\n[stale](b.md#old-heading) [ghost](missing.md#anything)\n", "b.md": "# B\n\n## New heading\n" });
    assert.deepEqual(violationsIn(root, "a.md"), [{ url: "b.md#old-heading", reason: "anchor" }, { url: "missing.md#anything", reason: "target" }]);
  });
});

describe("verify-md-wrap", () => {
  it("rejects hard-wrapped paragraphs, including list items, and ignores code and tables", () => {
    const root = layout({
      "a.md": [
        "# A", "", "One line paragraph.", "", "Wrapped", "paragraph.", "", "- item", "  continued", "",
        "```sh", "line one", "line two", "```", "", "| a | b |", "|---|---|", "| 1 | 2 |", "",
      ].join("\n"),
      "b.md": "---\ntitle: x\nkind: y\n---\n# B\n\nFine.\n",
    });
    assert.deepEqual(findWrapViolations(join(root, "a.md"), root).map(({ line, text }) => ({ line, text })), [
      { line: 5, text: "Wrapped" },
      { line: 8, text: "- item" },
    ]);
    assert.deepEqual(findWrapViolations(join(root, "b.md"), root), []);
  });
});
