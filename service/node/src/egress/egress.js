import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { silentLogger } from "../log.js";
import { createEgressListener } from "./listener.js";
import { DIRECT, hostName, readEgress, routesFor } from "./rules.js";

// The node's egress layer (Agent Note 2026-10-13-node-egress-proxy): it sends
// the upstream requests the owner's rules choose (rules.js) through named
// proxies, and every other request direct. It is never a global proxy: the
// tunnel to the control plane and the machine's other connections never see
// it.
//
// - Proxy providers are plugins (yolo.registerProxyProvider). A provider
//   only hands out the current endpoint, { url, username?, password?,
//   expiresAt? } with an http or https URL; it never sees which requests use
//   it. The node asks again shortly before `expiresAt`, after the proxy
//   refuses the credentials (407, `refused`), after the proxy itself fails
//   (it cannot be reached, or it answers CONNECT with 502, 503, or 504,
//   `failed`; at most once every RETRY_FAILED_MS), and RETRY_UNAVAILABLE_MS
//   after a provider had none. A request whose proxy refused or failed is
//   tried once more when the provider hands out a different endpoint.
// - The node's own requests (the media pipeline, `yolo.fetch`) go through
//   fetch() below.
// - Child processes (a plugin's extractor, ffmpeg) get a proxy on 127.0.0.1 (listener.js)
//   that applies the same rules to each connection, so a credential never
//   appears in a command line.
//
// No log line or error carries a proxy's address or credentials; proxies are
// named by their names in the config.

export const RENEW_BEFORE_MS = 60_000;
export const RETRY_UNAVAILABLE_MS = 30_000;
export const RETRY_FAILED_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_CONNECT_RESPONSE_BYTES = 16 * 1024;
const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
const PROVIDER_FIELDS = Object.freeze(["endpoint"]);
// Error codes that mean the proxy itself could not be reached or dropped the
// connection before answering.
const PROXY_FAULTS = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "EGRESS_PROXY_TIMEOUT"]);

export function checkProxyProviderImpl(id, impl) {
  if (!PROVIDER_ID.test(String(id))) throw new TypeError(`Proxy provider id "${id}" must be lowercase letters, digits and dashes, starting with a letter`);
  if (!impl || typeof impl !== "object") throw new TypeError(`Proxy provider ${id} must be an object of methods`);
  if (typeof impl.endpoint !== "function") throw new TypeError(`Proxy provider ${id}: endpoint must be a function`);
  return Object.keys(impl).filter((key) => !PROVIDER_FIELDS.includes(key));
}

// What a provider returned → { url (origin only), username, password, expiresAt }.
export function readEndpoint(value) {
  if (!value || typeof value !== "object") throw new TypeError("the endpoint must be an object");
  let parsed;
  try {
    parsed = new URL(String(value.url));
  } catch {
    throw new TypeError("the endpoint's url is not a URL");
  }
  if (parsed.protocol === "socks5:" || parsed.protocol === "socks:") throw new TypeError("SOCKS proxies are not supported yet; use an http or https proxy");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TypeError("the endpoint's url must be http or https");
  const username = value.username ?? (parsed.username ? decodeURIComponent(parsed.username) : null);
  const password = value.password ?? (parsed.password ? decodeURIComponent(parsed.password) : null);
  const expiresAt = value.expiresAt == null ? null : Number(value.expiresAt);
  if (expiresAt != null && !Number.isFinite(expiresAt)) throw new TypeError("the endpoint's expiresAt must be a time in milliseconds");
  return { url: `${parsed.protocol}//${parsed.host}`, username: username == null ? null : String(username), password: password == null ? null : String(password), expiresAt };
}

const basic = ({ username, password }) => (username == null ? null : `Basic ${Buffer.from(`${username}:${password ?? ""}`).toString("base64")}`);

// An error's message, and its causes', without the endpoint's credentials.
function redact(error, endpoint) {
  let text = error?.message || String(error);
  for (let cause = error?.cause, depth = 0; cause && depth < 3; cause = cause.cause, depth += 1) {
    if (cause.message && !text.includes(cause.message)) text += `: ${cause.message}`;
  }
  for (const secret of [endpoint?.password, endpoint?.username, endpoint && basic(endpoint)]) {
    if (secret) text = text.split(secret).join("…");
  }
  return text;
}

// Whether a proxy answered 407, anywhere in an error's causes (undici puts
// its tunnel's answer two causes deep).
function refusedCredentials(error) {
  for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth += 1) {
    if (cause.status === 407 || /\b407\b/.test(cause.message ?? "")) return true;
  }
  return false;
}

// Whether the proxy itself failed, anywhere in an error's causes: it could not
// be reached, or it could not open a tunnel (502, 503, or 504 to CONNECT,
// which undici reports only in its message).
function proxyFailed(error) {
  for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth += 1) {
    if (PROXY_FAULTS.has(cause.code)) return true;
    const status = cause.status ?? Number(/Proxy response \((\d{3})\)/.exec(cause.message ?? "")?.[1]);
    if (status >= 502 && status <= 504) return true;
  }
  return false;
}

