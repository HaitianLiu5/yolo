// Repository rules that need no cases written. `npm run check` runs this.
// - One version on every package, every dependency on a Yolo package, and the
//   Apple clients, and a CHANGELOG entry for it with the code's node protocol
//   and migrations that exist (Agent Note 2026-10-13-versions-and-releases).
// - Every official plugin in the catalog describes itself for screens, in
//   English and Chinese (Agent Note 2026-10-11-plugin-architecture).
// - Every skill is named after its directory and linked in .claude/skills
//   for Claude Code, with no stale links (Agent Note 2026-10-13-agent-deployment).

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { NODE_PROTOCOL } from "@useyolo/core";
import { readManifest, readOfficialList } from "@useyolo/plugin-api/host";
import { APPLE_VERSION, APPLE_VERSION_FILE } from "../ops/commands/release.js";
import { parseChangelog } from "../ops/lib/changelog.js";
import { localMigrations } from "../ops/lib/d1.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const problems = [];
const expect = (ok, message) => { if (!ok) problems.push(message); };

// One version.
const { version, workspaces } = read("package.json");
for (const workspace of workspaces) {
  const manifest = read(join(workspace, "package.json"));
  expect(manifest.version === version, `${workspace} is ${manifest.version}, not ${version}`);
  for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (name.startsWith("@useyolo/")) expect(range === version, `${workspace} depends on ${name}@${range}, not ${version}`);
  }
}
const apple = readFileSync(join(ROOT, APPLE_VERSION_FILE), "utf8").match(APPLE_VERSION)?.[1];
expect(apple === version, `${APPLE_VERSION_FILE} says ${apple}, not ${version}`);
const releases = parseChangelog(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"));
const entry = releases.find((release) => release.version === version);
if (!entry) problems.push(`CHANGELOG.md needs a "## v${version} (YYYY-MM-DD)" section`);
else {
  expect(entry.error === null, `CHANGELOG.md v${version}: ${entry.error}`);
  expect(entry.upgrade?.protocol === NODE_PROTOCOL, `CHANGELOG.md v${version} says protocol ${entry.upgrade?.protocol}, the code ${NODE_PROTOCOL}`);
}
const migrations = new Set(localMigrations(join(ROOT, "service/control/migrations")));
for (const release of releases) for (const name of release.upgrade?.migrations ?? []) expect(migrations.has(name), `CHANGELOG.md v${release.version} lists ${name}, which does not exist`);

// The official plugins describe themselves.
const official = readOfficialList({ root: ROOT });
expect(official.plugins.length === 1 && official.plugins[0].builtIn, "plugins/official.json loads link playback alone, built in");
for (const dir of [...official.catalog, ...Object.values(official.with).flat()]) {
  const manifest = readManifest(dir);
  expect(manifest?.title?.en && manifest.summary?.en && manifest.privacy?.en, `${dir} does not describe itself for screens (title, summary, privacy)`);
  expect(manifest?.title?.zh, `${dir} has no Chinese title`);
}

// Skills linked for Claude Code.
const skills = ["skills", ".agents/skills"].flatMap((dir) => readdirSync(join(ROOT, dir))
  .filter((name) => existsSync(join(ROOT, dir, name, "SKILL.md"))).map((name) => ({ name, path: join(ROOT, dir, name) })));
for (const skill of skills) {
  expect(/^name:\s*(\S+)/m.exec(readFileSync(join(skill.path, "SKILL.md"), "utf8"))?.[1] === skill.name, `${skill.path}/SKILL.md is not named ${skill.name}`);
  const link = join(ROOT, ".claude/skills", skill.name);
  expect(existsSync(link) && realpathSync(link) === realpathSync(skill.path), `.claude/skills/${skill.name} does not link to ${skill.path}`);
}
const linked = readdirSync(join(ROOT, ".claude/skills"));
for (const name of linked) expect(skills.some((skill) => skill.name === name), `.claude/skills/${name} links to no skill`);

if (problems.length > 0) {
  console.error(`repository:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`repository: v${version} everywhere, ${official.catalog.length} catalog plugins described, ${skills.length} skills linked`);
