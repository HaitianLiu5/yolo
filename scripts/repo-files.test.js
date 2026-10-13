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
  // Node's fs.glob threw ENOTDIR on a symlinked file such as CLAUDE.md.
  it("enumerates ** matches once each, without probing a symlinked file as a directory or following symlinked or dot directories", () => {
    withTree((root) => {
      const rootReal = realpathSync(root);
      const reals = uniqueRepoFiles(root, ["**/snap.md"]).map((file) => relative(rootReal, file.real)).sort();
      assert.deepEqual(reals, [join("a", "snap.md")]);
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
