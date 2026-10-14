import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AGENT_NOTE_CLASSES, walkAgentNoteTree } from "./agent-note-tree.js";
import { gitBlobHash } from "./archived-agent-notes.js";
import { runGates } from "./run-gates.js";
import { agentNoteClassification } from "./verify-agent-note-classification.js";
import { agentNoteFormat } from "./verify-agent-note-format.js";
import { verifyArchivedAgentNotes } from "./verify-archived-agent-notes.js";
import { verifyTranslationPairing } from "./verify-translation-pairing.js";

// The Agent Note gates end to end over fixture repositories: tree structure,
// in-file format, the frozen archive, bilingual pairing, and the doc-sync runner.

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "yolo-agent-notes-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return root;
}

function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

// The throwaway repositories must not inherit GIT_DIR and friends: a hook or
// `git rebase --exec` sets them, and git (here and in the gates under test)
// would then read and write the real repository instead.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
const gitEnv = () => ({ ...process.env, GIT_DEFAULT_HASH: "sha1" });

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: gitEnv() });
}

function initGit(root) {
  execFileSync("git", ["init", "--quiet", root], { env: gitEnv() });
  git(root, "config", "user.email", "notes@example.test");
  git(root, "config", "user.name", "Notes Test");
  git(root, "config", "commit.gpgsign", "false");
}

function commitAll(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "--no-verify", "-m", message);
}

const implemented = (title, extra = "") => `# Agent Note: ${title}\n\nStatus: implemented\n\n## Problem\n\nWhy.\n\n## Decision\n\nWhat.\n\n## Alternatives considered\n\n**Other.** Lost.\n\n## Consequences\n\nCost.\n${extra}`;
const proposed = (title) => `# Agent Note: ${title}\n\nStatus: proposed\n\n## Problem\n\nWhy.\n\n## Proposal\n\nPlan.\n\n## Alternatives considered\n\n**Other.** Lost.\n\n## Acceptance criteria\n\nDone.\n\n## Risks\n\nRisk.\n`;

