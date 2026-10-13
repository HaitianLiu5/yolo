import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NODE_PROTOCOL } from "@useyolo/core";
import { compareVersions, parseChangelog } from "../lib/changelog.js";
import { localMigrations } from "../lib/d1.js";
import { overall } from "../lib/output.js";
import { run as exec } from "../lib/run.js";

export const summary = "Maintainers: set one version on every package, or check that the release's CHANGELOG entry matches the code";
export const usage = "release check | release prepare <X.Y.Z>";
export const options = {};

const SEMVER = /^\d+\.\d+\.\d+$/;

// Every workspace and every @useyolo pin to `version`; returns changed files.
export function setVersion(root, version) {
  const rootFile = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(rootFile, "utf8"));
  const changed = [];
  for (const file of ["package.json", ...manifest.workspaces.map((workspace) => join(workspace, "package.json"))]) {
    const path = join(root, file);
    let text = readFileSync(path, "utf8");
    const before = text;
    text = text.replace(/^( {2}"version": )"[^"]+"/m, `$1"${version}"`);
    text = text.replace(/("@useyolo\/[a-z0-9-]+": )"\d+\.\d+\.\d+"/g, `$1"${version}"`);
    if (text !== before) {
      writeFileSync(path, text);
      changed.push(file);
    }
  }
  return changed;
}

// The release's CHANGELOG entry against the code: it exists, its block
// parses, its protocol is NODE_PROTOCOL, and it lists the migrations added
// since the previous release tag.
export async function checkRelease(root, version) {
  const checks = [];
  const add = (id, status, message, fix) => checks.push({ id, status, message, ...(fix ? { fix } : {}) });
  const releases = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  const entry = releases.find((release) => release.version === version);
  if (!entry) {
    add("changelog", "fail", `CHANGELOG.md has no "## v${version} (YYYY-MM-DD)" section`, "Add one with a yolo-upgrade block (see .agents/skills/yolo-release)");
    return checks;
  }
  if (entry.error) {
    add("changelog", "fail", entry.error, "Fix the yolo-upgrade block");
    return checks;
  }
  add("changelog", "ok", `CHANGELOG.md describes v${version}`);
  add("protocol", entry.upgrade.protocol === NODE_PROTOCOL ? "ok" : "fail", `The entry says protocol ${entry.upgrade.protocol}; the code's NODE_PROTOCOL is ${NODE_PROTOCOL}`, "Make them agree (service/core/src/protocol.js)");
  const tags = await exec("git", ["tag", "-l", "v*"], { cwd: root, timeoutMs: 30_000 });
  const previous = [...tags.stdout.matchAll(/^v(\d+\.\d+\.\d+)$/gm)].map((match) => match[1]).filter((tag) => compareVersions(tag, version) < 0).sort(compareVersions).at(-1);
  let added = localMigrations(join(root, "service/control/migrations"));
  if (previous) {
    const before = await exec("git", ["ls-tree", "--name-only", `v${previous}`, "service/control/migrations/"], { cwd: root, timeoutMs: 30_000 });
    const old = new Set(before.stdout.split("\n").map((line) => line.replace(/^.*\//, "").replace(/\.sql$/, "")));
    added = added.filter((name) => !old.has(name));
  }
  const listed = new Set(entry.upgrade.migrations);
  const same = added.length === listed.size && added.every((name) => listed.has(name));
  add("migrations", same ? "ok" : "fail", `Migrations since ${previous ? `v${previous}` : "the start"}: ${added.join(", ") || "none"}; the entry lists ${[...listed].join(", ") || "none"}`, same ? null : "List exactly the new migrations in the yolo-upgrade block");
  return checks;
}

export async function run({ positionals, p }) {
  const [action, value] = positionals;
  const current = JSON.parse(readFileSync(join(p.root, "package.json"), "utf8")).version;
  if (action === "check") {
    const checks = await checkRelease(p.root, current);
    return { command: "release check", status: overall(checks), summary: `Release v${current}`, checks };
  }
  if (action === "prepare") {
    if (!SEMVER.test(value ?? "")) return { command: "release prepare", status: "failed", summary: "Give the new version: release prepare X.Y.Z" };
    if (compareVersions(value, current) <= 0) return { command: "release prepare", status: "failed", summary: `${value} is not newer than ${current}` };
    const changed = setVersion(p.root, value);
    const lock = await exec("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: p.root, timeoutMs: 10 * 60_000 });
    const steps = [
      { id: "version", status: "done", message: `Set ${value} in ${changed.join(", ")}` },
      lock.code === 0 ? { id: "lock", status: "done", message: "Updated package-lock.json" } : { id: "lock", status: "fail", message: "npm install --package-lock-only failed", fix: "npm install --package-lock-only --ignore-scripts" },
      ...(await checkRelease(p.root, value)),
    ];
    return {
      command: "release prepare",
      status: overall(steps),
      summary: `Prepared v${value}`,
      steps,
      next: [
        "npm run check",
        `git commit -am "Release v${value}"`,
        `After the maintainer approves: git tag -a v${value} -m "Yolo ${value}" && git push origin main v${value}`,
      ],
    };
  }
  return { command: "release", status: "failed", summary: "Use release check or release prepare X.Y.Z" };
}
