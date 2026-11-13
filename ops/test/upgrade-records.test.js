import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NODE_PROTOCOL, PROTOCOL_HEADER } from "@useyolo/core";
import { lastUpgrade, unfinishedUpgrade } from "../lib/deployments.js";
import { checkoutProtocol, waitForNode } from "../lib/node-health.js";

// What `upgrade` and `rollback` read from .yolo/deployments.jsonl, and the
// protocol they ask a restarted node in (Agent Note
// 2026-10-13-versions-and-releases).

const facts = { from: "0.5.0", to: "0.6.0", fromCommit: "abc1234", workerVersionId: "w1", backup: "b.sql", bookmark: "bm", rollback: "restore" };
const start = { kind: "upgrade-start", at: "2026-11-01T00:00:00.000Z", ...facts, marksMigrate: true };

test("a rollback is advised to restore D1 only when the upgrade reached its migrations", () => {
  assert.equal(lastUpgrade([start]).migrated, false, "cut off before migrate");
  assert.equal(lastUpgrade([start, { kind: "upgrade-migrate", to: "0.6.0" }]).migrated, true, "cut off in or after migrate");
  assert.equal(lastUpgrade([start, { kind: "upgrade", ok: false, ...facts, migrated: false }]).migrated, false, "npm ci failed");
  assert.equal(lastUpgrade([start, { kind: "upgrade-migrate", to: "0.6.0" }, { kind: "upgrade", ok: true, ...facts, migrated: true }]).migrated, true);
  // Records of releases that did not mark it read as they did.
  assert.equal(lastUpgrade([{ kind: "upgrade", ok: true, ...facts }]).migrated, true);
  assert.equal(lastUpgrade([{ kind: "upgrade-start", ...facts }]).migrated, true);
  assert.equal(lastUpgrade([{ kind: "upgrade-start", from: "0.5.0", to: "0.6.0" }]), null, "a start from before anything changed");
  assert.equal(lastUpgrade([start, { kind: "rollback", ok: true }]), null);
  assert.equal(lastUpgrade([start, { kind: "rollback", ok: false }]).kind, "upgrade-start");
});

test("an upgrade cut off at its target is unfinished until it is completed, finished by hand, or rolled back", () => {
  assert.equal(unfinishedUpgrade([start], "0.6.0").from, "0.5.0");
  assert.equal(unfinishedUpgrade([start], "0.7.0"), null);
  assert.equal(unfinishedUpgrade([start, { kind: "upgrade", ok: true, ...facts }], "0.6.0"), null);
  assert.equal(unfinishedUpgrade([start, { kind: "rollback", ok: true }], "0.6.0"), null);
  assert.ok(unfinishedUpgrade([start, { kind: "deploy", ok: false, version: "0.6.0" }], "0.6.0"));
  assert.equal(unfinishedUpgrade([start, { kind: "migrate", ok: true, version: "0.6.0" }, { kind: "deploy", ok: true, version: "0.6.0" }], "0.6.0"), null);
  assert.equal(unfinishedUpgrade([], "0.6.0"), null);
  // One that ran to its end and failed left the checkout at the target too.
  const failed = { kind: "upgrade", ok: false, at: "2026-11-01T00:05:00.000Z", ...facts, migrated: true };
  assert.equal(unfinishedUpgrade([start, failed], "0.6.0").kind, "upgrade");
  assert.equal(unfinishedUpgrade([start, failed], "0.7.0"), null);
  assert.ok(unfinishedUpgrade([start, failed, { kind: "deploy", ok: false, version: "0.6.0" }], "0.6.0"));
  assert.equal(unfinishedUpgrade([start, failed, { kind: "deploy", ok: true, version: "0.6.0" }], "0.6.0"), null);
  assert.equal(unfinishedUpgrade([start, failed, { kind: "rollback", ok: true }], "0.6.0"), null);
  // A deploy of the target before the failure does not finish it.
  assert.ok(unfinishedUpgrade([{ kind: "deploy", ok: true, version: "0.6.0" }, start, failed], "0.6.0"));
});

test("a restarted node is asked in the checked-out release's protocol, not this process's", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yolo-protocol-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(checkoutProtocol(root), NODE_PROTOCOL, "without the file, this process's");
  const other = NODE_PROTOCOL + 5;
  mkdirSync(join(root, "service/core/src"), { recursive: true });
  writeFileSync(join(root, "service/core/src/protocol.js"), `// The number.\nexport const NODE_PROTOCOL = ${other};\nexport const CLIENT_PROTOCOL = 2;\n`);
  assert.equal(checkoutProtocol(root), other);

  // A node that serves only the checkout's number.
  const server = createServer((req, res) => {
    const served = req.headers[PROTOCOL_HEADER] === String(other);
    res.writeHead(served ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(served ? { version: "0.6.0" } : { error: "node_offline" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const options = { secret: "secret", port: server.address().port };
  assert.deepEqual(await waitForNode({ root, ...options }, "0.6.0", { timeoutMs: 3_000, intervalMs: 50 }), { ok: true, seen: "0.6.0" });
  assert.deepEqual(await waitForNode(options, "0.6.0", { timeoutMs: 300, intervalMs: 50 }), { ok: false, seen: "HTTP 503" });
});
