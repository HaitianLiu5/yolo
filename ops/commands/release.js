import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_PROTOCOL, NODE_PROTOCOL } from "@useyolo/core";
import { compareVersions, parseChangelog } from "../lib/changelog.js";
import { localMigrations } from "../lib/d1.js";
import { overall } from "../lib/output.js";
import { run as exec } from "../lib/run.js";

export const summary = "Maintainers: set one version on every package, or check that the release's CHANGELOG entry matches the code";
export const usage = "release check | release prepare <X.Y.Z>";
export const options = {};

const SEMVER = /^\d+\.\d+\.\d+$/;
// The Apple clients' version, which Xcode reads as MARKETING_VERSION
// (Agent Note 2026-10-19-apple-tv-client).
export const APPLE_VERSION_FILE = "clients/apple/Config/Base.xcconfig";
export const APPLE_VERSION = /^MARKETING_VERSION = (\S+)$/m;

// Every workspace, every @useyolo pin, and the Apple clients to `version`;
// returns changed files.
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
  const apple = join(root, APPLE_VERSION_FILE);
  const before = readFileSync(apple, "utf8");
  const text = before.replace(APPLE_VERSION, `MARKETING_VERSION = ${version}`);
  if (text !== before) {
    writeFileSync(apple, text);
    changed.push(APPLE_VERSION_FILE);
  }
  return changed;
}

/**
 * The client protocol against the release's entry (Agent Note
 * 2026-10-19-client-protocol). `current` is the code's CLIENT_PROTOCOL,
 * `previous` the previous release tag's (null when unknown), `stated` the
 * entry's `clientProtocol` (null when it has none). A raise is by one, since
 * the Hub serves only the number before, and the entry states it, so the
 * maintainer decided it; a stated number is the code's.
 */
export function clientProtocolCheck({ current, previous, stated }) {
  const file = "service/core/src/protocol.js";
  if (stated != null && stated !== current) return { status: "fail", message: `The entry says clientProtocol ${stated}; the code's CLIENT_PROTOCOL is ${current}`, fix: `Make them agree (${file})` };
  if (previous == null || previous === current) return { status: "ok", message: `CLIENT_PROTOCOL is ${current}${previous == null ? "" : ", as in the previous release"}` };
  if (current !== previous + 1) return { status: "fail", message: `CLIENT_PROTOCOL went from ${previous} to ${current}; the Hub serves only the number before, so a release raises it by one`, fix: `Set CLIENT_PROTOCOL to ${previous + 1} (${file})` };
  if (stated == null) return { status: "fail", message: `CLIENT_PROTOCOL was raised from ${previous} to ${current}, and the entry does not say so`, fix: `Add "clientProtocol": ${current} to the yolo-upgrade block, and tell owners in the prose that clients update within one release` };
  return { status: "ok", message: `The entry says clientProtocol ${stated}, raised from ${previous}` };
}

// The release's CHANGELOG entry against the code: it exists, its block
// parses, its protocol is NODE_PROTOCOL, a raised CLIENT_PROTOCOL is stated,
// and it lists the migrations added since the previous release tag.
export async function checkRelease(root, version) {
  const checks = [];
  const add = (id, status, message, fix) => checks.push({ id, status, message, ...(fix ? { fix } : {}) });
  const releases = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  const entry = releases.find((release) => release.version === version);
  if (!entry) {
    add("changelog", "fail", `CHANGELOG.md has no "## v${version} (YYYY-MM-DD)" section`, "Add one with a yolo-upgrade block (see .agents/skills/yolo-release)");
    checks[0].missing = true;
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
  let previousClient = null;
  if (previous) {
    const old = await exec("git", ["show", `v${previous}:service/core/src/protocol.js`], { cwd: root, timeoutMs: 30_000 });
    const found = /^export const CLIENT_PROTOCOL = (\d+);/m.exec(old.stdout);
    // A tag older than the client protocol spoke its first number.
    previousClient = found ? Number(found[1]) : old.code === 0 ? 1 : null;
  }
  const client = clientProtocolCheck({ current: CLIENT_PROTOCOL, previous: previousClient, stated: entry.upgrade.clientProtocol });
  add("clientProtocol", client.status, client.message, client.fix);
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
    // The section is written after the version is set, so its absence here
    // is the next step, not a failure.
    const checks = await checkRelease(p.root, value);
    const unwritten = checks.length === 1 && checks[0].missing;
    const steps = [
      { id: "version", status: "done", message: `Set ${value} in ${changed.join(", ")}` },
      lock.code === 0 ? { id: "lock", status: "done", message: "Updated package-lock.json" } : { id: "lock", status: "fail", message: "npm install --package-lock-only failed", fix: "npm install --package-lock-only --ignore-scripts" },
      ...(unwritten ? [{ id: "changelog", status: "info", message: `CHANGELOG.md has no "## v${value} (YYYY-MM-DD)" section yet` }] : checks),
    ];
    return {
      command: "release prepare",
      status: overall(steps),
      summary: `Prepared v${value}`,
      steps,
      next: [
        ...(unwritten ? [`Add the "## v${value} (YYYY-MM-DD)" section with its yolo-upgrade block to CHANGELOG.md (see .agents/skills/yolo-release), then npm run yolo -- release check`] : []),
        "npm run check",
        `git commit -am "Release v${value}"`,
        `After the maintainer approves: git tag -a v${value} -m "Yolo ${value}" && git push origin main v${value}`,
      ],
    };
  }
  return { command: "release", status: "failed", summary: "Use release check or release prepare X.Y.Z" };
}
