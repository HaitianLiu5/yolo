// Which routes a host's requests take (Agent Note 2026-10-13-node-egress-proxy).
// The owner's yolo.config.json names proxies and lists rules:
//
//   "egress": {
//     "proxies": { "<name>": { "provider": "<provider id>", "options": { … } } },
//     "rules": [{ "hosts": ["*.example.com", "api.example.net"], "via": ["<name>", "direct"] }]
//   }
//
// The first rule whose hosts match applies, and its `via` lists the routes to
// try in order; `direct` is one of them. A host no rule matches goes direct.
// A rule without `direct` sends its hosts only through proxies, so they never
// go direct when every proxy fails. "*.example.com" matches the subdomains of
// example.com, not example.com itself.

export const DIRECT = "direct";
const NAME = /^[a-z][a-z0-9-]*$/;
const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// The `egress` section → { proxies: Map(name → { provider, options }), rules }.
// Throws on a malformed section: a typo must not send traffic another way.
export function readEgress(section, where = "egress") {
  if (section == null) return { proxies: new Map(), rules: [] };
  if (!isObject(section)) throw new Error(`${where} must be an object`);
  const proxies = new Map();
  if (section.proxies !== undefined && !isObject(section.proxies)) throw new Error(`${where}.proxies must be an object`);
  for (const [name, value] of Object.entries(section.proxies ?? {})) {
    if (!NAME.test(name) || name === DIRECT) throw new Error(`${where}.proxies: "${name}" must be lowercase letters, digits and dashes, starting with a letter, and not "${DIRECT}"`);
    if (!isObject(value) || typeof value.provider !== "string" || !value.provider) throw new Error(`${where}.proxies.${name}.provider must name a proxy provider`);
    if (value.options !== undefined && !isObject(value.options)) throw new Error(`${where}.proxies.${name}.options must be an object`);
    proxies.set(name, { provider: value.provider, options: value.options ?? {} });
  }
  if (section.rules !== undefined && !Array.isArray(section.rules)) throw new Error(`${where}.rules must be an array`);
  const rules = (section.rules ?? []).map((rule, index) => {
    const at = `${where}.rules[${index}]`;
    if (!isObject(rule)) throw new Error(`${at} must be an object`);
    const hosts = Array.isArray(rule.hosts) ? rule.hosts.map((host) => String(host).trim().toLowerCase()) : [];
    if (!hosts.length || hosts.some((host) => !HOST.test(host))) throw new Error(`${at}.hosts must list host names, each optionally starting with "*."`);
    const via = Array.isArray(rule.via) ? rule.via.map(String) : [];
    if (!via.length) throw new Error(`${at}.via must list routes: "${DIRECT}" or names from ${where}.proxies`);
    for (const route of via) {
      if (route !== DIRECT && !proxies.has(route)) throw new Error(`${at}.via: "${route}" is not "${DIRECT}" or a name in ${where}.proxies`);
    }
    return { hosts, via: [...new Set(via)] };
  });
  return { proxies, rules };
}

export function hostMatches(pattern, host) {
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

// A URL's or host's host name, lowercase, without port or IPv6 brackets.
export function hostName(target) {
  const text = String(target ?? "");
  try {
    return new URL(text).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return text.replace(/^\[|\]$/g, "").toLowerCase();
  }
}

// The routes for a host, in order: the first matching rule's `via`, else direct.
export function routesFor(egress, target) {
  const host = hostName(target);
  const rule = egress.rules.find((candidate) => candidate.hosts.some((pattern) => hostMatches(pattern, host)));
  return rule ? rule.via : [DIRECT];
}
