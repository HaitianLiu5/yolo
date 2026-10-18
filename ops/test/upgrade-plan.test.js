import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChangelog, upgradePath } from "../lib/changelog.js";

// An upgrade that crosses several releases applies what each one's
// yolo-upgrade block asks (Agent Note 2026-10-13-versions-and-releases).

const release = (version, block) => `## v${version} (2026-11-01)\n\n${block ? `\`\`\`yolo-upgrade\n${JSON.stringify(block)}\n\`\`\`` : "No block."}\n`;
const changelog = ["# Changelog\n",
  release("0.6.0", { protocol: 2, migrations: ["0007_folders"], settings: [{ name: "FOLDER_ROOT", required: true }], node: "restart", rollback: "restore", human: ["Allow Full Disk Access"] }),
  release("0.5.0", { protocol: 1, migrations: ["0006_catalog"], secrets: [{ name: "TMDB_KEY", required: false }], node: "none" }),
  release("0.4.0", { protocol: 1, migrations: ["0001_init"] }),
  release("0.3.9"),
].join("\n");

test("the upgrade blocks combine over the releases an upgrade crosses, and a release without one is an error", () => {
  const releases = parseChangelog(changelog);
  assert.equal(releases.at(-1).error, "v0.3.9: no yolo-upgrade block");
  const path = upgradePath(releases, "0.4.0", "0.6.0");
  assert.deepEqual(path.releases.map((entry) => entry.version), ["0.5.0", "0.6.0"]);
  assert.deepEqual([path.protocol, path.migrations, path.human, path.nodeRestart, path.rollback], [2, ["0006_catalog", "0007_folders"], ["Allow Full Disk Access"], true, "restore"]);
  assert.deepEqual([path.settings.map((s) => s.name), path.secrets.map((s) => s.name)], [["FOLDER_ROOT"], ["TMDB_KEY"]]);
  const one = upgradePath(releases, "0.4.0", "0.5.0");
  assert.deepEqual([one.rollback, one.nodeRestart], ["code", false]);
});
