import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { resetImageLinks, run } from "../commands/image-links.js";
import { paths } from "../lib/paths.js";

// `npm run yolo -- image-links reset` (Agent Note 2026-10-07-remote-mcp-server):
// the operator's reset of agents' image links, one statement through
// wrangler against the instance's remote D1.

const p = paths();

test("the operator's reset moves every user to the next key version in one statement on the remote D1", async () => {
  const calls = [];
  const exec = async (_p, args, options) => {
    calls.push({ args, options });
    return { code: 0, stdout: JSON.stringify([{ results: [], success: true, meta: { changes: 1 } }]), stderr: "" };
  };
  const ctx = { instance: { d1: { name: "yolo" } }, env: { CLOUDFLARE_ACCOUNT_ID: "account" } };
  const step = await resetImageLinks(p, ctx, { exec });
  assert.equal(step.status, "done");
  const [{ args, options }] = calls;
  assert.deepEqual(args.slice(0, 5), ["d1", "execute", "yolo", "--remote", "--json"]);
  assert.equal(args[5], "--command");
  assert.equal(options.env, ctx.env);

  // That statement, run on the real schema: no row means version 1, and each
  // run adds one for every user.
  const db = new Database(":memory:");
  for (const file of readdirSync(p.migrations).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(join(p.migrations, file), "utf8"));
  db.prepare("INSERT INTO users (id, user_id, display_name, created_at) VALUES ('usr_a', 'usr_a', 'Owner', 0)").run();
  const version = () => db.prepare("SELECT key_version FROM image_links WHERE user_id = 'usr_a'").get()?.key_version ?? 1;
  assert.equal(version(), 1);
  db.exec(args[6]);
  assert.equal(version(), 2);
  db.exec(args[6]);
  assert.equal(version(), 3);
  assert.ok(db.prepare("SELECT reset_at FROM image_links").get().reset_at > 0);
});

test("a reset that D1 refuses says why, and one without the table says to migrate", async () => {
  const ctx = { instance: { d1: { name: "yolo" } }, env: {} };
  const refused = await resetImageLinks(p, ctx, { exec: async () => ({ code: 1, stdout: "", stderr: "✘ [ERROR] no such table: image_links: SQLITE_ERROR" }) });
  assert.equal(refused.status, "fail");
  assert.match(refused.fix, /yolo -- migrate/);
  assert.equal((await run({ positionals: ["rotate"], values: {}, p })).status, "failed");
});
