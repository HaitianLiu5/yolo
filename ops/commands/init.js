import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setEnvValues } from "../lib/env-file.js";
import { instanceFromWranglerConfig, readInstance, setField, validateInstance, withDefaults, writeInstance } from "../lib/instance.js";
import { parseJsonc } from "../lib/jsonc.js";
import { overall } from "../lib/output.js";
import { InstanceConfigError, readTemplate, renderInstanceConfig, writeGenerated } from "../lib/wrangler-config.js";

export const summary = "Create or update the instance file and the node's .env (idempotent)";
export const usage = "init --domain <host> [--account-id <id>] [--node-port <port>] [--worker <name>] [--node-label <label>] [--cloudflared-label <label>] [--import-wrangler <file>] [--change-domain]";
export const options = {
  domain: { type: "string" },
  "account-id": { type: "string" },
  "node-port": { type: "string" },
  worker: { type: "string" },
  "node-label": { type: "string" },
  "cloudflared-label": { type: "string" },
  "tunnel-name": { type: "string" },
  "import-wrangler": { type: "string" },
  "change-domain": { type: "boolean" },
};

export async function run({ values, p }) {
  const steps = [];
  const current = readInstance(p.instance);
  if (current.error) return { command: "init", status: "failed", summary: current.error, steps };
  const raw = current.raw ?? { version: 1 };

  // Values from an older wrangler config fill only what is not set yet.
  if (values["import-wrangler"]) {
    const file = values["import-wrangler"];
    let imported;
    try {
      imported = instanceFromWranglerConfig(parseJsonc(readFileSync(file, "utf8")));
    } catch (error) {
      return { command: "init", status: "failed", summary: `Cannot import ${file}: ${error.message}`, steps };
    }
    const fill = (target, source) => {
      for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === "object" && !Array.isArray(value)) fill((target[key] ??= {}), value);
        else if (target[key] == null || target[key] === "") target[key] = value;
      }
    };
    fill(raw, imported);
    steps.push({ id: "import", status: "done", message: `Imported the instance values from ${file}` });
  }

  if (values.domain) {
    const domain = values.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    if (raw.domain && raw.domain !== domain && !values["change-domain"]) {
      return {
        command: "init",
        status: "needs_approval",
        summary: `The instance is on ${raw.domain}. Moving it to ${domain} invalidates every passkey and agent authorization, because they are bound to the origin.`,
        approve: `npm run yolo -- init --domain ${domain} --change-domain`,
        steps,
      };
    }
    if (setField(raw, "domain", domain)) steps.push({ id: "domain", status: "done", message: `Domain ${domain} (PUBLIC_ORIGIN https://${domain})` });
    if (raw.publicOrigin && values["change-domain"]) delete raw.publicOrigin;
  }
  const fields = [
    ["account-id", "accountId", String],
    ["worker", "worker", String],
    ["node-port", "node.port", Number],
    ["node-label", "services.node", String],
    ["cloudflared-label", "services.cloudflared", String],
    ["tunnel-name", "tunnel.name", String],
  ];
  for (const [flag, field, cast] of fields) {
    if (values[flag] == null) continue;
    if (setField(raw, field, cast(values[flag]))) steps.push({ id: field, status: "done", message: `${field} = ${values[flag]}` });
  }

  const problems = validateInstance(raw);
  if (problems.length) {
    for (const problem of problems) steps.push({ id: problem.field, status: "fail", message: problem.message, fix: problem.fix });
    return { command: "init", status: "failed", summary: "The instance file was not written", steps };
  }
  writeInstance(p.instance, raw);
  steps.push({ id: "instance", status: current.exists ? (steps.length ? "done" : "unchanged") : "done", message: `${current.exists ? "Instance file" : "Created the instance file"} ${p.instance}` });

  // The node's .env: a NODE_SECRET of its own (never replaced), and the
  // address `npm run owner-code` prints.
  const instance = withDefaults(raw);
  const envValues = {
    NODE_SECRET: randomBytes(32).toString("base64url"),
    PUBLIC_ORIGIN: instance.publicOrigin,
    NODE_PORT: instance.node.port === 9191 ? null : instance.node.port,
  };
  const hadEnv = existsSync(p.envFile);
  const changed = setEnvValues(p.envFile, envValues, { template: join(p.root, ".env.example"), overwrite: ["PUBLIC_ORIGIN", "NODE_PORT"] });
  steps.push({
    id: "env",
    status: changed.length || !hadEnv ? "done" : "unchanged",
    message: hadEnv
      ? (changed.length ? `Set ${changed.join(", ")} in ${p.envFile}` : `${p.envFile} already has NODE_SECRET and PUBLIC_ORIGIN`)
      : `Created ${p.envFile} from .env.example with a new NODE_SECRET`,
  });

  try {
    const wrote = writeGenerated(p.generated, renderInstanceConfig(readTemplate(p.template), raw));
    steps.push({ id: "render", status: wrote ? "done" : "unchanged", message: `Rendered ${p.generated}` });
  } catch (error) {
    if (!(error instanceof InstanceConfigError)) throw error;
    steps.push({ id: "render", status: "info", message: `Not rendered yet: ${error.problems.map((problem) => problem.field).join(", ")} still to provision` });
  }

  return {
    command: "init",
    status: overall(steps),
    summary: `Instance ${instance.domain ?? "(no domain yet)"}`,
    instance: p.instance,
    envFile: p.envFile,
    steps,
    next: ["npm run yolo -- provision (D1, KV, tunnel, Workers VPC)", "npm run yolo -- doctor"],
  };
}
