import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NODE_PROTOCOL, signOperatorRequest } from "@useyolo/core";
import { startYolo } from "./yolo-stack.js";

// What an operator's tools read from a running stack: the Worker's version,
// protocol, and migration level at /.well-known/yolo, its health at /healthz,
// and, for a request signed with NODE_SECRET, whether it reaches the node
// (Agent Note 2026-10-11-distribution-to-other-owners).

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../ops/yolo.js", import.meta.url));
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

test("yolo doctor checks a running stack end to end", { timeout: 120_000 }, async (t) => {
  const yolo = await startYolo(t);
  // The stack's instance: its node port and NODE_SECRET; the Worker is local.
  const instance = join(yolo.dir, "yolo.instance.json");
  const envFile = join(yolo.dir, "doctor.env");
  writeFileSync(instance, JSON.stringify({ version: 1, domain: "yolo.example.com", node: { port: yolo.nodePort } }));
  writeFileSync(envFile, `NODE_SECRET=${yolo.secret}\nNODE_PORT=${yolo.nodePort}\nPUBLIC_ORIGIN=https://yolo.example.com\n`);
  const { stdout } = await exec(process.execPath, [cli, "doctor", "--offline", "--origin", yolo.origin, "--json"], {
    env: { ...process.env, YOLO_INSTANCE: instance, DRIVEIN_ENV_FILE: envFile },
  }).catch((error) => error);
  const result = JSON.parse(stdout);
  const check = (id) => result.checks.find((entry) => entry.id === id);
  assert.equal(check("node.health").status, "ok", JSON.stringify(check("node.health")));
  assert.equal(check("worker.reachable").status, "ok");
  assert.equal(check("worker.node").status, "ok", JSON.stringify(check("worker.node")));
  assert.equal(check("worker.owner").status, "warn");
  assert.match(check("worker.owner").fix, /owner-code/);
  assert.equal(check("versions.match").status, "ok");
  assert.equal(check("versions.protocol").status, "ok");
  assert.deepEqual(result.versions, { checkout: version, worker: version, node: version });
  // The instance has no Cloudflare ids yet, so doctor says what to provision.
  assert.equal(check("config.d1.id").status, "fail");
  assert.match(check("config.d1.id").fix, /provision d1/);
  assert.equal(check("cloudflare").status, "skip");
});
