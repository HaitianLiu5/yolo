import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readEnvFile, setEnvValues } from "../lib/env-file.js";
import { validateInstance, withDefaults } from "../lib/instance.js";
import { ROOT } from "../lib/paths.js";
import { InstanceConfigError, readTemplate, renderInstanceConfig, renderLocalConfig } from "../lib/wrangler-config.js";

// An instance's address and Cloudflare ids live in yolo.instance.json and are
// rendered onto the tracked wrangler template, which stays generic
// (Agent Notes 2026-10-13-agent-deployment, 2026-10-13-no-domain-deployment).

const TEMPLATE_FILE = join(ROOT, "service/control/wrangler.jsonc");
const template = readTemplate(TEMPLATE_FILE);
const example = JSON.parse(readFileSync(join(ROOT, "yolo.instance.example.json"), "utf8"));
const ids = { d1: { id: "00000000-0000-4000-8000-000000000000" }, kv: { id: "0123456789abcdef0123456789abcdef" }, vpc: { serviceId: "00000000-0000-4000-8000-000000000002" } };

test("the tracked wrangler template carries no instance's route, account, or ids, only all-zero placeholders", () => {
  for (const key of ["routes", "vpc_services", "account_id"]) assert.equal(template[key], undefined, key);
  assert.equal(template.vars.PUBLIC_ORIGIN, "");
  const found = readFileSync(TEMPLATE_FILE, "utf8").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/g) ?? [];
  assert.deepEqual(found.filter((id) => /[1-9a-f]/.test(id)), []);
});

test("a domain instance renders its route, origin, ids, and VPC binding; the rest is the template's", () => {
  const config = renderInstanceConfig(template, example);
  assert.deepEqual(config.routes, [{ pattern: "yolo.example.com", custom_domain: true }]);
  assert.deepEqual([config.account_id, config.vars.PUBLIC_ORIGIN, config.workers_dev], [example.accountId, "https://yolo.example.com", false]);
  assert.deepEqual([config.d1_databases[0].database_id, config.kv_namespaces[0].id], [example.d1.id, example.kv.id]);
  assert.deepEqual(config.vpc_services, [{ binding: "NODE", service_id: example.vpc.serviceId }]);
  for (const key of ["main", "assets", "durable_objects", "migrations", "triggers"]) assert.deepEqual(config[key], template[key], key);

  assert.throws(() => renderInstanceConfig(template, { version: 1, domain: "yolo.example.com" }), (error) => error instanceof InstanceConfigError
    && error.problems.map((problem) => problem.field).join() === "d1.id,kv.id,vpc.serviceId" && /provision d1/.test(error.problems[0].fix));
});

test("a workers.dev instance renders no route, workers_dev on, preview URLs off, its host as PUBLIC_ORIGIN, and certifies the remote listener by address", () => {
  const raw = { version: 1, domain: null, workersDev: true, worker: "yolo-k3x9q2", host: "yolo-k3x9q2.home-ab12cd.workers.dev", ...ids };
  const config = renderInstanceConfig(template, raw);
  assert.equal(config.routes, undefined);
  assert.deepEqual([config.workers_dev, config.preview_urls, config.name], [true, false, "yolo-k3x9q2"]);
  assert.deepEqual([config.vars.PUBLIC_ORIGIN, withDefaults(raw).media.wan.certificate], ["https://yolo-k3x9q2.home-ab12cd.workers.dev", "ip"]);
  const fields = (patch, options) => validateInstance({ ...raw, ...patch }, options).map((problem) => problem.field);
  assert.deepEqual(fields({ domain: "yolo.example.com" }), ["domain"]);
  assert.deepEqual(fields({ host: "other.home-ab12cd.workers.dev" }), ["host"]);
  assert.deepEqual(fields({ media: { wan: { certificate: "name" } } }), ["media.wan.certificate"]);
  assert.deepEqual(fields({ host: undefined }, { deploy: true }), ["host"], "nothing deploys until the subdomain is known");
});

test("a local config never reaches Cloudflare, and .env keeps a secret it already has", (t) => {
  const local = renderLocalConfig(template, { controlDir: join(ROOT, "service/control"), name: "local", migrationsDir: "/tmp/m", d1Id: "local-d1", kvId: "local-kv", node: "/usr/bin/node" });
  for (const key of ["routes", "vpc_services", "triggers", "account_id"]) assert.equal(local[key], undefined, key);
  assert.deepEqual(local.assets.run_worker_first, template.assets.run_worker_first);

  const dir = mkdtempSync(join(tmpdir(), "yolo-ops-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = join(dir, ".env");
  writeFileSync(env, "NODE_SECRET=first\n");
  assert.deepEqual(setEnvValues(env, { NODE_SECRET: "second", PUBLIC_ORIGIN: "https://b.test" }, { overwrite: ["PUBLIC_ORIGIN"] }), ["PUBLIC_ORIGIN"]);
  assert.deepEqual({ ...readEnvFile(env) }, { NODE_SECRET: "first", PUBLIC_ORIGIN: "https://b.test" });
});
