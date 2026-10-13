import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChangelog, upgradePath } from "../lib/changelog.js";
import { decodeTunnelToken } from "../commands/provision.js";
import { lastUpgrade } from "../commands/rollback.js";

const block = (value) => `\`\`\`yolo-upgrade\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const changelog = [
  "# Changelog",
  "",
  "## v0.6.0 (2026-12-01)",
  "",
  "Adds folders.",
  "",
  block({ protocol: 2, migrations: ["0007_folders"], settings: [{ name: "FOLDER_ROOT", required: true, how: "The owner's media folder" }], node: "restart", rollback: "restore", human: ["Allow Full Disk Access"] }),
  "",
  "## v0.5.0 (2026-11-01)",
  "",
  block({ protocol: 1, migrations: ["0006_catalog"], secrets: [{ name: "TMDB_KEY", required: false }], node: "none" }),
  "",
  "## v0.4.0 (2026-10-13)",
  "",
  block({ protocol: 1, migrations: ["0001_init"] }),
  "",
  "## v0.3.9",
  "",
  "No block.",
].join("\n");

test("the changelog's upgrade blocks combine over the releases an upgrade crosses", () => {
  const releases = parseChangelog(changelog);
  assert.deepEqual(releases.map((release) => release.version), ["0.6.0", "0.5.0", "0.4.0", "0.3.9"]);
  assert.equal(releases[3].error, "v0.3.9: no yolo-upgrade block");
  assert.equal(releases[0].notes, "Adds folders.");
  const path = upgradePath(releases, "0.4.0", "0.6.0");
  assert.deepEqual(path.releases.map((release) => release.version), ["0.5.0", "0.6.0"]);
  assert.equal(path.protocol, 2);
  assert.deepEqual(path.migrations, ["0006_catalog", "0007_folders"]);
  assert.deepEqual(path.settings.map((setting) => setting.name), ["FOLDER_ROOT"]);
  assert.deepEqual(path.secrets.map((secret) => secret.name), ["TMDB_KEY"]);
  assert.deepEqual(path.human, ["Allow Full Disk Access"]);
  assert.equal(path.nodeRestart, true);
  assert.equal(path.rollback, "restore");
  assert.equal(upgradePath(releases, "0.4.0", "0.5.0").rollback, "code");
  assert.equal(upgradePath(releases, "0.4.0", "0.5.0").nodeRestart, false);
});

test("a rollback targets the newest upgrade that was not rolled back", () => {
  const upgrade = { kind: "upgrade", from: "0.4.0", to: "0.5.0" };
  assert.equal(lastUpgrade([{ kind: "deploy" }, upgrade, { kind: "deploy" }]), upgrade);
  assert.equal(lastUpgrade([upgrade, { kind: "rollback" }]), null);
  assert.equal(lastUpgrade([{ kind: "deploy" }]), null);
});

test("a tunnel token names its tunnel and account", () => {
  const token = Buffer.from(JSON.stringify({ a: "0123456789abcdef0123456789abcdef", t: "11111111-2222-4333-8444-555555555555", s: "c2VjcmV0" })).toString("base64");
  assert.deepEqual(decodeTunnelToken(`${token}\n`), { accountId: "0123456789abcdef0123456789abcdef", tunnelId: "11111111-2222-4333-8444-555555555555" });
  assert.equal(decodeTunnelToken("not a token"), null);
  assert.equal(decodeTunnelToken(Buffer.from("{\"t\":\"x\"}").toString("base64")), null);
});
