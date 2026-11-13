import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adoption } from "../commands/provision.js";
import { tailLines } from "../commands/service.js";
import { readEnvFile, setEnvValues } from "../lib/env-file.js";
import { permissionGroupIds } from "../lib/operator-token.js";
import { renderText } from "../lib/output.js";
import { reloadAgent } from "../lib/service.js";

// The operator commands' steps that touch what another instance or a
// running service may own (Agent Note 2026-10-13-agent-deployment).

test("a resource that already exists under the instance's name is used only when its step is named with --adopt", () => {
  const found = { step: "d1", kind: "A D1 database named", name: "yolo", id: "1111" };
  const asked = adoption({ ...found, values: {} });
  assert.deepEqual([asked.status, asked.approve], ["needs_approval", "npm run yolo -- provision --adopt d1"]);
  assert.match(asked.message, /"yolo" \(1111\) already exists.*another instance's history/);
  assert.match(asked.fix, /d1\.name/);
  assert.equal(adoption({ ...found, values: { adopt: ["tunnel"] } }).status, "needs_approval", "another step's approval");
  assert.equal(adoption({ ...found, values: { adopt: ["tunnel", "d1"] } }), null);
  assert.equal(adoption({ ...found, step: "vpc", values: {}, only: "vpc" }).approve, "npm run yolo -- provision vpc --adopt vpc");
});

test("a result that stops for approval says what it had already done", () => {
  const result = { status: "needs_approval", summary: "Stopped", approve: "npm run yolo -- init --workers-subdomain quiet" };
  assert.match(renderText(result), /\nNothing was changed\. After the owner approves, run: npm run yolo -- init/);
  assert.match(renderText({ ...result, changed: ["wrote yolo.instance.json", "wrote .env"] }), /\nAlready done: wrote yolo\.instance\.json; wrote \.env\. Nothing else was changed\. After the owner approves/);
});

test(".env loses a key's line when asked, and keeps the rest", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yolo-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = join(dir, ".env");
  writeFileSync(env, "# The node\nNODE_SECRET=s\nNODE_PORT=9300\nPUBLIC_ORIGIN=https://a.test\n");
  assert.deepEqual(setEnvValues(env, { NODE_PORT: null }, { overwrite: ["NODE_PORT"], remove: ["NODE_PORT"] }), ["NODE_PORT"]);
  assert.deepEqual({ ...readEnvFile(env) }, { NODE_SECRET: "s", PUBLIC_ORIGIN: "https://a.test" });
  assert.deepEqual(setEnvValues(env, {}, { remove: ["NODE_PORT"] }), [], "nothing to remove");
});

test("a LaunchAgent is loaded again only once launchd let the old one go, and a refused bootstrap is tried again", async () => {
  const calls = [];
  let prints = 0;
  let bootstraps = 0;
  const launchctl = async (args) => {
    calls.push(args[0]);
    if (args[0] === "print") return { code: (prints += 1) < 3 ? 0 : 113 };
    if (args[0] === "bootstrap") return (bootstraps += 1) < 2 ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error" } : { code: 0 };
    return { code: 0 };
  };
  const wait = async () => {};
  assert.equal((await reloadAgent({ domain: "gui/501", label: "app.useyolo.node", file: "/x.plist", loaded: true }, { launchctl, wait })).code, 0);
  assert.deepEqual(calls, ["bootout", "print", "print", "print", "bootstrap", "bootstrap"]);

  calls.length = 0;
  const refused = await reloadAgent({ domain: "gui/501", label: "app.useyolo.node", file: "/x.plist", loaded: false }, { launchctl: async (args) => (calls.push(args[0]), { code: 37 }), wait });
  assert.deepEqual([refused.code, calls], [37, ["bootstrap", "bootstrap", "bootstrap", "bootstrap"]]);
});

test("service logs reads the end of the log, not the whole file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yolo-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "node.log");
  const all = Array.from({ length: 500 }, (_, index) => `line ${index} é`);
  writeFileSync(log, `${all.join("\n")}\n`);
  const whole = (lines) => `${all.join("\n")}\n`.split("\n").slice(-lines - 1).join("\n");
  // Blocks smaller than a line, and larger than the file.
  for (const blockBytes of [7, 64, 1 << 20]) assert.equal(tailLines(log, 40, { blockBytes }), whole(40), `blocks of ${blockBytes}`);
  assert.equal(tailLines(log, 1000), whole(1000));
  assert.equal(tailLines(join(dir, "none.log"), 40), null);
});

test("the permission groups come from one listing, and only a name it lacks is asked for by itself", async () => {
  const calls = [];
  const cf = (listed) => async (args) => {
    calls.push(args.slice(3).join(" "));
    const name = args.includes("--name") ? decodeURIComponent(args.at(-1)) : null;
    const groups = name ? (name === "Gone" ? [] : [{ id: `pg-${name}`, name }]) : listed.map((each) => ({ id: `pg-${each}`, name: each }));
    return { code: 0, stdout: JSON.stringify(groups), stderr: "" };
  };
  assert.deepEqual(await permissionGroupIds(["D1 Write", "DNS Write"], cf(["DNS Write", "D1 Write", "Other"])), { ids: { "D1 Write": "pg-D1 Write", "DNS Write": "pg-DNS Write" } });
  assert.deepEqual(calls, ["list"]);
  calls.length = 0;
  assert.deepEqual((await permissionGroupIds(["D1 Write", "DNS Write"], cf(["DNS Write"]))).ids["D1 Write"], "pg-D1 Write");
  assert.deepEqual(calls, ["list", "list --name D1%20Write"]);
  assert.deepEqual(await permissionGroupIds(["Gone"], cf([])), { missing: "Gone", reason: "not listed" });
});
