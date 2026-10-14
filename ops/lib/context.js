import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cloudflareAccount, withAccount } from "./cloudflare.js";
import { readEnvFile } from "./env-file.js";
import { INIT_FIX, readInstance, validateInstance, withDefaults } from "./instance.js";
import { readTemplate, renderInstanceConfig, writeGenerated } from "./wrangler-config.js";

// What every command that changes the deployment needs: a complete instance
// file, its rendered config, the node's NODE_SECRET, and wrangler signed in to
// the instance's account. `steps` explains what is missing.
export async function deployContext(p, { account = true } = {}) {
  const steps = [];
  const { exists, raw, error } = readInstance(p.instance);
  if (error || !exists) {
    steps.push({ id: "instance", status: "fail", message: error ?? `No instance file at ${p.instance}`, fix: INIT_FIX });
    return { ok: false, steps };
  }
  const problems = validateInstance(raw, { deploy: true });
  if (problems.length) {
    steps.push(...problems.map((problem) => ({ id: problem.field, status: "fail", message: problem.message, fix: problem.fix })));
    return { ok: false, steps };
  }
  const instance = withDefaults(raw);
  writeGenerated(p.generated, renderInstanceConfig(readTemplate(p.template), raw));
  const secret = readEnvFile(p.envFile)?.NODE_SECRET;
  if (!secret) {
    steps.push({ id: "secret", status: "fail", message: `No NODE_SECRET in ${p.envFile}`, fix: "npm run yolo -- init" });
    return { ok: false, steps };
  }
  let env = process.env;
  if (account) {
    const found = await cloudflareAccount(p, instance);
    steps.push({ id: "account", status: found.status, message: found.message, fix: found.fix });
    if (found.status !== "ok") return { ok: false, steps };
    env = withAccount(env, found.accountId);
  }
  const version = JSON.parse(readFileSync(join(p.root, "package.json"), "utf8")).version;
  return { ok: true, steps, raw, instance, secret, env, version };
}
