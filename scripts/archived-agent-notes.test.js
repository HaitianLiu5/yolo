import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extendArchiveManifest,
  gitBlobHash,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
} from "./archived-agent-notes.js";
import { isArchivedAgentNotePath } from "./repo-files.js";

// The frozen Agent Note archive: triplets, archive metadata, and the
// append-only content-seal manifest.

const base = "2026-07-26-example";

function fixture() {
  const source = Buffer.from(`# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\nEnglish | [中文](${base}.zh.md)\n\n## Problem\n\nExample.\n`);
  const zh = Buffer.from(`# Agent Note: 示例\n\nStatus: implemented\nArchived: 2026-07-26\n\n[English](${base}.md) | 中文\n\n## 问题\n\n示例。\n`);
  const meta = Buffer.from(`${base}.md: ${gitBlobHash(source)}\n${base}.zh.md: ${gitBlobHash(zh)}\n`);
  return new Map([
    [`process/${base}.md`, source],
    [`process/${base}.zh.md`, zh],
    [`process/${base}.i18n.yaml`, meta],
  ]);
}

function withSource(artifacts, source) {
  artifacts.set(`process/${base}.md`, source);
  const zh = artifacts.get(`process/${base}.zh.md`);
  artifacts.set(`process/${base}.i18n.yaml`, Buffer.from(`${base}.md: ${gitBlobHash(source)}\n${base}.zh.md: ${gitBlobHash(zh)}\n`));
  return artifacts;
}