const sameEndpoint = (a, b) => a.url === b.url && a.username === b.username && a.password === b.password;

// A TCP connection to host:port through an HTTP proxy's CONNECT, paused, with
// whatever the proxy sent after its answer put back.
export function tunnel(endpoint, host, port, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(endpoint.url);
    const secure = proxy.protocol === "https:";
    const proxyPort = Number(proxy.port) || (secure ? 443 : 80);
    const socket = secure ? tlsConnect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname }) : netConnect({ host: proxy.hostname, port: proxyPort });
    const authority = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
    let buffered = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", finish);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error(`the proxy did not open ${authority} within ${Math.round(timeoutMs / 1000)}s`), { code: "EGRESS_PROXY_TIMEOUT" })), timeoutMs);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > MAX_CONNECT_RESPONSE_BYTES) finish(new Error("the proxy's answer to CONNECT is too long"));
        return;
      }
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buffered.subarray(0, end).toString("latin1"))?.[1]);
      if (status !== 200) {
        const error = new Error(`the proxy answered CONNECT ${authority} with ${status || "something other than HTTP"}`);
        error.status = status;
        return finish(error);
      }
      socket.pause();
      const rest = buffered.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      finish(null, socket);
    };
    socket.on("data", onData);
    socket.once("error", finish);
    socket.once(secure ? "secureConnect" : "connect", () => {
      const auth = basic(endpoint);
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
    });
  });
}

