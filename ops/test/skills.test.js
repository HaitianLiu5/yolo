import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "../lib/paths.js";

// Claude Code finds project skills in .claude/skills/, so every skill in
// skills/ and .agents/skills/ is linked there, under its own name
// (Agent Note 2026-10-13-agent-deployment).

test("every skill is named after its directory and linked for Claude Code, with no stale links", () => {
  const skills = ["skills", ".agents/skills"].flatMap((dir) => readdirSync(join(ROOT, dir))
    .filter((name) => existsSync(join(ROOT, dir, name, "SKILL.md"))).map((name) => ({ name, path: join(ROOT, dir, name) })));
  for (const skill of skills) {
    assert.equal(/^name:\s*(\S+)/m.exec(readFileSync(join(skill.path, "SKILL.md"), "utf8"))?.[1], skill.name);
    assert.equal(realpathSync(join(ROOT, ".claude/skills", skill.name)), realpathSync(skill.path));
  }
  assert.deepEqual(readdirSync(join(ROOT, ".claude/skills")).sort(), skills.map((skill) => skill.name).sort());
});
