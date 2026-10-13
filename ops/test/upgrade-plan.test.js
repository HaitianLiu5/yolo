import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run as upgrade } from "../commands/upgrade.js";
import { paths, ROOT } from "../lib/paths.js";

// The upgrade plan from a deploy checkout at v0.4.0 to v0.5.0, in a
// throwaway git repository with its own two release tags. No wrangler is
// installed there, so the run stops before touching Cloudflare.

const block = (value) => `\`\`\`yolo-upgrade\n${JSON.stringify(value)}\n\`\`\``;

function checkout(t) {
  const root = mkdtempSync(join(tmpdir(), "yolo-upgrade-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  const release = (version, changelog) => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "yolo", version, workspaces: [] }));
    writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n${changelog}`);
    git("add", "-A");
    git("commit", "-q", "-m", `Release v${version}`);
    git("tag", `v${version}`);
  };
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "service/control/migrations"), { recursive: true });
  copyFileSync(join(ROOT, "service/control/wrangler.jsonc"), join(root, "service/control/wrangler.jsonc"));
  writeFileSync(join(root, ".gitignore"), "yolo.instance.json\n.env\n.yolo/\nservice/control/wrangler.instance.jsonc\n");
  const v040 = `## v0.4.0 (2026-10-13)\n\nFirst.\n\n${block({ protocol: 1, migrations: [] })}\n`;
  release("0.4.0", v040);
  release("0.5.0", `## v0.5.0 (2026-11-01)\n\nFolders.\n\n${block({ protocol: 2, migrations: ["0006_folders"], human: ["Allow Full Disk Access"], rollback: "restore" })}\n\n${v040}`);
  git("checkout", "-q", "--detach", "v0.4.0");
  writeFileSync(join(root, "yolo.instance.json"), JSON.stringify({ version: 1, domain: "yolo.example.com", d1: { id: "11111111-2222-4333-8444-555555555555" }, kv: { id: "abcdefabcdefabcdefabcdefabcdefab" }, vpc: { serviceId: "66666666-7777-4888-9999-000000000000" } }));
  writeFileSync(join(root, ".env"), "NODE_SECRET=0123456789abcdef0123456789abcdef\n");
  return { root, git, p: paths({ root, env: {} }) };
}

test("the upgrade plan reads the releases ahead and stops before Cloudflare", async (t) => {
  const { p } = checkout(t);
  const result = await upgrade({ values: {}, positionals: [], p });
  assert.equal(result.status, "needs_human", JSON.stringify(result.steps));
  assert.equal(result.steps.find((step) => step.id === "account").status, "needs_human");
  assert.equal(result.upgrade.from, "0.4.0");
  assert.equal(result.upgrade.to, "0.5.0");
  assert.deepEqual(result.upgrade.releases.map((release) => release.version), ["0.5.0"]);
  assert.deepEqual(result.upgrade.migrations, ["0006_folders"]);
  assert.deepEqual(result.upgrade.humanActions, ["Allow Full Disk Access"]);
  assert.equal(result.upgrade.rollback, "restore");
  assert.match(result.plan.join("\n"), /Apply D1 migrations 0006_folders/);
  assert.match(result.plan.join("\n"), /restores D1 from this backup/);
});

test("the upgrade leaves a branch checkout and a current release alone", async (t) => {
  const { p, git } = checkout(t);
  assert.equal((await upgrade({ values: { to: "v0.4.0" }, positionals: [], p })).summary, "Already at v0.4.0");
  assert.match((await upgrade({ values: { to: "v0.9.0" }, positionals: [], p })).summary, /No tag v0\.9\.0/);
  git("checkout", "-q", "main");
  const onBranch = await upgrade({ values: {}, positionals: [], p });
  assert.equal(onBranch.status, "failed");
  assert.match(onBranch.summary, /on branch main/);
});
