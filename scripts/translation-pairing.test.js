import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TRANSLATION_TARGET_PREFIX } from "./translation-links.js";
import { gitIndexPaths, readGitIndexBlob } from "./translation-pairing-git.js";
import {
  computeTranslationPairingRecord,
  parseTranslationPairingRecord,
  renderTranslationPairingRecord,
  translationPairingRecordDiff,
  translationPairPaths,
} from "./translation-pairing-record.js";
import {
  isTranslationPairingManifestExcluded,
  isTranslationScopeFile,
  isTranslationScopeGlobExcluded,
  languageSwitcherTargets,
  pairAnchorOfArgument,
  parseTranslationMarkdown,
  parseTranslationPairingCliArgs,
  parseTranslationPairingManifest,
  generatedRegions,
  renderGeneratedRegion,
  spliceGeneratedRegion,
  requiresSourceLanguageSwitcher,
  translationPairSourcePredicate,
  translationStructureDiff,
  translationStructureSignature,
} from "./translation-pairing.js";

// Bilingual pairing: index reads, the exclusions manifest, switchers, section
// records, corpus scope, structural signatures, CLI arguments, and generated regions.

const fixturePairSource = () => true;

function signature(markdown) {
  return translationStructureSignature(
    parseTranslationMarkdown(markdown),
    "counterpart.zh.md",
    {
      repoRoot: process.cwd(), sourcePath: "counterpart.md",
      isTranslationPairSource: fixturePairSource, repositoryFileExists: () => true, markdown,
    },
  );
}

function fixtureSignature(root, sourcePath, markdown, switcherTarget) {
  return translationStructureSignature(
    parseTranslationMarkdown(markdown),
    switcherTarget,
    { repoRoot: root, sourcePath, isTranslationPairSource: fixturePairSource, markdown },
  );
}

function withTemp(prefix, run) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("translation pairing index reads", () => {
  it("reads staged bytes independently of the working tree", () => {
    withTemp("yolo-translation-pairing-index-", (root) => {
      execFileSync("git", ["init", "--quiet", root], { env: { ...process.env, GIT_DEFAULT_HASH: "sha1" } });
      writeFileSync(join(root, "owner.md"), "staged");
      execFileSync("git", ["-C", root, "add", "owner.md"]);
      writeFileSync(join(root, "owner.md"), "unstaged");

      assert.equal(readGitIndexBlob(root, "owner.md")?.toString("utf8"), "staged");
      assert.equal(readGitIndexBlob(root, "absent.md"), undefined);
    });
  });

  it("lists exact index files without treating a directory prefix as one entry", () => {
    withTemp("yolo-translation-pairing-index-", (root) => {
      execFileSync("git", ["init", "--quiet", root], { env: { ...process.env, GIT_DEFAULT_HASH: "sha1" } });
      mkdirSync(join(root, ".agents/notes"), { recursive: true });
      writeFileSync(join(root, ".agents/notes/reference.md"), "# Reference\n");
      writeFileSync(join(root, ".agents/notes/reference.zh.md"), "# 参考\n");
      execFileSync("git", ["-C", root, "add", ".agents"]);

      assert.deepEqual(gitIndexPaths(root), new Set([
        ".agents/notes/reference.md",
        ".agents/notes/reference.zh.md",
      ]));
    });
  });
});

