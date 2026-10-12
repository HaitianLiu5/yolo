import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { uniqueRepoFiles } from "./repo-files.js";

// The documentation gates' own file walker (node's fs.glob can throw on
// symlinked files such as CLAUDE.md while expanding `**`).

function makeTree() {
  const parent = mkdtempSync(join(tmpdir(), "repo-files-"));
  const root = join(parent, "root");
  const outside = join(parent, "outside"); // reachable only through a symlinked dir
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "a", "snap.md"), "real\n");
  mkdirSync(join(root, "d"), { recursive: true });
  symlinkSync(join(root, "a", "snap.md"), join(root, "d", "snap.md"));
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "snap.md"), "behind a symlinked dir\n");
  symlinkSync(outside, join(root, "linked-dir"));
  mkdirSync(join(root, ".hidden"), { recursive: true });
  writeFileSync(join(root, ".hidden", "snap.md"), "hidden by dot\n");
  return { root, clean: () => rmSync(parent, { recursive: true, force: true }) };
}

function withTree(run) {
  const tree = makeTree();
  try {
    run(tree.root);
  } finally {
    tree.clean();
  }
}

const rel = (root, files) => files.map((file) => relative(root, file.abs));

describe("uniqueRepoFiles", () => {
  it("enumerates ** matches without probing a symlinked file as a directory", () => {
    withTree((root) => {
      const rootReal = realpathSync(root);
      const reals = uniqueRepoFiles(root, ["**/snap.md"]).map((file) => relative(rootReal, file.real)).sort();
      assert.deepEqual(reals, [join("a", "snap.md")]);
    });
  });

  it("does not follow symlinked directories under ** or wildcard-match dot names", () => {
    withTree((root) => {
      assert.deepEqual(rel(root, uniqueRepoFiles(root, ["**/*.md"])).sort(), [join("a", "snap.md")]);
    });
  });

  it("follows a literal segment that names a symlinked directory", () => {
    withTree((root) => {
      assert.deepEqual(rel(root, uniqueRepoFiles(root, ["linked-dir/**/*.md"])), [join("linked-dir", "snap.md")]);
      assert.deepEqual(rel(root, uniqueRepoFiles(root, ["linked-dir/*.md"])), [join("linked-dir", "snap.md")]);
      assert.deepEqual(rel(root, uniqueRepoFiles(root, ["*/snap.md"])), [join("a", "snap.md")]);
    });
  });

  it("follows repeated literal symlinked directories and terminates", () => {
    const parent = mkdtempSync(join(tmpdir(), "repo-files-cycle-"));
    try {
      const root = join(parent, "root");
      mkdirSync(join(root, "a"), { recursive: true });
      writeFileSync(join(root, "a", "snap.md"), "x\n");
      symlinkSync(root, join(root, "cyc"));
      assert.deepEqual(rel(root, uniqueRepoFiles(root, ["cyc/**/snap.md"])), [join("cyc", "a", "snap.md")]);
      assert.deepEqual(rel(root, uniqueRepoFiles(root, ["cyc/cyc/**/snap.md"])), [join("cyc", "cyc", "a", "snap.md")]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports a matched file's canonical target and dedupes symlinks onto it", () => {
    withTree((root) => {
      const files = uniqueRepoFiles(root, ["a/*.md", "d/*.md"]);
      assert.equal(files.length, 1);
      assert.equal(files[0].real, join(realpathSync(root), "a", "snap.md"));
    });
  });

  it("fails loudly on a broken symlink instead of shrinking the corpus", () => {
    const parent = mkdtempSync(join(tmpdir(), "repo-files-broken-"));
    try {
      const root = join(parent, "root");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "gone.md"), "x\n");
      symlinkSync(join(root, "gone.md"), join(root, "broken-link.md"));
      rmSync(join(root, "gone.md"));
      assert.throws(() => uniqueRepoFiles(root, ["*.md"]));
      symlinkSync(join(root, "gone-dir"), join(root, "broken-dir"));
      assert.deepEqual(uniqueRepoFiles(root, ["broken-dir/*.md"]), []);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects glob syntax and segments the walker does not model", () => {
    withTree((root) => {
      assert.throws(() => uniqueRepoFiles(root, ["**/*.[cm]d"]), /does not model glob syntax/);
      assert.throws(() => uniqueRepoFiles(root, ["a/**"]), /trailing \*\*/);
      assert.throws(() => uniqueRepoFiles(root, ["a/**/"]), /empty segments/);
      assert.throws(() => uniqueRepoFiles(root, ["a/../snap.md"]), /does not model \.\. segments/);
      assert.deepEqual(rel(root, uniqueRepoFiles(root, ["./a/snap.md"])), [join("a", "snap.md")]);
    });
  });
});
