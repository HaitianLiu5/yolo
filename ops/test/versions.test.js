import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLIENT_PROTOCOL, NODE_PROTOCOL } from "@useyolo/core";
import { APPLE_VERSION, APPLE_VERSION_FILE, clientProtocolCheck } from "../commands/release.js";
import { parseChangelog } from "../lib/changelog.js";
import { localMigrations } from "../lib/d1.js";
import { ROOT } from "../lib/paths.js";

// Yolo has one version, on every package, every dependency on a Yolo
// package, and the Apple clients, and every release has a CHANGELOG entry
// with its yolo-upgrade block (Agent Note 2026-10-13-versions-and-releases).

const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

test("every package carries the root's version, CHANGELOG.md describes it with the code's protocol, and listed migrations exist", () => {
  const { version, workspaces } = read("package.json");
  for (const workspace of workspaces) {
    const manifest = read(join(workspace, "package.json"));
    assert.equal(manifest.version, version, workspace);
    for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (name.startsWith("@useyolo/")) assert.equal(range, version, `${workspace} ${name}`);
    }
  }
  assert.equal(readFileSync(join(ROOT, APPLE_VERSION_FILE), "utf8").match(APPLE_VERSION)?.[1], version, APPLE_VERSION_FILE);
  const releases = parseChangelog(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"));
  const entry = releases.find((release) => release.version === version);
  assert.ok(entry, `CHANGELOG.md needs a "## v${version} (YYYY-MM-DD)" section`);
  assert.deepEqual([entry.error, entry.upgrade.protocol], [null, NODE_PROTOCOL]);
  if (entry.upgrade.clientProtocol != null) assert.equal(entry.upgrade.clientProtocol, CLIENT_PROTOCOL);
  const migrations = new Set(localMigrations(join(ROOT, "service/control/migrations")));
  for (const release of releases) for (const name of release.upgrade?.migrations ?? []) assert.ok(migrations.has(name), `${release.version}: ${name}`);
});

test("a release states a raised client protocol, raises it by one, and a stated number is the code's", () => {
  const status = (facts) => clientProtocolCheck(facts).status;
  assert.equal(status({ current: 2, previous: 2, stated: null }), "ok");
  assert.equal(status({ current: 3, previous: 2, stated: 3 }), "ok");
  assert.match(clientProtocolCheck({ current: 3, previous: 2, stated: null }).fix, /"clientProtocol": 3/);
  assert.equal(status({ current: 4, previous: 2, stated: 4 }), "fail", "the Hub serves only the number before");
  assert.equal(status({ current: 2, previous: 2, stated: 3 }), "fail");
  assert.equal(status({ current: 2, previous: null, stated: null }), "ok", "no earlier tag to compare with");
});

test("a CHANGELOG heading without its date is not a release's section", () => {
  const block = "```yolo-upgrade\n{}\n```\n";
  assert.deepEqual(parseChangelog(`## v1.2.3\n\n${block}\n## v1.2.2 (2026-11-01)\n\n${block}`).map((release) => [release.version, release.date]), [["1.2.2", "2026-11-01"]]);
});
