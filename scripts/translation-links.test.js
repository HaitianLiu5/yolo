import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseMarkdown } from "./markdown.js";
import {
  normalizeTranslationMarkdownLinks,
  TRANSLATION_TARGET_PREFIX,
  translationLinkLocaleViolations,
} from "./translation-links.js";

// Locale-aware bilingual Markdown links: wrong-locale diagnostics and the
// locale-neutral normalization the pairing records hash.

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "yolo-translation-links-"));
  roots.push(root);
  mkdirSync(join(root, "notes/section"), { recursive: true });
  mkdirSync(join(root, "service"), { recursive: true });
  writeFileSync(join(root, "notes/guide.md"), "# Guide\n");
  writeFileSync(join(root, "notes/guide.zh.md"), "# 指南\n");
  writeFileSync(join(root, "notes/reference.md"), "# Overview\n");
  writeFileSync(join(root, "notes/reference.zh.md"), "# 概览\n");
  writeFileSync(join(root, "notes/unpaired.md"), "# Only\n");
  writeFileSync(join(root, "notes/section/index.md"), "# Section\n");
  writeFileSync(join(root, "notes/section/index.zh.md"), "# 章节\n");
  writeFileSync(join(root, "service/outside.md"), "# Outside\n");
  writeFileSync(join(root, "service/outside.zh.md"), "# 范围外\n");
  return root;
}

function linkContext(root, sourcePath, repositoryFileExists) {
  return {
    repoRoot: root,
    sourcePath,
    isTranslationPairSource: (path) => path.startsWith("notes/"),
    ...(repositoryFileExists === undefined ? {} : { repositoryFileExists }),
  };
}

describe("translation link locale validation", () => {
  it("decodes an encoded filename and keeps its query and fragment in the expected link", () => {
    const root = fixture();
    const input = "[概览](reference%2Emd?view=full&amp;mode=all#overview)\n";
    const [violation] = translationLinkLocaleViolations(input, linkContext(root, "notes/guide.zh.md"));
    assert.equal(violation.url, "reference%2Emd?view=full&amp;mode=all#overview");
    assert.equal(violation.expectedUrl, "reference.zh.md?view=full&amp;mode=all#overview");
  });

  it("accepts the target-locale sibling and an out-of-scope target with its own sibling", () => {
    const root = fixture();
    assert.deepEqual(translationLinkLocaleViolations(
      "[paired](reference.zh.md) [outside](../service/outside.md)\n",
      linkContext(root, "notes/guide.zh.md"),
    ), []);
  });

  it("requires English sources to use the English sibling", () => {
    const root = fixture();
    const [violation] = translationLinkLocaleViolations("[Reference](reference.zh.md)\n", linkContext(root, "notes/guide.md"));
    assert.equal(violation.url, "reference.zh.md");
    assert.equal(violation.expectedUrl, "reference.md");
  });

  it("exempts the language switcher, not an ordinary body link to the counterpart", () => {
    const root = fixture();
    const markdown = "# 指南\n\n[English](guide.md) | 中文\n\n[正文](guide.md)\n";
    assert.deepEqual(translationLinkLocaleViolations(markdown, linkContext(root, "notes/guide.zh.md"), ["guide.md"]), [{
      sourcePath: "notes/guide.zh.md",
      line: 5,
      url: "guide.md",
      expectedUrl: "guide.zh.md",
    }]);
  });

  it("uses the selected content plane for target existence without deriving scope from siblings", () => {
    const root = fixture();
    const staged = new Set(["notes/reference.md", "notes/reference.zh.md"]);
    const check = () => translationLinkLocaleViolations(
      "[概览](reference.md)\n",
      linkContext(root, "notes/guide.zh.md", (path) => staged.has(path)),
    );
    assert.equal(check().length, 1);
    staged.delete("notes/reference.zh.md");
    assert.equal(check().length, 1);
    staged.delete("notes/reference.md");
    assert.deepEqual(check(), []);
  });
});

describe("translation link normalization", () => {
  it("reuses an authored tree without changing its offsets, switcher exemption, or reference resolution", () => {
    const root = fixture();
    const input = "# 指南\n\n[English](guide.md) | 中文\n\n[行内](reference.md?view=full&amp;x=1#overview \"标题\")\n\n[引用][ref]\n\n[ref]: <reference.md#tail> \"标注\"\n[ref]: unpaired.md\n";
    const context = linkContext(root, "notes/guide.zh.md");
    const tree = parseMarkdown(input);
    const originalTree = structuredClone(tree);

    assert.equal(
      normalizeTranslationMarkdownLinks(input, context, ["guide.md"], tree),
      `# 指南\n\n[English](guide.md) | 中文\n\n[行内](${TRANSLATION_TARGET_PREFIX}notes/reference.md?view=full&amp;x=1#overview "标题")\n\n[引用][ref]\n\n[ref]: <${TRANSLATION_TARGET_PREFIX}notes/reference.md#tail> "标注"\n[ref]: unpaired.md\n`,
    );
    assert.deepEqual(translationLinkLocaleViolations(input, context, ["guide.md"], tree), [
      { sourcePath: "notes/guide.zh.md", line: 5, url: "reference.md?view=full&amp;x=1#overview", expectedUrl: "reference.zh.md?view=full&amp;x=1#overview" },
      { sourcePath: "notes/guide.zh.md", line: 9, url: "reference.md#tail", expectedUrl: "reference.zh.md#tail" },
    ]);
    assert.deepEqual(tree, originalTree);
  });

  it("leaves a GFM autolink unchanged", () => {
    const input = "https://example.com/reference.md\n";
    const context = linkContext(fixture(), "notes/guide.md");
    assert.deepEqual(translationLinkLocaleViolations(input, context), []);
    assert.equal(normalizeTranslationMarkdownLinks(input, context), input);
  });
});