describe("archived Agent Notes", () => {
  it("recognizes archived paths with POSIX and Windows separators", () => {
    assert.equal(isArchivedAgentNotePath(".agents/notes/archived/process/example.md"), true);
    assert.equal(isArchivedAgentNotePath(".agents\\notes\\archived\\process\\example.md"), true);
    assert.equal(isArchivedAgentNotePath(".agents/notes/implemented/process/example.md"), false);
  });

  it("accepts one complete implemented triplet with matching archive metadata", () => {
    assert.deepEqual(validateArchiveArtifacts(fixture()), []);
  });

  for (const title of ["# Agent Note：示例", "# Historical decision"]) {
    it(`preserves historical formatting: ${title}`, () => {
      const artifacts = withSource(fixture(), Buffer.from(`${title}\nStatus: implemented\nArchived: 2026-07-26\n[中文版本](${base}.zh.md)\n`));
      assert.deepEqual(validateArchiveArtifacts(artifacts), []);
    });
  }

  for (const [metadata, error] of [
    ["Status: proposed\nArchived: 2026-07-26", /requires `Status: implemented`/],
    ["Status: implemented\n\nArchived: 2026-07-26", /immediately after the status/],
    ["Status: implemented\nArchived: 2026-02-30", /valid date/],
    ["Status: implemented\nArchived: 2026-07-25", /predates the note filename/],
    ["Status: implemented\nArchived: 2026-07-27", /English and Chinese archive dates differ/],
    ["Archived: 2026-07-26\nStatus: implemented\nArchived: 2026-07-27", /English and Chinese archive dates differ/],
  ]) {
    it(`rejects invalid archive metadata: ${JSON.stringify(metadata)}`, () => {
      const artifacts = withSource(fixture(), Buffer.from(`# Historical decision\n${metadata}\n`));
      assert.match(validateArchiveArtifacts(artifacts).join("\n"), error);
    });
  }

  it("rejects incomplete triplets and invalid archive headers", () => {
    const artifacts = fixture();
    artifacts.delete(`process/${base}.i18n.yaml`);
    artifacts.set(`process/${base}.md`, Buffer.from("# Agent Note: Example\n\nStatus: proposed\nArchived: yesterday\n"));
    assert.match(validateArchiveArtifacts(artifacts).join("\n"), /incomplete archived triplet/);
  });

  it("rejects unknown kinds, unexpected names, and stale sidecar hashes", () => {
    const artifacts = fixture();
    artifacts.set("refactor/2026-07-26-example.md", Buffer.from("x"));
    artifacts.set("process/notes.txt", Buffer.from("x"));
    artifacts.set(`process/${base}.i18n.yaml`, Buffer.from(`${base}.md: ${"0".repeat(40)}\n${base}.zh.md: ${"0".repeat(40)}\n`));
    const errors = validateArchiveArtifacts(artifacts).join("\n");
    assert.match(errors, /unknown Agent Note kind "refactor"/);
    assert.match(errors, /process\/notes\.txt: expected \{kind\}/);
    assert.match(errors, /consistency record must contain the current Git blob hashes/);
  });

  it("extends the manifest without permitting a sealed change or removal", () => {
    const artifacts = fixture();
    const first = extendArchiveManifest({ version: 1, files: {} }, artifacts);
    assert.deepEqual(first.errors, []);
    assert.equal(first.added.length, 3);

    const sealed = { version: 1, files: first.files };
    const changed = new Map(artifacts);
    changed.set(`process/${base}.md`, Buffer.from("changed"));
    assert.deepEqual(extendArchiveManifest(sealed, changed).errors, [
      `process/${base}.md: sealed content hash changed`,
    ]);
    changed.delete(`process/${base}.zh.md`);
    assert.ok(extendArchiveManifest(sealed, changed).errors.includes(`process/${base}.zh.md: sealed artifact is missing`));
  });

  it("rejects replacing manifest seals alongside changed archive content", () => {
    const artifacts = fixture();
    const initial = extendArchiveManifest({ version: 1, files: {} }, artifacts);
    const baseline = { version: 1, files: initial.files };
    const path = `process/${base}.md`;
    const changedArtifacts = new Map(artifacts);
    changedArtifacts.set(path, Buffer.from("changed"));
    const replacement = extendArchiveManifest({ version: 1, files: {} }, changedArtifacts);
    const current = { version: 1, files: replacement.files };

    assert.deepEqual(extendArchiveManifest(current, changedArtifacts).errors, []);
    assert.deepEqual(validateArchiveManifestExtension(baseline, current), [`${path}: sealed manifest hash changed`]);
    const removed = {
      version: 1,
      files: Object.fromEntries(Object.entries(current.files).filter(([candidate]) => candidate !== path)),
    };
    assert.ok(validateArchiveManifestExtension(baseline, removed).includes(`${path}: sealed manifest entry is missing`));
  });

  it("accepts only an exactly authorized seal transition", () => {
    const path = "feature/2026-08-10-example.md";
    const before = `sha256:${"a".repeat(64)}`;
    const after = `sha256:${"b".repeat(64)}`;
    const transitions = [{ path, before, after }];
    const manifest = (hash) => ({ version: 1, files: { [path]: hash } });
    assert.deepEqual(validateArchiveManifestExtension(manifest(before), manifest(after), transitions), []);
    assert.deepEqual(validateArchiveManifestExtension(manifest(after), manifest(before), transitions), [
      `${path}: sealed manifest hash changed`,
    ]);
    assert.equal(validateArchiveManifestExtension(manifest(before), manifest(`sha256:${"0".repeat(64)}`), transitions).length, 1);
    assert.equal(validateArchiveManifestExtension(manifest(before), { version: 1, files: {} }, transitions).length, 1);
    assert.equal(validateArchiveManifestExtension(
      { version: 1, files: { "process/other.md": before } },
      { version: 1, files: { "process/other.md": after } },
      transitions,
    ).length, 1);
    // Without an authorized entry, every change is rejected.
    assert.equal(validateArchiveManifestExtension(manifest(before), manifest(after)).length, 1);
  });

  it("round-trips the deterministic manifest schema", () => {
    const content = renderArchiveManifest({ "process/z.md": `sha256:${"a".repeat(64)}`, "feature/a.md": `sha256:${"b".repeat(64)}` });
    assert.deepEqual(Object.keys(JSON.parse(content).files), ["feature/a.md", "process/z.md"]);
    assert.deepEqual(parseArchiveManifest(content), {
      version: 1,
      files: { "feature/a.md": `sha256:${"b".repeat(64)}`, "process/z.md": `sha256:${"a".repeat(64)}` },
    });
    assert.throws(() => parseArchiveManifest("{\"version\":1,\"files\":{},\"extra\":1}"), /exactly the fields/);
    assert.throws(() => parseArchiveManifest("{\"version\":2,\"files\":{}}"), /unsupported manifest version/);
    assert.throws(() => parseArchiveManifest("{\"version\":1,\"files\":{\"a.md\":\"sha1:x\"}}"), /invalid content hash/);
  });
});
