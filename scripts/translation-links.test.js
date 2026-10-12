import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseMarkdown } from "./markdown.js";
import {
  normalizeTranslationMarkdownLinks,
  rewriteTranslationLinkLocales,
  TRANSLATION_TARGET_PREFIX,
  translationLinkLocaleViolations,
} from "./translation-links.js";

// Locale-aware bilingual Markdown links: wrong-locale diagnostics, byte-preserving
// rewrites, and the locale-neutral normalization the pairing records hash.

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

function assertUnchangedLinkInput(root, input) {
  const context = linkContext(root, "notes/guide.md");
  assert.deepEqual(translationLinkLocaleViolations(input, context), []);
  assert.deepEqual(rewriteTranslationLinkLocales(input, context), { content: input, rewritten: 0 });
  assert.equal(normalizeTranslationMarkdownLinks(input, context), input);
}

describe("translation link locale validation", () => {
  it("rejects a Chinese link to the English sibling with an exact diagnostic", () => {
    const root = fixture();
    assert.deepEqual(translationLinkLocaleViolations(
      "# 指南\n\n正文。\n\n[概览](reference.md?view=full#overview)\n",
      linkContext(root, "notes/guide.zh.md"),
    ), [{
      sourcePath: "notes/guide.zh.md",
      line: 5,
      url: "reference.md?view=full#overview",
      expectedUrl: "reference.zh.md?view=full#overview",
    }]);
  });

  it("rewrites an encoded exact filename without changing its query or fragment suffix", () => {
    const root = fixture();
    const input = "[概览](reference%2Emd?view=full&amp;mode=all#overview)\n";
    const [violation] = translationLinkLocaleViolations(input, linkContext(root, "notes/guide.zh.md"));
    assert.equal(violation.url, "reference%2Emd?view=full&amp;mode=all#overview");
    assert.equal(violation.expectedUrl, "reference.zh.md?view=full&amp;mode=all#overview");
    assert.deepEqual(rewriteTranslationLinkLocales(input, linkContext(root, "notes/guide.zh.md")), {
      content: "[概览](reference.zh.md?view=full&amp;mode=all#overview)\n",
      rewritten: 1,
    });
  });

  it("encodes each exact path segment with only RFC 3986 unreserved characters", () => {
    const root = fixture();
    const input = "[保留](a%29%23%3Fb%2Emd?view=full#section)\n";
    const repositoryFiles = new Set(["notes/a)#?b.md", "notes/a)#?b.zh.md"]);
    assert.deepEqual(rewriteTranslationLinkLocales(
      input,
      linkContext(root, "notes/guide.zh.md", (path) => repositoryFiles.has(path)),
    ), {
      content: "[保留](a%29%23%3Fb.zh.md?view=full#section)\n",
      rewritten: 1,
    });
  });

  it("accepts the target-locale sibling and an out-of-scope target with its own sibling", () => {
    const root = fixture();
    assert.deepEqual(translationLinkLocaleViolations(
      "[paired](reference.zh.md) [outside](../service/outside.md)\n",
      linkContext(root, "notes/guide.zh.md"),
    ), []);
  });

  it("does not fall back when an active target is missing its locale sibling", () => {
    const root = fixture();
    const [violation] = translationLinkLocaleViolations("[missing](unpaired.md)\n", linkContext(root, "notes/guide.zh.md"));
    assert.equal(violation.expectedUrl, "unpaired.zh.md");
  });

  it("requires English sources to use the English sibling", () => {
    const root = fixture();
    const [violation] = translationLinkLocaleViolations("[Reference](reference.zh.md)\n", linkContext(root, "notes/guide.md"));
    assert.equal(violation.url, "reference.zh.md");
    assert.equal(violation.expectedUrl, "reference.md");
  });

  it("does not infer an index page from a directory target", () => {
    const root = fixture();
    const input = "[Section](section/)\n";
    assert.deepEqual(translationLinkLocaleViolations(input, linkContext(root, "notes/guide.zh.md")), []);
    assert.deepEqual(rewriteTranslationLinkLocales(input, linkContext(root, "notes/guide.zh.md")), { content: input, rewritten: 0 });
  });

  it("exempts the language switcher target explicitly", () => {
    const root = fixture();
    assert.deepEqual(translationLinkLocaleViolations(
      "# 指南\n\n[English](guide.md) | 中文\n",
      linkContext(root, "notes/guide.zh.md"),
      ["guide.md"],
    ), []);
  });

  it("does not exempt an ordinary body link to the counterpart", () => {
    const root = fixture();
    const markdown = "# 指南\n\n[English](guide.md) | 中文\n\n[正文](guide.md)\n";
    assert.deepEqual(translationLinkLocaleViolations(markdown, linkContext(root, "notes/guide.zh.md"), ["guide.md"]), [{
      sourcePath: "notes/guide.zh.md",
      line: 5,
      url: "guide.md",
      expectedUrl: "guide.zh.md",
    }]);
    assert.equal(
      rewriteTranslationLinkLocales(markdown, linkContext(root, "notes/guide.zh.md"), ["guide.md"]).content,
      "# 指南\n\n[English](guide.md) | 中文\n\n[正文](guide.zh.md)\n",
    );
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

describe("translation link rewriting and normalization", () => {
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

  it("rewrites only the destination while preserving the suffix and title", () => {
    const root = fixture();
    assert.deepEqual(rewriteTranslationLinkLocales(
      "[概览](reference.md?view=full&amp;mode=all#overview \"reference.md title\")\n",
      linkContext(root, "notes/guide.zh.md"),
    ), {
      content: "[概览](reference.zh.md?view=full&amp;mode=all#overview \"reference.md title\")\n",
      rewritten: 1,
    });
  });

  it("rewrites link definitions without changing their labels", () => {
    const root = fixture();
    assert.equal(rewriteTranslationLinkLocales(
      "[概览][ref]\n\n[ref]: <reference.md#overview> \"title\"\n",
      linkContext(root, "notes/guide.zh.md"),
    ).content, "[概览][ref]\n\n[ref]: <reference.zh.md#overview> \"title\"\n");
  });

  it("uses only the first duplicate reference definition", () => {
    const root = fixture();
    assert.deepEqual(translationLinkLocaleViolations(
      "[概览][ref]\n\n[ref]: reference.zh.md\n[ref]: reference.md\n",
      linkContext(root, "notes/guide.zh.md"),
    ), []);
  });

  it("does not treat an image-only definition as a document link", () => {
    assertUnchangedLinkInput(fixture(), "![preview][asset]\n\n[asset]: reference.zh.md#overview\n");
  });

  for (const input of ["<https://example.com/reference.md>\n", "https://example.com/reference.md\n"]) {
    it(`leaves GFM autolink source unchanged: ${JSON.stringify(input)}`, () => {
      assertUnchangedLinkInput(fixture(), input);
    });
  }

  it("normalizes only paired locale paths and retains other bytes", () => {
    const root = fixture();
    const english = "[Reference](reference.md#overview) [Outside](../service/outside.md)\n";
    const chinese = "[Reference](reference.zh.md#overview) [Outside](../service/outside.md)\n";
    assert.equal(
      normalizeTranslationMarkdownLinks(english, linkContext(root, "notes/guide.md")),
      normalizeTranslationMarkdownLinks(chinese, linkContext(root, "notes/guide.zh.md")),
    );
  });

  it("retains authored query bytes during normalization", () => {
    const root = fixture();
    assert.notEqual(
      normalizeTranslationMarkdownLinks("[Reference](reference.md?x=1&amp;y=2#overview)\n", linkContext(root, "notes/guide.md")),
      normalizeTranslationMarkdownLinks("[Reference](reference.zh.md?x=1&y=2#overview)\n", linkContext(root, "notes/guide.zh.md")),
    );
  });
});