describe("translation pairing manifest", () => {
  it("accepts an exclusions-only manifest", () => {
    const manifest = parseTranslationPairingManifest(JSON.stringify({ excluded: [".agents/notes/generated/"] }));
    assert.deepEqual(manifest, { excluded: [".agents/notes/generated/"] });
    assert.equal(isTranslationPairingManifestExcluded(".agents/notes/generated/page.md", manifest), true);
    assert.equal(translationPairSourcePredicate(manifest)(".agents/notes/generated/page.md"), false);
    assert.equal(translationPairSourcePredicate(manifest)(".agents/notes/guide.md"), true);
    assert.equal(translationPairSourcePredicate(manifest)("service/example/guide.md"), false);
  });

  for (const [field, value] of [
    ["required", ["service/README.md"]],
    ["requiredClasses", ["readme"]],
    ["requiredSince", "2026-07-14"],
  ]) {
    it(`rejects obsolete policy field ${field} instead of accepting an inert requirement`, () => {
      assert.throws(
        () => parseTranslationPairingManifest(JSON.stringify({ excluded: [], [field]: value })),
        { message: `translation-pairing.manifest.json: unsupported field(s): ${field}; every in-scope document is required` },
      );
    });
  }

  it("rejects a missing or non-string exclusion list", () => {
    assert.throws(() => parseTranslationPairingManifest("{}"), /excluded must be an array of strings/);
    assert.throws(() => parseTranslationPairingManifest(JSON.stringify({ excluded: [42] })), /excluded must be an array of strings/);
  });
});

describe("translation pairing switchers", () => {
  it("requires reciprocal switchers on every authored English source", () => {
    assert.equal(requiresSourceLanguageSwitcher("README.md"), true);
    assert.equal(requiresSourceLanguageSwitcher(".agents/notes/README.md"), true);
  });

  it("accepts only the canonical public URL for an absolute switcher", () => {
    const targets = languageSwitcherTargets("plugins/example/README.zh.md");
    const canonicalMarkdown = "# README\n\nEnglish | [中文](https://github.com/HaitianLiu5/yolo/blob/main/plugins/example/README.zh.md)\n";
    const wrongMarkdown = "# README\n\nEnglish | [中文](https://github.com/HaitianLiu5/yolo/blob/main/other/README.zh.md)\n";
    const context = (markdown) => ({
      repoRoot: process.cwd(), sourcePath: "plugins/example/README.md", isTranslationPairSource: fixturePairSource, markdown,
    });
    assert.deepEqual(translationStructureSignature(parseTranslationMarkdown(canonicalMarkdown), targets, context(canonicalMarkdown)).links, []);
    assert.deepEqual(translationStructureSignature(parseTranslationMarkdown(wrongMarkdown), targets, context(wrongMarkdown)).links, [
      "https://github.com/HaitianLiu5/yolo/blob/main/other/README.zh.md",
    ]);
  });

  it("excludes only the header switcher from the structural links", () => {
    withTemp("yolo-translation-switcher-", (root) => {
      writeFileSync(join(root, "guide.md"), "# Guide\n");
      writeFileSync(join(root, "guide.zh.md"), "# 指南\n");
      const markdown = "# 指南\n\n[English](guide.md) | 中文\n\n[正文](guide.md)\n";
      assert.deepEqual(translationStructureSignature(
        parseTranslationMarkdown(markdown),
        languageSwitcherTargets("guide.md"),
        { repoRoot: root, sourcePath: "guide.zh.md", isTranslationPairSource: fixturePairSource, markdown },
      ).links, [`${TRANSLATION_TARGET_PREFIX}guide.md`]);
    });
  });
});

describe("translation pairing link language parity", () => {
  it("compares a .zh.md target and its .md sibling as the same document", () => {
    const en = "See [docs](persistence.md) and [notes](note.md#anchor).";
    const zh = "参见[文档](persistence.zh.md)与[笔记](note.zh.md#anchor)。";
    assert.deepEqual(translationStructureDiff(signature(en), signature(zh)), []);
  });

  it("still rejects a genuinely different target", () => {
    const en = "See [docs](persistence.md).";
    const zh = "参见[文档](other.md)。";
    assert.notDeepEqual(translationStructureDiff(signature(en), signature(zh)), []);
  });
});

