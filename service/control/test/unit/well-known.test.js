import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NODE_PROTOCOL, signOperatorRequest, YoloError } from "@useyolo/core";
import { buildInfo, generateBuildInfo, migrationNames } from "../../scripts/generate-build-info.js";
import { health, WELL_KNOWN_PATH, wellKnown } from "../../src/well-known.js";
import { createTestD1 } from "../helpers/d1.js";

const secret = "test-secret-with-enough-entropy";
const build = { version: "9.9.9", commit: "abc1234", migrations: { required: "0005_device_kind_other" } };
const origin = "https://yolo.example.com";

function nodeClient(answer) {
  const calls = [];
  return { calls, get: async (path) => { calls.push(path); return answer(); } };
}

async function get(env, { headers = {}, node = nodeClient(() => ({ version: "9.9.9", protocol: NODE_PROTOCOL })) } = {}) {
  const response = await wellKnown(new Request(`${origin}${WELL_KNOWN_PATH}`, { headers }), env, { build, node, plugins: [{ name: "p", version: "1" }] });
  return { response, body: await response.json(), node };
}

test("/.well-known/yolo reports the version, protocol and migrations without secrets", async () => {
  const db = createTestD1();
  db.raw.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, applied_at TEXT)");
  db.raw.exec("INSERT INTO d1_migrations (name) VALUES ('0004_device_pairing'), ('0005_device_kind_other')");
  const { response, body, node } = await get({ DB: db, NODE_SECRET: secret });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(body, {
    name: "Yolo",
    version: "9.9.9",
    commit: "abc1234",
    protocol: NODE_PROTOCOL,
    migrations: { required: "0005_device_kind_other", applied: "0005_device_kind_other" },
  });
  // An unsigned request never makes the Worker call the node.
  assert.deepEqual(node.calls, []);
});

test("a database without wrangler's migration table reports none applied", async () => {
  const { body } = await get({ DB: createTestD1(), NODE_SECRET: secret });
  assert.equal(body.migrations.applied, null);
});

test("the operator's signed request also learns whether the Worker reaches the node", async () => {
  const db = createTestD1();
  const headers = await signOperatorRequest(secret, { path: WELL_KNOWN_PATH });
  const { body } = await get({ DB: db, NODE_SECRET: secret }, { headers });
  assert.deepEqual(body.operator, {
    node: { reachable: true, version: "9.9.9", protocol: NODE_PROTOCOL, error: null },
    owner: { passkey: false },
    plugins: [{ name: "p", version: "1" }],
  });
  const offline = await get({ DB: db, NODE_SECRET: secret }, {
    headers,
    node: nodeClient(() => {
      throw new YoloError("node_offline", "The NODE Workers VPC binding is not configured");
    }),
  });
  assert.deepEqual(offline.body.operator.node, { reachable: false, version: null, protocol: null, error: "The NODE Workers VPC binding is not configured" });
  // A signature with another secret is an ordinary request.
  const other = await get({ DB: db, NODE_SECRET: secret }, { headers: await signOperatorRequest("other", { path: WELL_KNOWN_PATH }) });
  assert.equal(other.body.operator, undefined);
});

test("/healthz answers JSON, not the player's HTML", async () => {
  const response = health(build);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { ok: true, version: "9.9.9" });
});

test("the build info names Yolo's version and the newest migration", (t) => {
  const info = buildInfo();
  const root = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"));
  assert.equal(info.version, root.version);
  assert.equal(info.migrations.required, migrationNames().at(-1));
  assert.match(info.migrations.required, /^\d{4}_/);
  const dir = mkdtempSync(join(tmpdir(), "yolo-build-info-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outFile = join(dir, "build-info.js");
  generateBuildInfo({ outFile });
  assert.match(readFileSync(outFile, "utf8"), new RegExp(`"version": "${root.version.replaceAll(".", "\\.")}"`));
});