describe("Agent Note tree structure", () => {
  it("accepts dated notes in known lifecycle/class folders and skips counterparts and instructions, CLAUDE.md included", () => {
    const root = repo({
      "implemented/AGENTS.md": "# AGENTS.md\n",
      "implemented/process/2026-10-12-a.md": implemented("A"),
      "implemented/process/2026-10-12-a.zh.md": "# Agent Note: 甲\n",
      "proposed/feature/2026-10-11-b.md": proposed("B"),
      "archived/process/2026-07-21-c.md": "frozen\n",
    });
    symlinkSync("AGENTS.md", join(root, "implemented/CLAUDE.md"));
    const { notes, errors } = walkAgentNoteTree(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(notes.map((note) => note.rel), ["proposed/feature/2026-10-11-b.md", "implemented/process/2026-10-12-a.md"]);
    assert.equal(notes[1].date, "2026-10-12");
  });

  it("rejects an index, unknown folders, wrong depth, and undated names", () => {
    const root = repo({
      "INDEX.md": "# Index\n",
      "drafts/x.md": "x\n",
      "implemented/refactor/2026-10-12-x.md": "x\n",
      "implemented/process/deep/2026-10-12-x.md": "x\n",
      "implemented/process/topic.md": "x\n",
      "rejected/stray.md": "x\n",
    });
    const errors = walkAgentNoteTree(root).errors.join("\n");
    assert.match(errors, /INDEX\.md — centralized Agent Note indexes are forbidden/);
    assert.match(errors, /drafts\/ — unknown lifecycle folder/);
    assert.match(errors, /unknown class folder "refactor"/);
    assert.match(errors, /expected \{lifecycle\}\/\{class\}\/file\.md \(got depth 4\)/);
    assert.match(errors, /topic\.md — filename must be yyyy-mm-dd-topic\.md/);
    assert.match(errors, /rejected\/stray\.md — expected/);
    // The closed class set, as .agents/notes/README.md lists it.
    assert.deepEqual(AGENT_NOTE_CLASSES, ["feature", "bug-fix", "simplification", "architecture", "process", "testing"]);
  });

  it("forbids a docs/ folder beside the notes", () => {
    const root = repo({ ".agents/notes/implemented/process/2026-10-12-a.md": implemented("A") });
    assert.deepEqual(agentNoteClassification(join(root, ".agents/notes"), root).errors, []);
    write(root, "docs/guide.md", "# Guide\n");
    assert.match(agentNoteClassification(join(root, ".agents/notes"), root).errors.join("\n"), /legacy-path: docs\/ is forbidden/);
  });
});

describe("Agent Note format", () => {
  it("accepts each lifecycle's skeleton and ignores tokens inside fenced examples", () => {
    const root = repo({
      "implemented/process/2026-10-12-a.md": implemented("A", "\n```markdown\n## Proposal\nStatus: proposed\n```\n"),
      "proposed/feature/2026-10-12-b.md": proposed("B"),
      "rejected/architecture/2026-10-12-c.md": "# Agent Note: C\n\nStatus: rejected — the terms forbid it\n\n## Problem\n\nWhy.\n\n## Proposal\n\nPlan.\n\n## Alternatives considered\n\nNone.\n\n## Acceptance criteria\n\nKept from the proposal.\n",
    });
    assert.deepEqual(agentNoteFormat(root).errors, []);
  });

  it("rejects header, status, section, and spec-speak violations", () => {
    const root = repo({
      "implemented/process/2026-10-12-header.md": "# Note: Header\nStatus: implemented\n\n## Problem\n\n## Decision\n\n## Alternatives considered\n\n## Consequences\n",
      "implemented/process/2026-10-12-status.md": "# Agent Note: Status\n\nStatus: proposed\n\n## Problem\n\n## Decision\n\n## Alternatives considered\n\n## Consequences\n",
      "implemented/process/2026-10-12-twice.md": implemented("Twice", "\nStatus: implemented\n"),
      "implemented/process/2026-10-12-plan.md": implemented("Plan", "\n## Migration plan\n\nSteps.\n"),
      "proposed/feature/2026-10-12-missing.md": "# Agent Note: Missing\n\nStatus: proposed\n\n## Proposal\n\nPlan.\n",
      "rejected/feature/2026-10-12-reason.md": "# Agent Note: Reason\n\nStatus: rejected\n\n## Problem\n\n## Proposal\n\n## Alternatives considered\n",
    });
    const errors = agentNoteFormat(root).errors.join("\n");
    assert.match(errors, /2026-10-12-header\.md — line 1 must be `# Agent Note: <title>`/);
    assert.match(errors, /2026-10-12-header\.md — line 2 must be blank/);
    assert.match(errors, /2026-10-12-status\.md — line 3 must match the implemented status grammar/);
    assert.match(errors, /2026-10-12-twice\.md — the line-3 `Status:` line must be the only one/);
    assert.match(errors, /2026-10-12-plan\.md — `## Migration plan` is a proposal-era heading/);
    assert.match(errors, /2026-10-12-missing\.md — the first section must be `## Problem`/);
    assert.match(errors, /2026-10-12-missing\.md — missing the required `## Acceptance criteria` section/);
    assert.match(errors, /2026-10-12-missing\.md — missing `## Alternatives considered`/);
    assert.match(errors, /2026-10-12-reason\.md — line 3 must match the rejected status grammar/);
  });

  it("accepts the grandfather comment only before the format was adopted on 2026-10-12", () => {
    const grandfather = "<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->";
    const body = `# Agent Note: Old\n\nStatus: implemented\n\n## Problem\n\nWhy.\n\n## Decision\n\nWhat.\n\n${grandfather}\n\n## Consequences\n\nCost.\n`;
    const root = repo({
      "implemented/architecture/2026-10-11-old.md": body,
      "implemented/architecture/2026-10-12-new.md": body,
      "implemented/architecture/2026-04-05-both.md": implemented("Both", `\n${grandfather}\n`),
    });
    const errors = agentNoteFormat(root).errors;
    assert.equal(errors.length, 2);
    assert.match(errors.join("\n"), /2026-10-12-new\.md — the grandfather comment is only valid for Agent Notes dated before 2026-10-12/);
    assert.match(errors.join("\n"), /2026-04-05-both\.md — carries both `## Alternatives considered` and the grandfather comment/);
  });
});

function archivedTriplet(kind, base, archived = "2026-10-12") {
  const source = `# Agent Note: Old\n\nStatus: implemented\nArchived: ${archived}\n\nEnglish | [中文](${base}.zh.md)\n\n## Problem\n\nWhy.\n`;
  const zh = `# Agent Note: 旧\n\nStatus: implemented\nArchived: ${archived}\n\n[English](${base}.md) | 中文\n\n## 问题\n\n原因。\n`;
  return {
    [`.agents/notes/archived/${kind}/${base}.md`]: source,
    [`.agents/notes/archived/${kind}/${base}.zh.md`]: zh,
    [`.agents/notes/archived/${kind}/${base}.i18n.yaml`]: `# frozen\n${base}.md: ${gitBlobHash(Buffer.from(source))}\n${base}.zh.md: ${gitBlobHash(Buffer.from(zh))}\n`,
  };
}

function archiveRepo(extra = {}) {
  const files = { ".agents/notes/archived/AGENTS.md": "# AGENTS.md\n", ...extra };
  for (const kind of AGENT_NOTE_CLASSES) files[`.agents/notes/archived/${kind}/.keep-dir`] = "";
  const root = repo();
  for (const [rel, content] of Object.entries(files)) {
    if (rel.endsWith(".keep-dir")) mkdirSync(dirname(join(root, rel)), { recursive: true });
    else write(root, rel, content);
  }
  initGit(root);
  write(root, "README.md", "# Fixture\n");
  commitAll(root, "base");
  return root;
}

describe("verify-archived-agent-notes", () => {
  it("seals new triplets append-only and rejects later edits to sealed bytes", () => {
    const root = archiveRepo(archivedTriplet("bug-fix", "2026-09-06-review-fixes"));
    const noteRoot = join(root, ".agents/notes");
    const check = (options = {}) => verifyArchivedAgentNotes({ noteRoot, baselineRef: "HEAD", ...options });

    assert.match(check().errors.join("\n"), /archived\/manifest\.json is required/);
    const sealed = check({ writeMode: true });
    assert.deepEqual(sealed.errors, []);
    assert.equal(sealed.added, 3);
    assert.deepEqual(check().errors, []);
    commitAll(root, "seal");

    const path = join(noteRoot, "archived/bug-fix/2026-09-06-review-fixes.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nEdited.\n`);
    const errors = check().errors.join("\n");
    assert.match(errors, /sealed content hash changed/);
    assert.match(errors, /consistency record must contain the current Git blob hashes/);
    rmSync(join(noteRoot, "archived/bug-fix/2026-09-06-review-fixes.zh.md"));
    assert.match(check().errors.join("\n"), /bug-fix\/2026-09-06-review-fixes\.zh\.md: sealed artifact is missing/);
  });

  it("rejects re-sealing a changed artifact against the committed baseline", () => {
    const root = archiveRepo(archivedTriplet("process", "2026-07-21-chaos"));
    const noteRoot = join(root, ".agents/notes");
    assert.deepEqual(verifyArchivedAgentNotes({ noteRoot, writeMode: true, baselineRef: "HEAD" }).errors, []);
    commitAll(root, "seal");
    const manifestPath = join(noteRoot, "archived/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files["process/2026-07-21-chaos.md"] = `sha256:${"0".repeat(64)}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.match(
      verifyArchivedAgentNotes({ noteRoot, baselineRef: "HEAD" }).errors.join("\n"),
      /process\/2026-07-21-chaos\.md: sealed manifest hash changed/,
    );
    delete manifest.files["process/2026-07-21-chaos.md"];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.match(
      verifyArchivedAgentNotes({ noteRoot, baselineRef: "HEAD" }).errors.join("\n"),
      /process\/2026-07-21-chaos\.md: sealed manifest entry is missing/,
    );
  });

  it("requires known kinds and no stray root files, and allows kinds with no archived note", () => {
    const root = archiveRepo();
    const noteRoot = join(root, ".agents/notes");
    rmSync(join(noteRoot, "archived/testing"), { recursive: true });
    assert.deepEqual(verifyArchivedAgentNotes({ noteRoot, writeMode: true, baselineRef: "HEAD" }).errors, []);
    mkdirSync(join(noteRoot, "archived/refactor"));
    write(noteRoot, "archived/INDEX.md", "x\n");
    write(noteRoot, "archived/process/.gitkeep", "");
    const errors = verifyArchivedAgentNotes({ noteRoot, writeMode: true, baselineRef: "HEAD" }).errors.join("\n");
    assert.match(errors, /archived\/refactor\/: unknown Agent Note kind/);
    assert.match(errors, /archived\/INDEX\.md: unexpected root file/);
    assert.match(errors, /process\/\.gitkeep: expected \{kind\}\/yyyy-mm-dd-topic/);
  });
});

describe("verify-translation-pairing", () => {
  function pairingRepo(files) {
    const root = repo({
      "scripts/translation-pairing.manifest.json": JSON.stringify({ excluded: [".agents/notes/AGENTS.md"] }),
      ...files,
    });
    initGit(root);
    return root;
  }

  function run(root, ...argv) {
    const out = [];
    const err = [];
    const status = verifyTranslationPairing(argv, { root, log: (line) => out.push(line), error: (line) => err.push(line) });
    return { status, out: out.join("\n"), err: err.join("\n") };
  }

  const readme = "# Yolo\n\nEnglish | [中文](README.zh.md)\n\nA media service. See [the notes](.agents/notes/README.md).\n\n## Status\n\nEarly.\n";
  const readmeZh = "# Yolo\n\n[English](README.md) | 中文\n\n一个媒体服务。见[记录](.agents/notes/README.zh.md)。\n\n## 状态\n\n早期。\n";
  const notes = "# Agent Notes\n\nEnglish | [中文](README.zh.md)\n\nRules.\n";
  const notesZh = "# Agent Notes\n\n[English](README.md) | 中文\n\n规则。\n";

  it("requires every in-scope document to merge bilingual and records confirmed pairs", () => {
    const root = pairingRepo({
      "README.md": readme,
      ".agents/notes/README.md": notes,
      ".agents/notes/AGENTS.md": "# AGENTS.md\n",
      "SECURITY.md": "# Security\n",
    });
    let result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.err, /README\.md: in-scope documentation must merge bilingual/);
    assert.match(result.err, /\.agents\/notes\/README\.md: in-scope documentation must merge bilingual/);
    assert.doesNotMatch(result.err, /AGENTS\.md|SECURITY\.md/);

    write(root, "README.zh.md", readmeZh);
    write(root, ".agents/notes/README.zh.md", notesZh);
    assert.equal(run(root, "--write").status, 2);
    result = run(root, "--write", "README.md", ".agents/notes/README.zh.md");
    assert.equal(result.status, 0, result.err);
    assert.match(readFileSync(join(root, "README.i18n.yaml"), "utf8"), /^\/yolo\/status:\n {2}en: [0-9a-f]{16}\n {2}zh: [0-9a-f]{16}$/m);
    result = run(root);
    assert.equal(result.status, 0, result.err);
    assert.match(result.out, /2 pair\(s\) checked across all in-scope documentation, all consistent/);
  });

  it("names out-of-sync sections, wrong-locale links, missing switchers, and structural drift", () => {
    const root = pairingRepo({
      "README.md": readme, "README.zh.md": readmeZh,
      ".agents/notes/README.md": notes, ".agents/notes/README.zh.md": notesZh,
    });
    assert.equal(run(root, "--write", "--all").status, 0);
    write(root, "README.md", readme.replace("Early.", "Usable."));
    let result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.err, /README\.i18n\.yaml: out of sync — section \/yolo\/status changed since confirmation \(en\)/);

    write(root, "README.md", readme.replace("English | [中文](README.zh.md)\n\n", ""));
    write(root, "README.zh.md", readmeZh.replace("README.zh.md)。", "README.md)。").replace("[English](README.md) | 中文\n\n", ""));
    assert.equal(run(root, "--write", "README.md").status, 0);
    result = run(root, "README.md");
    assert.equal(result.status, 1);
    assert.match(result.err, /README\.zh\.md:3: link target "\.agents\/notes\/README\.md" uses the wrong locale; expected "\.agents\/notes\/README\.zh\.md"/);
    assert.match(result.err, /README\.zh\.md: missing language switcher — no link to README\.md/);
    assert.match(result.err, /README\.md: missing language switcher — no link back to README\.zh\.md/);

    write(root, "README.zh.md", `${readmeZh}\n- 一\n- 二\n`);
    write(root, "README.md", `${readme}\n- one\n`);
    assert.equal(run(root, "--write", "README.md").status, 0);
    assert.match(run(root).err, /list \(kind, start, item count\) #1 diverges between the pair: "bullet:items=1" vs "bullet:items=2"/);
  });

  it("rejects incomplete pairs and counterparts of excluded documents", () => {
    const root = pairingRepo({
      "README.md": readme, "README.zh.md": readmeZh,
      ".agents/notes/AGENTS.md": "# AGENTS.md\n", ".agents/notes/AGENTS.zh.md": "# AGENTS.md\n",
    });
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.err, /README\.md: incomplete pair — missing README\.i18n\.yaml/);
    assert.match(result.err, /\.agents\/notes\/AGENTS\.zh\.md: \.agents\/notes\/AGENTS\.md is excluded from pairing/);
  });

  it("checks staged bytes with --cached and lists corpus state", () => {
    const root = pairingRepo({
      "README.md": readme, "README.zh.md": readmeZh,
      ".agents/notes/README.md": notes, ".agents/notes/README.zh.md": notesZh,
    });
    assert.equal(run(root, "--write", "--all").status, 0);
    git(root, "add", "-A");
    write(root, "README.md", readme.replace("Early.", "Unstaged edit."));
    assert.equal(run(root, "--cached", "README.i18n.yaml").status, 0);
    assert.equal(run(root, "README.md").status, 1);
    const listed = run(root, "--list");
    assert.equal(listed.status, 0);
    assert.match(listed.out, /^out-of-sync README\.md$/m);
  });
});

describe("run-gates", () => {
  it("runs every gate, reports each failure, and fails the aggregate", async () => {
    const dir = join(repo(), "scripts");
    write(dir, "pass.js", "console.log('fine');\n");
    write(dir, "fail.js", "console.error('broken thing'); process.exit(1);\n");
    const out = [];
    const err = [];
    const status = await runGates("fixture", {
      gates: [
        { id: "pass", label: "passing gate", script: "pass.js" },
        { id: "fail", label: "failing gate", script: "fail.js" },
      ],
      dir,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
    assert.equal(status, 1);
    assert.match(out.join("\n"), /PASS passing gate/);
    assert.match(out.join("\n"), /1 passed, 1 failed/);
    assert.match(err.join("\n"), /FAIL failing gate[\s\S]*broken thing/);
  });
});
