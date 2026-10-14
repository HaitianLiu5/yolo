import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiToken, cloudflareAccount, cloudflareApi, registerWorkersSubdomain, withAccount, workersSubdomain } from "../lib/cloudflare.js";
import { setEnvValues } from "../lib/env-file.js";
import { instanceFromWranglerConfig, readInstance, setField, SUBDOMAIN, validateInstance, withDefaults, workersDevHost, writeInstance } from "../lib/instance.js";
import { parseJsonc } from "../lib/jsonc.js";
import { overall } from "../lib/output.js";
import { InstanceConfigError, readTemplate, renderInstanceConfig, writeGenerated } from "../lib/wrangler-config.js";

export const summary = "Create or update the instance file and the node's .env (idempotent); without --domain, the instance is served on workers.dev";
export const usage = "init [--domain <host> | --workers-dev] [--worker <name>] [--workers-subdomain <name>] [--account-id <id>] [--node-port <port>] [--node-label <label>] [--cloudflared-label <label>] [--import-wrangler <file>] [--change-domain]";
export const options = {
  domain: { type: "string" },
  "workers-dev": { type: "boolean" },
  "workers-subdomain": { type: "string" },
  "account-id": { type: "string" },
  "node-port": { type: "string" },
  worker: { type: "string" },
  "node-label": { type: "string" },
  "cloudflared-label": { type: "string" },
  "tunnel-name": { type: "string" },
  "import-wrangler": { type: "string" },
  "change-domain": { type: "boolean" },
};

// What init asks Cloudflare, replaceable in tests. Reading the account and
// its workers.dev subdomain changes nothing; `register` runs only for an
// approved --workers-subdomain.
export const cloudflare = {
  account: (p, instance) => cloudflareAccount(p, instance),
  api: async (p, env) => {
    const token = await apiToken(p, env);
    return token ? cloudflareApi(token, { env }) : null;
  },
  subdomain: workersSubdomain,
  register: registerWorkersSubdomain,
};

// A name that says nothing about the owner: `<prefix>-` and six random
// lowercase letters and digits.
export function randomName(prefix, bytes = randomBytes(6)) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `${prefix}-${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

// Whether a workers.dev subdomain looks made from the account's email or
// name, which Cloudflare does for older accounts.
export function personalSubdomain(subdomain, { email = null, names = [] } = {}) {
  const flat = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const sub = flat(subdomain);
  if (/-s-account$/.test(subdomain)) return true;
  return [String(email ?? "").split("@")[0], ...names].map(flat).some((part) => part.length >= 3 && sub.includes(part));
}

// The same init command, by default with --change-domain, for an approval.
function approvalCommand(values, { change = true } = {}) {
  const args = [];
  for (const [key, value] of Object.entries(values)) {
    if (key === "json" || key === "change-domain" || value == null || value === false) continue;
    args.push(value === true ? `--${key}` : `--${key} ${value}`);
  }
  if (change) args.push("--change-domain");
  return ["npm run yolo -- init", ...args].join(" ");
}

const MOVE_COST = "invalidates every passkey (the owner registers one again with the 6-digit code), every agent authorization, and every paired screen, because they are bound to the origin";

// The account's workers.dev subdomain, registering one only with the
// owner's approval. Returns { subdomain } or { step } that stops.
async function findSubdomain({ p, raw, values, steps, deps }) {
  const account = await deps.account(p, withDefaults(raw));
  if (account.status !== "ok") return { step: { id: "account", status: account.status, message: `${account.message}: the workers.dev host needs the account's subdomain`, fix: account.fix } };
  if (account.chosen) setField(raw, "accountId", account.accountId);
  const api = await deps.api(p, withAccount(process.env, account.accountId));
  if (!api) return { step: { id: "subdomain", status: "fail", message: "Cannot get the token wrangler signs in with", fix: "npx wrangler login, then npm run yolo -- init" } };
  let subdomain;
  try {
    subdomain = await deps.subdomain(api, account.accountId);
  } catch (error) {
    return { step: { id: "subdomain", status: "fail", message: `Cannot read the account's workers.dev subdomain: ${error.message}`, fix: "npm run yolo -- doctor" } };
  }
  const wanted = values["workers-subdomain"]?.toLowerCase() ?? null;
  if (!subdomain) {
    if (!wanted) {
      const suggested = randomName("home");
      return {
        step: {
          id: "subdomain",
          status: "needs_approval",
          message: `The account has no workers.dev subdomain yet. Registering one changes the account: every Worker in it is served under that name, and the name is public for good (Certificate Transparency logs keep it). Choose one that says nothing about the owner, such as ${suggested}`,
          fix: `npm run yolo -- init --workers-subdomain ${suggested}`,
        },
        approve: approvalCommand({ ...values, "workers-subdomain": suggested }, { change: Boolean(values["change-domain"]) }),
      };
    }
    if (!SUBDOMAIN.test(wanted)) return { step: { id: "subdomain", status: "fail", message: `"${wanted}" is not a valid workers.dev subdomain`, fix: "Use lowercase letters, digits and dashes" } };
    try {
      subdomain = await deps.register(api, account.accountId, wanted);
    } catch (error) {
      return { step: { id: "subdomain", status: "fail", message: `Cannot register the workers.dev subdomain ${wanted}: ${error.message}`, fix: "Choose another name; it must be free across Cloudflare" } };
    }
    steps.push({ id: "subdomain", status: "done", message: `Registered the account's workers.dev subdomain ${subdomain}` });
  } else if (wanted && wanted !== subdomain) {
    steps.push({ id: "subdomain", status: "info", message: `The account already has the workers.dev subdomain ${subdomain}; --workers-subdomain is ignored. Renaming it moves every Worker of the account and is done in the dashboard` });
  }
  if (personalSubdomain(subdomain, { email: account.email, names: (account.accounts ?? []).filter((entry) => entry.id === account.accountId).map((entry) => entry.name) })) {
    steps.push({
      id: "subdomain.name",
      status: "warn",
      message: `The account's workers.dev subdomain "${subdomain}" looks made from the owner's email or name, and it is public for good in Certificate Transparency logs`,
      fix: "Before the first deploy, the owner may rename it in the dashboard (Workers & Pages, the account's subdomain), then npm run yolo -- init; renaming it after the first deploy moves the address",
    });
  }
  return { subdomain };
}

