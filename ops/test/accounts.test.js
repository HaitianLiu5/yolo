import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { run } from "../commands/accounts.js";
import { ROOT, paths } from "../lib/paths.js";

// `accounts status` (Agent Note 2026-10-26-tencent-sports-replays): the
// plugin with an accounts setup entry is found through the plugin config and
// reads the sign-in the node would use. Nothing reaches a site.

const root = mkdtempSync(join(tmpdir(), "yolo-accounts-ops-"));
after(() => rmSync(root, { recursive: true, force: true }));

function instance(name, entry, env = "") {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "yolo.config.json"), JSON.stringify({ plugins: [entry] }));
  writeFileSync(join(dir, ".env"), env);
  return paths({ root: dir, env: {} });
}

test("status names each account, signed in through the cookies file's sign-in or not at all", async () => {
  const cookies = join(root, "cookies.txt");
  writeFileSync(cookies, ["main_login\twx", "appid\twxapp", "refresh_token\tsecret"].map((pair) => `.sports.qq.com\tTRUE\t/\tFALSE\t0\t${pair}`).join("\n"));
  const signedIn = await run({ positionals: ["status"], p: instance("cookies", { source: join(ROOT, "plugins/source-ytdlp") }, `YTDLP_COOKIES_FILE=${cookies}\n`) });
  assert.equal(signedIn.summary, "Every account is signed in");
  assert.match(signedIn.steps[0].message, /signed in, with the sign-in in the cookies file/);
  assert.doesNotMatch(JSON.stringify(signedIn), /secret/);

  const none = await run({ positionals: ["status"], p: instance("none", { source: join(ROOT, "plugins/source-ytdlp") }) });
  assert.deepEqual(none.next, ["npm run yolo -- accounts login tencent"]);
});

test("without a plugin that signs in, the commands say how to add one", async () => {
  const p = instance("example", { source: join(ROOT, "plugins/source-example") });
  for (const action of ["status", "logout"]) {
    const result = await run({ positionals: [action], p });
    assert.equal(result.status, "failed");
    assert.match(result.summary, /source-ytdlp/);
  }
});
