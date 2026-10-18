import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDeviceLogin, verifyLink } from "../lib/cf.js";
import { cloudflareEnv } from "../lib/credentials.js";
import { paths } from "../lib/paths.js";

// `npm run yolo -- auth` (Agent Note 2026-10-13-agent-deployment): the owner
// gets cf's device page with the code filled in, and only a page on
// dash.cloudflare.com is passed on; wrangler acts with the stored token.

test("the device link comes from cf's output and only for dash.cloudflare.com", () => {
  const text = "To authorize Cloudflare CLI, please visit:\n\n  https://dash.cloudflare.com/oauth2/device/verify\n\nand enter the code:\n\n  WDJB-MJHT\n\nYou have 5 minutes to approve this request.\n";
  const link = "https://dash.cloudflare.com/oauth2/device/verify?user_code=WDJB-MJHT";
  assert.deepEqual(parseDeviceLogin(text), { page: "https://dash.cloudflare.com/oauth2/device/verify", code: "WDJB-MJHT", link, expires: "5 minutes" });
  assert.equal(verifyLink("AB CD"), "https://dash.cloudflare.com/oauth2/device/verify?user_code=AB+CD");
  assert.equal(parseDeviceLogin(text.replace("dash.cloudflare.com", "dash.cloudflare.com.evil.example")), null);
});

test("wrangler gets the stored token unless the environment carries a credential", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yolo-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = paths({ env: { YOLO_INSTANCE: join(dir, "yolo.instance.json") } });
  assert.deepEqual(cloudflareEnv(p, { A: "1" }), { A: "1" });
  mkdirSync(p.state, { recursive: true });
  writeFileSync(p.cloudflareToken, JSON.stringify({ token: "stored", accountId: "acc" }));
  assert.deepEqual(cloudflareEnv(p, { A: "1" }), { A: "1", CLOUDFLARE_API_TOKEN: "stored", CLOUDFLARE_ACCOUNT_ID: "acc" });
  assert.equal(cloudflareEnv(p, { CLOUDFLARE_API_TOKEN: "exported" }).CLOUDFLARE_API_TOKEN, "exported");
});