// A direct TCP connection to host:port.
export function connectDirect(host, port, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${host}:${port} did not answer within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// `config` is yolo.config.json's `egress` section. Without one, fetch() is
// the plain fetch and no listener starts.
export function createEgress({
  config = null,
  logger = silentLogger,
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  proxyFetch = undiciFetch,
  openTunnel = tunnel,
  openDirect = connectDirect,
} = {}) {
  const egress = readEgress(config);
  const providers = new Map(); // id → { impl, plugin }
  // Proxy name → { endpoint, agent, pending, unavailableUntil, failedUntil, error }.
  const states = new Map([...egress.proxies.keys()].map((name) => [name, { endpoint: null, agent: null, pending: null, unavailableUntil: 0, failedUntil: 0, error: null }]));
  const enabled = egress.rules.length > 0;
  let listener = null;

  function unavailable(name, message) {
    const error = new Error(`The egress proxy ${name} is unavailable: ${message}`);
    error.code = "EGRESS_PROXY_UNAVAILABLE";
    return error;
  }

  async function ask(name, state, { refused, failed }) {
    const { provider, options } = egress.proxies.get(name);
    const entry = providers.get(provider);
    if (!entry) throw unavailable(name, `no plugin registered the proxy provider "${provider}"`);
    try {
      const endpoint = readEndpoint(await entry.impl.endpoint(options, { refused, failed }));
      state.agent?.close().catch(() => {});
      Object.assign(state, { endpoint, agent: null, unavailableUntil: 0, error: null });
      logger.info({ proxy: name, provider, ...(endpoint.expiresAt ? { expiresAt: new Date(endpoint.expiresAt).toISOString() } : {}) }, refused ? "Egress proxy renewed after refused credentials" : failed ? "Egress proxy renewed after it failed" : "Egress proxy ready");
      return endpoint;
    } catch (error) {
      const message = redact(error, state.endpoint);
      Object.assign(state, { unavailableUntil: now() + RETRY_UNAVAILABLE_MS, error: message });
      logger.warn({ proxy: name, provider, err: message }, "Egress proxy provider failed");
      throw unavailable(name, message);
    }
  }

  // The proxy's current endpoint, asking its provider when there is none,
  // it is about to expire, or `refused` or `failed` says the proxy refused it
  // or failed.
  function endpoint(name, { refused = false, failed = false } = {}) {
    const state = states.get(name);
    const fresh = state.endpoint && !refused && !failed && (state.endpoint.expiresAt == null || state.endpoint.expiresAt - RENEW_BEFORE_MS > now());
    if (fresh) return Promise.resolve(state.endpoint);
    if (!refused && !failed && now() < state.unavailableUntil) return Promise.reject(unavailable(name, state.error));
    state.pending ??= ask(name, state, { refused, failed }).finally(() => {
      state.pending = null;
    });
    return state.pending;
  }

  // After the proxy refused `stale`'s credentials or failed with it: the
  // endpoint to try once more, or null when there is no different one. A
  // failure asks the provider at most once every RETRY_FAILED_MS, so a site
  // the proxy cannot reach does not make it look for a new line each time.
  async function replacement(name, stale, error) {
    const state = states.get(name);
    if (state.pending) await state.pending.catch(() => {});
    if (state.endpoint && state.endpoint !== stale) return state.endpoint;
    const refused = refusedCredentials(error);
    if (!refused) {
      if (!proxyFailed(error) || now() < state.failedUntil) return null;
      state.failedUntil = now() + RETRY_FAILED_MS;
    }
    const next = await endpoint(name, { refused, failed: !refused });
    return sameEndpoint(next, stale) ? null : next;
  }

  function agentFor(name, current) {
    const state = states.get(name);
    if (state.endpoint === current && state.agent) return state.agent;
    const token = basic(current);
    const agent = new ProxyAgent({ uri: current.url, ...(token ? { token } : {}) });
    if (state.endpoint === current) state.agent = agent;
    return agent;
  }

  async function viaProxy(name, input, init) {
    let current = await endpoint(name);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await proxyFetch(input, { ...init, dispatcher: agentFor(name, current) });
        if (response.status !== 407) return response;
        await response.body?.cancel().catch(() => {});
        throw Object.assign(new Error("the proxy refused the credentials"), { status: 407 });
      } catch (error) {
        if (init?.signal?.aborted) throw error;
        const next = attempt === 0 ? await replacement(name, current, error) : null;
        if (next) {
          current = next;
          continue;
        }
        const wrapped = new Error(`Through the egress proxy ${name}: ${redact(error, current)}`);
        wrapped.code = error.code;
        throw wrapped;
      }
    }
  }

  // fetch() that takes the routes the rules give the URL's host, moving to
  // the next route when one fails before a response. A request whose body
  // is a stream tries only its first route.
  async function egressFetch(input, init = {}) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const routes = routesFor(egress, url);
    if (routes.length === 1 && routes[0] === DIRECT) return fetchImpl(input, init);
    const once = init.body != null && typeof init.body === "object" && typeof init.body.getReader === "function";
    let lastError = null;
    for (const route of once ? routes.slice(0, 1) : routes) {
      try {
        return route === DIRECT ? await fetchImpl(input, init) : await viaProxy(route, input, init);
      } catch (error) {
        if (init.signal?.aborted) throw error;
        lastError = error;
        logger.warn({ host: hostName(url), route, err: error.message }, "Egress route failed");
      }
    }
    throw lastError;
  }

  // A connection to host:port for the listener, over the first route that
  // opens. The route is logged at debug level.
  async function open(host, port) {
    let lastError = null;
    for (const route of routesFor(egress, host)) {
      try {
        if (route === DIRECT) return { route, socket: await openDirect(host, port) };
        let current = await endpoint(route);
        try {
          return { route, socket: await openTunnel(current, host, port) };
        } catch (error) {
          const next = await replacement(route, current, error);
          if (!next) throw new Error(redact(error, current));
          current = next;
        }
        try {
          return { route, socket: await openTunnel(current, host, port) };
        } catch (error) {
          throw new Error(redact(error, current));
        }
      } catch (error) {
        lastError = error;
        logger.warn({ host, route, err: error.message }, "Egress route failed");
      }
    }
    throw lastError ?? new Error(`No route to ${host}`);
  }

  return {
    enabled,
    fetch: enabled ? egressFetch : fetchImpl,
    routes: (target) => routesFor(egress, target),

    registerProvider(id, impl, plugin) {
      if (providers.has(id)) throw new Error(`The proxy provider id "${id}" is already registered`);
      providers.set(id, { impl, plugin });
    },
    hasProvider: (id) => providers.has(id),
    removeProvider(id) {
      providers.delete(id);
      for (const [name, proxy] of egress.proxies) {
        if (proxy.provider !== id) continue;
        const state = states.get(name);
        state.agent?.close().catch(() => {});
        Object.assign(state, { endpoint: null, agent: null });
      }
    },

    // The loopback proxy for child processes, or null without rules or
    // before start().
    proxyUrl: () => listener?.url() ?? null,
    // The loopback proxy when `url`'s host has a rule that is not only
    // direct, for a child process that reads one URL (ffmpeg's -http_proxy).
    proxyFor(url) {
      const routes = routesFor(egress, url);
      return routes.length === 1 && routes[0] === DIRECT ? null : listener?.url() ?? null;
    },

    async start() {
      if (!enabled || listener) return;
      for (const [name, { provider }] of egress.proxies) {
        if (!providers.has(provider)) logger.warn({ proxy: name, provider }, "No plugin registered this egress proxy's provider");
      }
      listener = createEgressListener({ open, logger });
      await listener.start();
    },

    // For /internal/v1/health: each proxy's provider and state, never its endpoint.
    status() {
      if (!enabled && !egress.proxies.size) return null;
      return {
        rules: egress.rules.length,
        listener: Boolean(listener?.url()),
        proxies: Object.fromEntries([...egress.proxies].map(([name, { provider }]) => {
          const state = states.get(name);
          const status = !providers.has(provider) ? "no_provider" : state.endpoint ? "ready" : state.error ? "unavailable" : "idle";
          return [name, { provider, status, ...(state.error && status !== "ready" ? { error: state.error } : {}), ...(state.endpoint?.expiresAt ? { expiresAt: new Date(state.endpoint.expiresAt).toISOString() } : {}) }];
        })),
      };
    },

    async close() {
      await listener?.close();
      listener = null;
      await Promise.allSettled([...states.values()].map((state) => state.agent?.close()));
    },
  };
}