export async function run({ values, p, deps = cloudflare }) {
  const steps = [];
  const current = readInstance(p.instance);
  if (current.error) return { command: "init", status: "failed", summary: current.error, steps };
  const raw = current.raw ?? { version: 1 };
  // The address passkeys, agents, and screens are bound to now.
  const before = current.exists ? withDefaults(current.raw) : null;

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

  if (values.domain && values["workers-dev"]) return { command: "init", status: "failed", summary: "Choose --domain or --workers-dev, not both", steps };
  const change = Boolean(values["change-domain"]);
  // workers.dev when asked, or when nothing gives the instance a domain.
  const workersDev = Boolean(values["workers-dev"]) || (!values.domain && (raw.workersDev === true || !raw.domain));

  if (values.domain) {
    const domain = values.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    const from = raw.workersDev ? before?.publicOrigin : raw.domain && raw.domain !== domain ? `https://${raw.domain}` : null;
    if (from && !change) {
      return { command: "init", status: "needs_approval", summary: `The instance is on ${from}. Moving it to https://${domain} ${MOVE_COST}.`, approve: `npm run yolo -- init --domain ${domain} --change-domain`, steps };
    }
    if (raw.workersDev) {
      delete raw.workersDev;
      delete raw.host;
    }
    if (setField(raw, "domain", domain)) steps.push({ id: "domain", status: "done", message: `Domain ${domain} (PUBLIC_ORIGIN https://${domain})` });
    if (raw.publicOrigin && change) delete raw.publicOrigin;
  } else if (workersDev) {
    if (raw.domain && !change) {
      return { command: "init", status: "needs_approval", summary: `The instance is on https://${raw.domain}. Moving it to workers.dev ${MOVE_COST}.`, approve: approvalCommand({ ...values, "workers-dev": true }), steps };
    }
    if (raw.domain && raw.publicOrigin) delete raw.publicOrigin;
    if (raw.domain || raw.workersDev !== true) steps.push({ id: "workersDev", status: "done", message: "No domain: the Worker is served on the account's workers.dev subdomain" });
    raw.domain = null;
    raw.workersDev = true;
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

  let approve = null;
  if (workersDev && !values.domain) {
    // A new instance gets a Worker name of its own; one that had a domain
    // keeps its Worker, so the move does not leave the old one serving.
    if (!raw.worker && !before?.host) {
      raw.worker = randomName("yolo");
      steps.push({ id: "worker", status: "done", message: `Worker name ${raw.worker}, which says nothing about the owner; to choose another before the first deploy: npm run yolo -- init --worker <name>` });
    }
    const found = await findSubdomain({ p, raw, values, steps, deps });
    if (found.step) {
      steps.push(found.step);
      approve = found.approve ?? null;
    } else {
      const host = workersDevHost(withDefaults(raw).worker, found.subdomain);
      if (setField(raw, "host", host)) steps.push({ id: "host", status: "done", message: `Served at https://${host}` });
    }
  }

  // Any other move of the origin, such as a new Worker name or a renamed
  // workers.dev subdomain, needs the same approval.
  const after = withDefaults(raw);
  if (before?.publicOrigin && after.publicOrigin && after.publicOrigin !== before.publicOrigin && !change) {
    return { command: "init", status: "needs_approval", summary: `The instance is on ${before.publicOrigin}. Moving it to ${after.publicOrigin} ${MOVE_COST}.`, approve: approvalCommand(values), steps };
  }

  const problems = validateInstance(raw);
  if (problems.length) {
    for (const problem of problems) steps.push({ id: problem.field, status: "fail", message: problem.message, fix: problem.fix });
    return { command: "init", status: "failed", summary: "The instance file was not written", steps };
  }
  writeInstance(p.instance, raw);
  steps.push({ id: "instance", status: current.exists ? (steps.some((step) => step.status === "done") ? "done" : "unchanged") : "done", message: `${current.exists ? "Instance file" : "Created the instance file"} ${p.instance}` });

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

  const status = overall(steps);
  return {
    command: "init",
    status,
    summary: `Instance ${instance.publicOrigin ?? "(no address yet)"}${instance.workersDev ? " on workers.dev, without a domain" : ""}`,
    instance: p.instance,
    envFile: p.envFile,
    publicOrigin: instance.publicOrigin,
    ...(approve ? { approve } : {}),
    steps,
    next: status === "ok" ? ["npm run yolo -- provision (D1, KV, tunnel, Workers VPC)", "npm run yolo -- doctor"] : [],
  };
}
