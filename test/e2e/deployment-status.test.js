import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NODE_PROTOCOL, signOperatorRequest } from "@useyolo/core";
import { startYolo } from "./yolo-stack.js";

// What an operator's tools read from a running stack: the Worker's version,
// protocol, and migration level at /.well-known/yolo, its health at /healthz,
// and, for a request signed with NODE_SECRET, whether it reaches the node
// (Agent Note 2026-10-11-distribution-to-other-owners).

const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

test("the Worker reports its version, protocol, migrations, and its path to the node", { timeout: 120_000 }, async (t) => {
  const yolo = await startYolo(t);

  const healthz = await fetch(`${yolo.origin}/healthz`);
  assert.equal(healthz.status, 200);
  assert.match(healthz.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await healthz.json(), { ok: true, version });

  const open = await (await fetch(`${yolo.origin}/.well-known/yolo`)).json();
  assert.equal(open.version, version);
  assert.equal(open.protocol, NODE_PROTOCOL);
  assert.match(open.migrations.required, /^\d{4}_/);
  // The e2e database also has the stack's owner seed, numbered after every real migration.
  assert.ok(open.migrations.applied >= open.migrations.required, JSON.stringify(open.migrations));
  assert.equal(open.operator, undefined);

  const headers = await signOperatorRequest(yolo.secret, { path: "/.well-known/yolo" });
  const signed = await (await fetch(`${yolo.origin}/.well-known/yolo`, { headers })).json();
  assert.deepEqual(signed.operator.node, { reachable: true, version, protocol: NODE_PROTOCOL, error: null });
  assert.equal(signed.operator.owner.passkey, false);
});
