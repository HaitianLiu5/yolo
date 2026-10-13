import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  gitBlobHash,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
} from "./archived-agent-notes.js";

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
  it("accepts a complete implemented triplet with matching archive metadata, in its historical formatting", () => {
    assert.deepEqual(validateArchiveArtifacts(fixture()), []);
    const historical = withSource(fixture(), Buffer.from(`# Historical decision\nStatus: implemented\nArchived: 2026-07-26\n[中文版本](${base}.zh.md)\n`));
    assert.deepEqual(validateArchiveArtifacts(historical), []);
  });

  for (const [metadata, error] of [
    ["Status: proposed\nArchived: 2026-07-26", /requires `Status: implemented`/],
    ["Status: implemented\n\nArchived: 2026-07-26", /immediately after the status/],
    ["Status: implemented\nArchived: 2026-02-30", /valid date/],
    ["Status: implemented\nArchived: 2026-07-25", /predates the note filename/],
    ["Status: implemented\nArchived: 2026-07-27", /English and Chinese archive dates differ/],
  ]) {
    it(`rejects invalid archive metadata: ${JSON.stringify(metadata)}`, () => {
      const artifacts = withSource(fixture(), Buffer.from(`# Historical decision\n${metadata}\n`));
      assert.match(validateArchiveArtifacts(artifacts).join("\n"), error);
    });
  }

  it("rejects incomplete triplets", () => {
    const artifacts = fixture();
    artifacts.delete(`process/${base}.i18n.yaml`);
    assert.match(validateArchiveArtifacts(artifacts).join("\n"), /incomplete archived triplet/);
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
