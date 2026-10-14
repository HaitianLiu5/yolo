import { z } from "zod";
import { SCOPES, TOOLS } from "./mcp/tools.js";

// Control entries of plugins (Agent Note 2026-10-11-plugin-architecture).
// Workers cannot load code at runtime, so scripts/generate-plugins.js writes
// plugins.generated.js with a static import of every configured control entry,
// and wrangler bundles them into the Worker. This module calls their factories,
// the same way the node does: a factory that throws is reported and dropped
// with everything it registered, and the Worker keeps serving.
//
// A control entry can add MCP tools, which are served next to Yolo's own
// tools under the same OAuth scopes, and DNS providers, which name the
// node's media listeners when the instance chooses one
// (Agent Note 2026-10-14-dns-provider-plugins, edge/dns.js).

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
const LEVELS = Object.freeze(["debug", "info", "warn", "error"]);
const DNS_PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
// The names Yolo's Worker itself reads (wrangler.jsonc): its secrets, vars,
// and bindings. A DNS provider names a secret of its own; edge/dns.js also
// refuses a value that is not a string.
const OWN_NAMES = Object.freeze([
  "NODE_SECRET", "NODE_ACCESS_CLIENT_ID", "NODE_ACCESS_CLIENT_SECRET", "MEDIA_DNS_TOKEN", "LAN_DNS_TOKEN",
  "PUBLIC_ORIGIN", "NODE_TRANSPORT", "NODE_ORIGIN", "NODE_PUBLIC_ORIGIN", "LAN_ACME_DIRECTORY", "WAN_CERTIFICATE", "MEDIA_DNS_PROVIDER", "MEDIA_DNS_ZONE",
  "DB", "OAUTH_KV", "HUB", "NODE", "ASSETS", "PUBLIC_LIMIT", "MEDIA_DENIED_LIMIT", "FRAME_LIMIT", "IMAGE_LIMIT",
]);

// A DNS provider: its id (the instance's media.dns.provider), the Worker
// secret the control plane reads for it and hands to `create`, and
// `create({ token, zone, fetch, sleep })` → the provider (edge/dns.js). The
// secret is named after the provider (`my-dns` → `MY_DNS_…`), is none of
// Yolo's own names, and belongs to one provider only. `taken` are the
// providers registered so far.
function checkDnsProvider(id, definition, { plugin, taken }) {
  const name = String(id ?? "");
  if (name === "cloudflare") throw new TypeError("The DNS provider cloudflare is built in");
  if (!DNS_PROVIDER_ID.test(name)) throw new TypeError(`DNS provider id "${name}" must be lowercase letters, digits, and dashes`);
  if (taken.some((provider) => provider.id === name)) throw new TypeError(`DNS provider ${name} already exists`);
  const secret = String(definition?.secret ?? "");
  if (!SECRET_NAME.test(secret)) throw new TypeError(`DNS provider ${name}: secret must name a Worker secret in UPPER_SNAKE_CASE`);
  if (OWN_NAMES.includes(secret)) throw new TypeError(`DNS provider ${name}: ${secret} is one of Yolo's own secrets, vars, or bindings; name a secret of the provider's own`);
  const prefix = `${name.toUpperCase().replaceAll("-", "_")}_`;
  if (!secret.startsWith(prefix)) throw new TypeError(`DNS provider ${name}: its secret must start with ${prefix}, such as ${prefix}TOKEN`);
  const holder = taken.find((provider) => provider.secret === secret);
  if (holder) throw new TypeError(`DNS provider ${name}: ${secret} is already the secret of the DNS provider ${holder.id}`);
  if (typeof definition.create !== "function") throw new TypeError(`DNS provider ${name} needs a create({ token, zone, fetch, sleep }) function`);
  return { id: name, plugin, title: typeof definition.title === "string" && definition.title ? definition.title : name, secret, create: definition.create };
}

function checkTool(definition, taken) {
  const tool = definition && typeof definition === "object" ? definition : {};
  const name = String(tool.name ?? "");
  if (!TOOL_NAME.test(name)) throw new TypeError(`Tool name "${name}" must be lower_snake_case`);
  if (taken.has(name)) throw new TypeError(`Tool ${name} already exists`);
  if (typeof tool.title !== "string" || !tool.title) throw new TypeError(`Tool ${name} needs a title`);
  if (typeof tool.description !== "string" || !tool.description) throw new TypeError(`Tool ${name} needs a description`);
  if (!SCOPES.includes(tool.scope)) throw new TypeError(`Tool ${name}: scope must be one of ${SCOPES.join(", ")}`);
  if (!tool.input?.["~standard"]) throw new TypeError(`Tool ${name}: input must be a schema such as yolo.z.object({ … })`);
  if (typeof tool.run !== "function") throw new TypeError(`Tool ${name} needs a run(args, context) function`);
  if (tool.annotations !== undefined && (typeof tool.annotations !== "object" || tool.annotations === null)) {
    throw new TypeError(`Tool ${name}: annotations must be an object`);
  }
  return {
    name,
    title: tool.title,
    description: tool.description,
    scope: tool.scope,
    annotations: { ...WRITE, ...tool.annotations },
    input: tool.input,
    // Same calling convention as Yolo's own tools (mcp/server.js).
    run: (services, args) => tool.run(args, { services }),
  };
}

// `entries` is the generated list: [{ name, version, options, factory }].
// Resolves to { tools, dnsProviders, plugins }, where plugins reports each
// one's status.
export async function loadControlPlugins(entries, { logger = console } = {}) {
  const tools = [];
  const dnsProviders = [];
  const plugins = [];
  const taken = new Set(TOOLS.map((tool) => tool.name));
  for (const entry of entries) {
    const prefix = `[${entry.name}]`;
    const log = Object.freeze(Object.fromEntries(LEVELS.map((level) => [level, (...args) => logger[level](prefix, ...args)])));
    const record = { name: entry.name, version: entry.version ?? null, status: "loaded", tools: [] };
    plugins.push(record);
    const pending = [];
    const pendingDns = [];
    let loading = true;
    const yolo = Object.freeze({
      plugin: Object.freeze({ name: entry.name, version: entry.version ?? null }),
      options: Object.freeze(structuredClone(entry.options ?? {})),
      log,
      z,
      registerTool(definition) {
        if (!loading) throw new Error(`${entry.name}: register tools while the plugin factory runs`);
        pending.push(checkTool(definition, new Set([...taken, ...pending.map((tool) => tool.name)])));
      },
      registerDnsProvider(id, definition) {
        if (!loading) throw new Error(`${entry.name}: register DNS providers while the plugin factory runs`);
        pendingDns.push(checkDnsProvider(id, definition, { plugin: entry.name, taken: [...dnsProviders, ...pendingDns] }));
      },
    });
    try {
      if (typeof entry.factory !== "function") throw new Error("the control entry's default export is not a function");
      await entry.factory(yolo);
      for (const tool of pending) taken.add(tool.name);
      tools.push(...pending);
      dnsProviders.push(...pendingDns);
      record.tools = pending.map((tool) => tool.name);
      if (pendingDns.length) record.dnsProviders = pendingDns.map((provider) => provider.id);
    } catch (error) {
      record.status = "failed";
      record.error = error?.message || String(error);
      log.error(`failed to load: ${record.error}`);
    } finally {
      loading = false;
    }
  }
  return { tools, dnsProviders, plugins };
}
