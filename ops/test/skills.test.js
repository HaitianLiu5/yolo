import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "../lib/paths.js";

// Skills live in skills/ (shipped: deploying, operating, and using Yolo) and
// .agents/skills/ (working on this repository). Claude Code finds project
// skills in .claude/skills/, so each one has a link there.

const skillDirs = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, dir, entry.name, "SKILL.md")))
  .map((entry) => ({ name: entry.name, path: join(ROOT, dir, entry.name) }));

test("every skill is named after its directory and linked for Claude Code", () => {
  const skills = [...skillDirs("skills"), ...skillDirs(".agents/skills")];
  assert.ok(skills.length >= 7);
  for (const skill of skills) {
    const name = /^name:\s*(\S+)/m.exec(readFileSync(join(skill.path, "SKILL.md"), "utf8"))?.[1];
    assert.equal(name, skill.name, `${skill.path}/SKILL.md name`);
    const link = join(ROOT, ".claude/skills", skill.name);
    assert.ok(lstatSync(link).isSymbolicLink(), `${link} is a link`);
    assert.equal(realpathSync(link), realpathSync(skill.path));
  }
  const linked = readdirSync(join(ROOT, ".claude/skills"));
  assert.deepEqual(linked.sort(), skills.map((skill) => skill.name).sort(), "no stale links");
});

// The upstream repository's URL is fine; an instance's address or label is not.
test("shipped skills name no owner's instance", () => {
  for (const skill of skillDirs("skills")) {
    assert.doesNotMatch(readFileSync(join(skill.path, "SKILL.md"), "utf8"), /haitian\.site|com\.haitian/i, skill.name);
  }
});