describe("translation pairing records", () => {
  const paths = translationPairPaths(".agents/notes/foo.md");
  const context = { repoRoot: process.cwd(), isTranslationPairSource: fixturePairSource, repositoryFileExists: () => true };
  const record = (en, zh) => computeTranslationPairingRecord(paths, en, zh, context);
  const en = [
    "# Guide", "", "English | [中文](foo.zh.md)", "", "Intro.", "",
    "## Events", "", "Event table.", "", "| Event | Mode |", "| --- | --- |", "| `a` | `emit` |", "| `b` | `emit` |", "",
    "## Code", "", "```sh", "npm run x", "```", "",
  ].join("\n");
  const zh = [
    "# 指南", "", "[English](foo.md) | 中文", "", "简介。", "",
    "## 事件", "", "事件表。", "", "| Event | Mode |", "| --- | --- |", "| `a` | `emit` |", "| `b` | `emit` |", "",
    "## 代码", "", "```sh", "npm run x", "```", "",
  ].join("\n");

  it("keys sections by English heading path and hashes everything outside code blocks and generated regions", () => {
    const computed = record(en, zh);
    assert.deepEqual([...computed.keys()], ["/guide", "/guide/events", "/guide/code"]);
    assert.deepEqual(record(en.replace("npm run x", "npm run y"), zh.replace("npm run x", "npm run y")), computed);
    assert.notDeepEqual(record(
      en.replace("| `b` | `emit` |", "| `b` | `emit` |\n| `c` | `emit` |"),
      zh.replace("| `b` | `emit` |", "| `b` | `emit` |\n| `c` | `emit` |"),
    ), computed);
    const region = (rows) => renderGeneratedRegion("events", `| Event |\n| --- |\n${rows}`);
    assert.deepEqual(
      record(`${en}\n${region("| `a` |")}\n`, `${zh}\n${region("| `a` |")}\n`),
      record(`${en}\n${region("| `b` |")}\n`, `${zh}\n${region("| `b` |")}\n`),
    );
    assert.equal(record(`${en}\n## \`x\`\n\nshared\n`, `${zh}\n## \`x\`\n\nshared\n`).has("/guide/x"), true);
    const packaged = renderGeneratedRegion("pkg", "## `x`\n\n- `inject`: `a`\n\n```sh\nx\n```");
    assert.equal(record(`${en}\n${packaged}\n`, `${zh}\n${packaged}\n`).has("/guide/x"), false);
  });

  it("treats locale-localized paired links, frontmatter, and repeated headings deterministically", () => {
    const computed = record(
      `---\nkind: guide\n---\n${en}\nSee [bar](bar.md).\n\n## Events\n\nAgain.\n`,
      `---\nkind: 指南\n---\n${zh}\nSee [bar](bar.zh.md).\n\n## 事件\n\n再次。\n`,
    );
    assert.deepEqual([...computed.keys()], ["/", "/guide", "/guide/events", "/guide/code", "/guide/events~2"]);
    assert.deepEqual(
      record(`${en}\nSee [bar](bar.md).\n`, `${zh}\nSee [bar](bar.zh.md).\n`),
      record(`${en}\nSee [bar](bar.zh.md).\n`, `${zh}\nSee [bar](bar.md).\n`),
    );
  });

  it("retains section hashes after normalized links move later heading offsets", () => {
    const english = "# Guide\n\n[Reference](bar.md?x=1&amp;y=2#tail)\n\n## Tail\n\nTail body.\n";
    const chinese = "# 指南\n\n[参考](bar.zh.md?x=1&amp;y=2#tail)\n\n## 尾部\n\n尾部正文。\n";
    const trees = { en: parseTranslationMarkdown(english), zh: parseTranslationMarkdown(chinese) };
    const originalTrees = structuredClone(trees);
    const computed = computeTranslationPairingRecord(paths, english, chinese, context, trees);

    assert.deepEqual([...computed], [
      ["/guide", { en: "9bb582e1e764d317", zh: "5abb6b2c451be012" }],
      ["/guide/tail", { en: "945d8537bf1f2b5f", zh: "0a851cb395705d76" }],
    ]);
    assert.deepEqual(computed, record(english, chinese));
    assert.deepEqual(trees, originalTrees);
  });

  it("retains section hashes when the authored tree needs no link normalization", () => {
    const english = "# Guide\n\nBody.\n";
    const chinese = "# 指南\n\n正文。\n";
    const trees = { en: parseTranslationMarkdown(english), zh: parseTranslationMarkdown(chinese) };
    assert.deepEqual([...computeTranslationPairingRecord(paths, english, chinese, context, trees)], [
      ["/guide", { en: "5e1bfa97a822af7a", zh: "3409c92bef7306bb" }],
    ]);
  });

  it("refuses sides with different heading counts", () => {
    assert.throws(() => record(en, `${zh}\n## 额外\n`), { message: ".agents/notes/foo.md has 3 heading(s) but .agents/notes/foo.zh.md has 4" });
  });

  it("round-trips the canonical record and rejects malformed entries", () => {
    const computed = record(en, zh);
    const text = renderTranslationPairingRecord(paths, computed);
    assert.match(text, /^# Bilingual-pair consistency record for foo\.md \(\.agents\/notes\/README\.md\)/);
    assert.match(text, /npm run verify-translation-pairing -- --write \.agents\/notes\/foo\.md\n/);
    assert.deepEqual(parseTranslationPairingRecord(text), computed);
    assert.equal(parseTranslationPairingRecord(`/a:\n  en: ${"1".repeat(16)}\n`), undefined);
    assert.equal(parseTranslationPairingRecord(`/a:\n  zh: ${"1".repeat(16)}\n  en: ${"1".repeat(16)}\n`), undefined);
    assert.equal(parseTranslationPairingRecord(`/a:\n  en: ${"1".repeat(16)}\n  zh: ${"1".repeat(16)}\n`.repeat(2)), undefined);
    assert.equal(parseTranslationPairingRecord("foo.md: 3f786850e387550fdab836ed7e6dc881de23001b\n"), undefined);
  });

  it("names changed, unconfirmed, and removed sections", () => {
    const confirmed = record(en, zh);
    assert.deepEqual(translationPairingRecordDiff(confirmed, confirmed), []);
    assert.deepEqual(translationPairingRecordDiff(confirmed, record(en.replace("Intro.", "Intro!"), zh)),
      ["section /guide changed since confirmation (en)"]);
    assert.deepEqual(translationPairingRecordDiff(confirmed, record(`${en}\n## Tail\n\nx\n`, `${zh}\n## 尾部\n\ny\n`)),
      ["section /guide/tail has unconfirmed translated content"]);
    assert.deepEqual(translationPairingRecordDiff(
      new Map([...confirmed, ["/gone", { en: "0".repeat(16), zh: "0".repeat(16) }]]),
      confirmed,
    ), ["section /gone is recorded but no longer has translated content"]);
  });

  it("merges records of edits to different sections with the default text merge", () => {
    const edit = (heading, english, chinese) => renderTranslationPairingRecord(
      paths,
      record(en.replace(heading, english), zh.replace(heading === "Intro." ? "简介。" : "事件表。", chinese)),
    );
    withTemp("yolo-translation-pairing-merge-", (root) => {
      writeFileSync(join(root, "base"), renderTranslationPairingRecord(paths, record(en, zh)));
      writeFileSync(join(root, "current"), edit("Intro.", "New intro.", "新简介。"));
      writeFileSync(join(root, "other"), edit("Event table.", "New table.", "新表。"));
      const merged = spawnSync("git", ["merge-file", "-p", "current", "base", "other"], { cwd: root, encoding: "utf8" });
      assert.equal(merged.status, 0);
      assert.equal(merged.stdout, renderTranslationPairingRecord(paths, record(
        en.replace("Intro.", "New intro.").replace("Event table.", "New table."),
        zh.replace("简介。", "新简介。").replace("事件表。", "新表。"),
      )));
    });
  });
});

describe("translation scope discovery", () => {
  for (const file of [
    "README.md",
    "README.zh.md",
    "README.i18n.yaml",
    "CONTRIBUTING.md",
    "CONTRIBUTING.zh.md",
    "CONTRIBUTING.i18n.yaml",
    "plugins/source-plex/README.md",
    "future/subtree/readme.md",
    "service/node/README.zh.md",
    ".agents/notes/README.md",
    ".agents/notes/proposed/feature/2026-10-12-example.md",
    ".agents/notes/implemented/process/2026-10-12-example.i18n.yaml",
  ]) {
    it(`includes ${file}`, () => {
      assert.equal(isTranslationScopeFile(file), true);
    });
  }

  for (const file of [
    "service/node/CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "AGENTS.md",
    "skills/drive-in/SKILL.md",
    ".agents/skills/yolo-archive-agent-notes/SKILL.md",
    "other/tutorial.md",
    "plugins/example/README.txt",
    "node_modules/dependency/README.md",
    "clients/tesla/node_modules/dependency/README.md",
    "clients/tesla/dist/README.md",
    "coverage/report/README.md",
    "service/control/.wrangler/state/README.md",
    ".agents/notes/archived/process/2026-07-21-example.md",
  ]) {
    it(`excludes non-source or non-README path ${file}`, () => {
      assert.equal(isTranslationScopeFile(file), false);
    });
  }
});

describe("translation scope traversal", () => {
  it("prunes dependency, runtime, and generated directories by entry name or relative path", () => {
    for (const entry of ["node_modules", "clients/tesla/dist", ".wrangler", { name: ".hls-cache" }]) {
      assert.equal(isTranslationScopeGlobExcluded(entry), true, JSON.stringify(entry));
    }
    for (const entry of ["clients", "README.md", ".agents", "notes/archived", { name: "service" }]) {
      assert.equal(isTranslationScopeGlobExcluded(entry), false, JSON.stringify(entry));
    }
  });
});

describe("translation structural signature", () => {
  it("retains external GFM autolinks without parsing inline-link syntax", () => {
    assert.deepEqual(signature("<https://example.com/reference.md>\n").links, ["https://example.com/reference.md"]);
  });

  it("retains exact authored bytes for ordinary external link targets", () => {
    const escaped = signature("[External](https://example.com/?x=1&amp;y=2)\n");
    const literal = signature("[External](https://example.com/?x=1&y=2)\n");
    assert.deepEqual(escaped.links, ["https://example.com/?x=1&amp;y=2"]);
    assert.deepEqual(translationStructureDiff(escaped, literal), [
      "link target #1 diverges between the pair: \"https://example.com/?x=1&amp;y=2\" vs \"https://example.com/?x=1&y=2\"",
    ]);
  });

  it("treats target-locale siblings as one semantic link target", () => {
    withTemp("yolo-translation-structure-", (root) => {
      writeFileSync(join(root, "reference.md"), "# Reference\n");
      writeFileSync(join(root, "reference.zh.md"), "# 参考\n");
      const source = fixtureSignature(root, "guide.md", "[Reference](reference.md?view=full#section)\n", "guide.zh.md");
      const counterpart = fixtureSignature(root, "guide.zh.md", "[参考](reference.zh.md?view=full#section)\n", "guide.md");
      assert.deepEqual(translationStructureDiff(source, counterpart), []);
    });
  });

  it("includes reference-style document links but excludes image-only definitions", () => {
    withTemp("yolo-translation-structure-", (root) => {
      writeFileSync(join(root, "reference.md"), "# Reference\n");
      writeFileSync(join(root, "reference.zh.md"), "# 参考\n");
      const markdown = ["[Reference][doc]", "", "![Preview][asset]", "", "[doc]: reference.md", "[asset]: reference.zh.md", ""].join("\n");
      assert.deepEqual(translationStructureSignature(
        parseTranslationMarkdown(markdown),
        "guide.zh.md",
        { repoRoot: root, sourcePath: "guide.md", isTranslationPairSource: fixturePairSource, markdown },
      ).links, [`${TRANSLATION_TARGET_PREFIX}reference.md`]);
    });
  });

  it("compares the first duplicate reference definition that CommonMark resolves", () => {
    withTemp("yolo-translation-structure-", (root) => {
      for (const name of ["reference", "different", "other"]) {
        writeFileSync(join(root, `${name}.md`), `# ${name}\n`);
        writeFileSync(join(root, `${name}.zh.md`), `# ${name} zh\n`);
      }
      const source = fixtureSignature(root, "guide.md", "[Reference][ref]\n\n[ref]: reference.md\n[ref]: other.md\n", "guide.zh.md");
      const counterpart = fixtureSignature(root, "guide.zh.md", "[参考][ref]\n\n[ref]: different.zh.md\n[ref]: other.zh.md\n", "guide.md");
      assert.deepEqual(translationStructureDiff(source, counterpart), [
        `link target #1 diverges between the pair: "${TRANSLATION_TARGET_PREFIX}reference.md" vs "${TRANSLATION_TARGET_PREFIX}different.md"`,
      ]);
    });
  });

  it("accepts matching list kinds, starts, and item counts", () => {
    assert.deepEqual(translationStructureDiff(signature("3. One\n4. Two\n\n- A\n- B\n"), signature("3. 一\n4. 二\n\n- 甲\n- 乙\n")), []);
  });

  it("rejects an altered ordered-list start", () => {
    assert.deepEqual(translationStructureDiff(signature("3. One\n4. Two\n\n- A\n- B\n"), signature("1. 一\n2. 二\n\n- 甲\n- 乙\n")), [
      "list (kind, start, item count) #1 diverges between the pair: \"ordered:start=3:items=2\" vs \"ordered:start=1:items=2\"",
    ]);
  });

  it("rejects a missing list item", () => {
    assert.deepEqual(translationStructureDiff(signature("- A\n- B\n"), signature("- 甲\n")), [
      "list (kind, start, item count) #1 diverges between the pair: \"bullet:items=2\" vs \"bullet:items=1\"",
    ]);
  });

  it("rejects altered table row or column counts", () => {
    assert.deepEqual(translationStructureDiff(
      signature("| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n"),
      signature("| 甲 | 乙 |\n|---|---|\n| 一 | 二 |\n"),
    ), ["table (row x column count) #1 diverges between the pair: \"3x2\" vs \"2x2\""]);
  });

  it("rejects differing heading depths and code blocks", () => {
    const diff = translationStructureDiff(signature("# A\n\n## B\n\n```sh\nx\n```\n"), signature("# 甲\n\n### 乙\n\n```sh\ny\n```\n"));
    assert.equal(diff.length, 2);
    assert.match(diff[0], /^heading \(depth\) #2 diverges/);
    assert.match(diff[1], /^code block #1 diverges/);
  });
});

describe("pair CLI arguments", () => {
  it("normalizes any pair file or bare stem to the English anchor", () => {
    assert.equal(pairAnchorOfArgument(".agents/notes/foo.md"), ".agents/notes/foo.md");
    assert.equal(pairAnchorOfArgument(".agents/notes/foo.zh.md"), ".agents/notes/foo.md");
    assert.equal(pairAnchorOfArgument(".agents/notes/foo.i18n.yaml"), ".agents/notes/foo.md");
    assert.equal(pairAnchorOfArgument(".agents/notes/foo"), ".agents/notes/foo.md");
    assert.equal(pairAnchorOfArgument(".\\notes\\foo.zh.md"), "notes/foo.md");
  });

  it("scopes a check to named pairs and dedupes the three spellings", () => {
    assert.deepEqual(parseTranslationPairingCliArgs(["n/foo.zh.md", "n/foo.i18n.yaml", "n/bar.md"]), {
      input: "worktree", mode: "check", scope: "pairs", anchors: ["n/bar.md", "n/foo.md"],
    });
    assert.deepEqual(parseTranslationPairingCliArgs([]), { input: "worktree", mode: "check", scope: "corpus", anchors: [] });
  });

  it("requires --write to name confirmed pairs or opt into --all", () => {
    assert.throws(() => parseTranslationPairingCliArgs(["--write"]), /requires the pair\(s\) you confirmed/);
    assert.deepEqual(parseTranslationPairingCliArgs(["--write", "n/foo.md"]), { input: "worktree", mode: "write", scope: "pairs", anchors: ["n/foo.md"] });
    assert.deepEqual(parseTranslationPairingCliArgs(["--write", "--all"]), { input: "worktree", mode: "write", scope: "corpus", anchors: [] });
    assert.throws(() => parseTranslationPairingCliArgs(["--write", "--all", "n/foo.md"]), /not both/);
  });

  it("keeps --list corpus-only and rejects unknown flags", () => {
    assert.deepEqual(parseTranslationPairingCliArgs(["--list"]), { input: "worktree", mode: "list", scope: "corpus", anchors: [] });
    assert.throws(() => parseTranslationPairingCliArgs(["--list", "n/foo.md"]), /takes no other flags or paths/);
    assert.throws(() => parseTranslationPairingCliArgs(["--all"]), /--all only applies to --write/);
    assert.throws(() => parseTranslationPairingCliArgs(["--frobnicate"]), /unknown flag\(s\): --frobnicate/);
  });

  it("makes cached verification a named, read-only index check", () => {
    assert.deepEqual(parseTranslationPairingCliArgs(["--cached", "n/foo.i18n.yaml"]), { input: "index", mode: "check", scope: "pairs", anchors: ["n/foo.md"] });
    assert.throws(() => parseTranslationPairingCliArgs(["--cached"]), /requires the staged pair paths/);
    assert.throws(() => parseTranslationPairingCliArgs(["--cached", "--write", "n/foo.md"]), /read-only/);
  });
});

describe("generated regions", () => {
  const BEGIN = "<!-- BEGIN GENERATED tool-table (gen-tools.js) — do not edit between markers -->";
  const END = "<!-- END GENERATED tool-table -->";

  it("locates marker-delimited regions with their slugs and marker lines", () => {
    const doc = `# T\n\nprose\n\n${BEGIN}\ninjected\n${END}\ntail\n`;
    assert.deepEqual(generatedRegions(doc), [{ slug: "tool-table", begin: 4, end: 6, text: `${BEGIN}\ninjected\n${END}` }]);
    assert.deepEqual(generatedRegions("# T\n\nprose\n"), []);
  });

  it("replaces exactly one region with the same slug", () => {
    const doc = `a\n${renderGeneratedRegion("x", "old")}\n${renderGeneratedRegion("y", "keep")}\nb\n`;
    assert.equal(spliceGeneratedRegion(doc, renderGeneratedRegion("x", "new\nlines")),
      `a\n${renderGeneratedRegion("x", "new\nlines")}\n${renderGeneratedRegion("y", "keep")}\nb\n`);
    assert.throws(() => spliceGeneratedRegion("a\n", renderGeneratedRegion("x", "new")), /expected exactly 1 generated region 'x', found 0/);
  });

  it("rejects unbalanced or nested markers", () => {
    assert.throws(() => generatedRegions(`${END}\n`), /without a BEGIN/);
    assert.throws(() => generatedRegions(`${BEGIN}\n`), /without an END/);
    assert.throws(() => generatedRegions(`${BEGIN}\n${BEGIN}\n${END}\n`), /nested/);
  });

  it("rejects mismatched slugs and malformed marker lines", () => {
    assert.throws(() => generatedRegions("<!-- BEGIN GENERATED a -->\nx\n<!-- END GENERATED b -->\n"), /END slug 'b' does not match its BEGIN slug 'a'/);
    assert.throws(() => generatedRegions("<!-- BEGIN GENERATED a --> trailing\nx\n<!-- END GENERATED a -->\n"), /malformed generated region marker line/);
    assert.throws(() => generatedRegions("x\n<!-- END GENERATED a --> tail\n"), /malformed generated region marker line/);
  });
});
