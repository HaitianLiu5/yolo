import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";
import { pluginDirectory } from "@useyolo/plugin-api/host";
import { checkAgentImpl, createAgentRegistry } from "./agents.js";
import { checkProxyProviderImpl, createEgress } from "./egress/egress.js";
import { checkMetadataImpl, createMetadataRegistry } from "./metadata.js";
import { checkModelProviderImpl, createModelRegistry, DEFAULT_CALLS_PER_DAY } from "./models.js";
import { createResolve } from "./plugin-hooks.js";
import { checkSourceImpl, createSourceRegistry } from "./sources.js";
import { checkTranscriberImpl, checkTranslatorImpl, createSpeechRegistry } from "./speech.js";

// Loads node plugins (Agent Note 2026-10-11-source-plugin-api), modelled on
// pi's extensions:
//
// 1. Import each enabled plugin's node entry in config order and call its
//    default export, the factory, with a `yolo` API. The factory registers
//    sources, agents (agents.js), transcribers and translators (speech.js),
//    proxy providers (egress/egress.js), model providers (models.js),
//    metadata (metadata.js), and event handlers. A factory that throws, or a
//    plugin that cannot be imported, is marked failed: nothing it registered
//    is kept, and the node carries on with the other plugins.
// 2. start(): run "start" handlers in load order. Long-lived resources
//    (processes, sockets, timers) start here, never in the factory. A handler
//    that throws or hangs fails its plugin, removes what it registered, and runs its
//    "shutdown" handlers to release whatever it had started.
// 3. shutdown(): run "shutdown" handlers in load order, once. Handlers must
//    be idempotent; errors are logged and the rest still run.
// 4. apply(entries): a changed config applied in place
//    (Agent Note 2026-10-31-home-cold-start). A plugin turned on loads and
//    starts; one turned off leaves the registries at once, so it takes no new
//    prepare(), and its shutdown handlers run once no stream of its sources
//    plays, or after DRAIN_MS; changed options are an unload and a load, the
//    factory called again on the module already imported. Claim order stays
//    config order.
//
// Plugins are trusted code running in this process with its permissions, as
// in pi: there is no permission system, so review a plugin before adding it.

const EVENTS = Object.freeze(["start", "shutdown"]);
const LEVELS = Object.freeze(["debug", "info", "warn", "error"]);
// Packages the host provides to plugins, which list them as peerDependencies.
const PROVIDED_PACKAGES = Object.freeze(["@useyolo/plugin-api"]);
const START_TIMEOUT_MS = 30_000;
// A plugin turned off keeps what it started while streams of its sources
// play, for at most this long.
const DRAIN_MS = 4 * 60 * 60_000;
const DRAIN_CHECK_MS = 30_000;

let hooksRegistered = false;

// Plugins import the host's copy of each provided package wherever they are
// installed, so they share one YoloError class with the node (plugin-hooks.js).
// module.registerHooks() runs in this thread (Node 22.15+); older Node 22
// releases fall back to module.register(), which Node 26 deprecates.
export function provideHostPackages() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const provided = Object.fromEntries(PROVIDED_PACKAGES.map((name) => [name, import.meta.resolve(name)]));
  if (typeof nodeModule.registerHooks === "function") {
    nodeModule.registerHooks({ resolve: createResolve(provided) });
  } else {
    nodeModule.register(new URL("./plugin-hooks.js", import.meta.url), { data: { provided } });
  }
}

function pluginLogger(name, sink) {
  const prefix = `[${name}]`;
  return Object.freeze(Object.fromEntries(LEVELS.map((level) => [level, (...args) => sink[level](prefix, ...args)])));
}

function frozenCopy(value) {
  const freeze = (node) => {
    if (node && typeof node === "object") {
      Object.values(node).forEach(freeze);
      Object.freeze(node);
    }
    return node;
  };
  return freeze(structuredClone(value ?? {}));
}

const message = (error) => error?.message || String(error);

// The timer stays referenced: the node awaits start() before it listens, so
// while a hung handler holds nothing open, this timer is what keeps the
// process alive until the plugin is failed. It is cleared once the race settles.
// A plugin's identity across configs: its package directory, else its name.
const keyOf = (entry) => entry.root ?? entry.node ?? entry.name;

// Whether a config entry would load the same plugin the same way.
function sameEntry(left, right) {
  return left.enabled !== false === (right.enabled !== false)
    && left.node === right.node
    && left.factory === right.factory
    && (left.error ?? null) === (right.error ?? null)
    && JSON.stringify(left.options ?? {}) === JSON.stringify(right.options ?? {});
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// `entries` come from loadPluginConfig() in @useyolo/plugin-api/host:
// { name, version, source, enabled, options, node, error }. Tests may pass a
// `factory` instead of a `node` path.
export async function loadPlugins(entries, {
  env = process.env,
  logger = console,
  importEntry = (path) => import(pathToFileURL(path).href),
  startTimeoutMs = START_TIMEOUT_MS,
  // Each plugin gets `yolo.cacheDir`, a directory of its own under this one
  // (an ignored runtime path), for caches it may delete at any time.
  cacheRoot = null,
  // And `yolo.stateDir` under this one, for state Yolo never deletes.
  stateRoot = null,
  // The node's egress layer: plugins register proxy providers with it and
  // fetch through it (Agent Note 2026-10-13-node-egress-proxy).
  egress = createEgress(),
  // Whether a stream of any of these source ids plays now, which holds a
  // plugin turned off until it ends (the media pipeline's serving()).
  serving = () => false,
  drainMs = DRAIN_MS,
  drainCheckMs = DRAIN_CHECK_MS,
} = {}) {
  const registry = createSourceRegistry();
  const agentRegistry = createAgentRegistry();
  const speechRegistry = createSpeechRegistry();
  const callsPerDay = Number(env.MODEL_CALLS_PER_DAY);
  const modelRegistry = createModelRegistry({
    logger,
    callsPerDay: Number.isInteger(callsPerDay) && callsPerDay >= 0 ? callsPerDay : DEFAULT_CALLS_PER_DAY,
  });
  const metadataRegistry = createMetadataRegistry();
  const directory = (root, name) => (root ? pluginDirectory(root, name) : null);
  let plugins = [];
  // Plugins turned off whose streams still play, and the timers that wait.
  const draining = new Set();
  const wakers = new Set();
  let closing = false;

  // A config entry → its plugin record, loaded (its factory run) unless it
  // is off or failed. Null for a plugin with only a control entry, which has
  // nothing to do on the node.
  async function load(entry) {
    if (entry.enabled !== false && !entry.error && !entry.factory && !entry.node) return null;
    const plugin = {
      key: keyOf(entry),
      entry,
      name: entry.name,
      version: entry.version ?? null,
      source: entry.source ?? entry.name,
      status: "disabled",
      error: null,
      sources: [],
      agents: [],
      speech: [],
      proxyProviders: [],
      modelProviders: [],
      metadata: [],
      handlers: { start: [], shutdown: [] },
      log: pluginLogger(entry.name, logger),
    };
    if (entry.enabled === false) return plugin;

    const pending = [];
    const pendingAgents = [];
    const pendingSpeech = [];
    const pendingProviders = [];
    const pendingModels = [];
    const pendingMetadata = [];
    const registerSpeech = (kind, check) => (id, impl) => {
      if (!loading) throw new Error(`${plugin.name}: register a ${kind} while the plugin factory runs`);
      const unknown = check(id, impl);
      if (speechRegistry.has(kind, id) || pendingSpeech.some((entry) => entry.kind === kind && entry.id === id)) throw new Error(`The ${kind} id "${id}" is already registered`);
      if (unknown.length) plugin.log.warn(`${kind} ${id}: ignoring unknown ${unknown.join(", ")}`);
      pendingSpeech.push({ kind, id, impl });
    };
    const handlers = { start: [], shutdown: [] };
    let loading = true;
    const yolo = Object.freeze({
      plugin: Object.freeze({ name: plugin.name, version: plugin.version }),
      options: frozenCopy(entry.options),
      env: Object.freeze({ ...env }),
      log: plugin.log,
      // fetch() by the owner's egress rules, and the loopback proxy a child
      // process that makes its own requests is given, or null.
      fetch: (input, init) => egress.fetch(input, init),
      egressProxy: () => egress.proxyUrl(),
      cacheDir: directory(cacheRoot, plugin.name),
      stateDir: directory(stateRoot, plugin.name),
      models: modelRegistry.forPlugin(plugin.name),
      registerSource(id, impl) {
        if (!loading) throw new Error(`${plugin.name}: register sources while the plugin factory runs`);
        const unknown = checkSourceImpl(id, impl);
        if (registry.has(id) || pending.some((source) => source.id === id)) throw new Error(`Source id "${id}" is already registered`);
        if (unknown.length) plugin.log.warn(`source ${id}: ignoring unknown ${unknown.join(", ")}`);
        pending.push({ id, impl });
      },
      registerAgent(id, impl) {
        if (!loading) throw new Error(`${plugin.name}: register agents while the plugin factory runs`);
        const unknown = checkAgentImpl(id, impl);
        if (agentRegistry.has(id) || pendingAgents.some((agent) => agent.id === id)) throw new Error(`Agent id "${id}" is already registered`);
        if (unknown.length) plugin.log.warn(`agent ${id}: ignoring unknown ${unknown.join(", ")}`);
        pendingAgents.push({ id, impl });
      },
      registerProxyProvider(id, impl) {
        if (!loading) throw new Error(`${plugin.name}: register proxy providers while the plugin factory runs`);
        const unknown = checkProxyProviderImpl(id, impl);
        if (egress.hasProvider(id) || pendingProviders.some((provider) => provider.id === id)) throw new Error(`The proxy provider id "${id}" is already registered`);
        if (unknown.length) plugin.log.warn(`proxy provider ${id}: ignoring unknown ${unknown.join(", ")}`);
        pendingProviders.push({ id, impl });
      },
      registerTranscriber: registerSpeech("transcriber", checkTranscriberImpl),
      registerTranslator: registerSpeech("translator", checkTranslatorImpl),
      registerModelProvider(id, impl) {
        if (!loading) throw new Error(`${plugin.name}: register model providers while the plugin factory runs`);
        const unknown = checkModelProviderImpl(id, impl);
        if (modelRegistry.has(id) || pendingModels.some((entry) => entry.id === id)) throw new Error(`Model provider id "${id}" is already registered`);
        if (unknown.length) plugin.log.warn(`model provider ${id}: ignoring unknown ${unknown.join(", ")}`);
        pendingModels.push({ id, impl });
      },
      registerMetadata(id, impl) {
        if (!loading) throw new Error(`${plugin.name}: register metadata while the plugin factory runs`);
        const unknown = checkMetadataImpl(id, impl);
        if (metadataRegistry.has(id) || pendingMetadata.some((entry) => entry.id === id)) throw new Error(`Metadata id "${id}" is already registered`);
        if (unknown.length) plugin.log.warn(`metadata ${id}: ignoring unknown ${unknown.join(", ")}`);
        pendingMetadata.push({ id, impl });
      },
      on(event, handler) {
        if (!EVENTS.includes(event)) throw new Error(`Unknown event "${event}"; plugins can handle ${EVENTS.join(" and ")}`);
        if (typeof handler !== "function") throw new TypeError(`The ${event} handler must be a function`);
        handlers[event].push(handler);
        return () => {
          const index = handlers[event].indexOf(handler);
          if (index >= 0) handlers[event].splice(index, 1);
        };
      },
    });

    try {
      if (entry.error) throw new Error(entry.error);
      let factory = entry.factory;
      if (!factory) {
        provideHostPackages();
        factory = (await importEntry(entry.node)).default;
      }
      if (typeof factory !== "function") throw new Error("the node entry's default export is not a function");
      await factory(yolo);
      for (const { id, impl } of pending) registry.add(id, impl, plugin.name);
      plugin.sources = pending.map(({ id }) => id);
      for (const { id, impl } of pendingAgents) agentRegistry.add(id, impl, plugin.name);
      plugin.agents = pendingAgents.map(({ id }) => id);
      for (const { kind, id, impl } of pendingSpeech) speechRegistry.add(kind, id, impl, plugin.name);
      plugin.speech = pendingSpeech.map(({ kind, id }) => ({ kind, id }));
      for (const { id, impl } of pendingProviders) egress.registerProvider(id, impl, plugin.name);
      plugin.proxyProviders = pendingProviders.map(({ id }) => id);
      for (const { id, impl } of pendingModels) modelRegistry.add(id, impl, plugin.name);
      plugin.modelProviders = pendingModels.map(({ id }) => id);
      for (const { id, impl } of pendingMetadata) metadataRegistry.add(id, impl, plugin.name);
      plugin.metadata = pendingMetadata.map(({ id }) => id);
      plugin.handlers = handlers;
      plugin.status = "loaded";
    } catch (error) {
      plugin.status = "failed";
      plugin.error = message(error);
      plugin.log.error(`failed to load: ${plugin.error}`);
    } finally {
      loading = false;
    }
    return plugin;
  }

  // Whatever the plugin registered leaves the registries.
  function unregister(plugin) {
    for (const id of plugin.sources) registry.remove(id);
    plugin.sources = [];
    for (const id of plugin.agents) agentRegistry.remove(id);
    plugin.agents = [];
    for (const { kind, id } of plugin.speech) speechRegistry.remove(kind, id);
    plugin.speech = [];
    for (const id of plugin.proxyProviders) egress.removeProvider(id);
    plugin.proxyProviders = [];
    for (const id of plugin.modelProviders) modelRegistry.remove(id);
    plugin.modelProviders = [];
    for (const id of plugin.metadata) metadataRegistry.remove(id);
    plugin.metadata = [];
  }

  async function startPlugin(plugin) {
    if (plugin.status !== "loaded") return;
    try {
      for (const handler of [...plugin.handlers.start]) {
        await withTimeout(Promise.resolve().then(handler), startTimeoutMs, "The start handler");
      }
      plugin.status = "started";
    } catch (error) {
      plugin.status = "failed";
      plugin.error = `start failed: ${message(error)}`;
      plugin.log.error(plugin.error);
      unregister(plugin);
      await shutdownPlugin(plugin);
    }
  }

  // A plugin turned off: out of the registries now, its shutdown handlers
  // once its streams end (or after drainMs).
  function drain(plugin) {
    const active = plugin.status === "started" || plugin.status === "loaded";
    const served = [...plugin.sources];
    unregister(plugin);
    if (!active) {
      plugin.status = "stopped";
      return;
    }
    plugin.status = "stopping";
    const done = (async () => {
      const until = Date.now() + drainMs;
      while (!closing && served.length && serving(served) && Date.now() < until) {
        await new Promise((resolveWait) => {
          const wake = () => {
            wakers.delete(wake);
            clearTimeout(timer);
            resolveWait();
          };
          const timer = setTimeout(wake, drainCheckMs);
          timer.unref?.();
          wakers.add(wake);
        });
      }
      await shutdownPlugin(plugin);
      plugin.status = "stopped";
    })();
    draining.add(done);
    void done.finally(() => draining.delete(done));
  }

  // Claim order is config order (sources.js): registries follow the plugins'.
  function reorder() {
    const rank = new Map(plugins.map((plugin, index) => [plugin.name, index]));
    const of = (name) => rank.get(name) ?? Number.MAX_SAFE_INTEGER;
    registry.reorder(of);
    agentRegistry.reorder(of);
    metadataRegistry.reorder(of);
  }

  for (const entry of entries) {
    const plugin = await load(entry);
    if (plugin) plugins.push(plugin);
  }

  async function shutdownPlugin(plugin) {
    for (const handler of [...plugin.handlers.shutdown]) {
      try {
        await handler();
      } catch (error) {
        plugin.log.error(`shutdown handler failed: ${message(error)}`);
      }
    }
  }

  let starting = null;
  let stopping = null;
  let applying = Promise.resolve();

  return {
    sources: registry,
    agents: agentRegistry,
    speech: speechRegistry,
    models: modelRegistry,
    metadata: metadataRegistry,

    egress,

    // The config entries of the plugins as they run now.
    entries: () => plugins.map((plugin) => plugin.entry),

    status: () => plugins.map(({ entry, name, version, source, status, error, sources, agents, speech, proxyProviders, modelProviders, metadata }) => {
      const transcribers = speech.filter(({ kind }) => kind === "transcriber").map(({ id }) => id);
      const translators = speech.filter(({ kind }) => kind === "translator").map(({ id }) => id);
      return {
        name,
        version,
        source,
        ...(entry.root ? { root: entry.root } : {}),
        status,
        sources: [...sources],
        ...(agents.length ? { agents: [...agents] } : {}),
        ...(transcribers.length ? { transcribers } : {}),
        ...(translators.length ? { translators } : {}),
        ...(proxyProviders.length ? { proxyProviders: [...proxyProviders] } : {}),
        ...(modelProviders.length ? { modelProviders: [...modelProviders] } : {}),
        ...(metadata.length ? { metadata: [...metadata] } : {}),
        ...(error ? { error } : {}),
      };
    }),

    start() {
      starting ??= (async () => {
        for (const plugin of plugins) await startPlugin(plugin);
      })();
      return starting;
    },

    // The plugins of a changed config, applied in place: unchanged ones keep
    // running, and the others load, start, or drain. Changes run one at a
    // time.
    apply(next) {
      applying = applying.then(async () => {
        await starting;
        const current = new Map(plugins.map((plugin) => [plugin.key, plugin]));
        const kept = new Set();
        const result = [];
        for (const entry of next) {
          const old = current.get(keyOf(entry));
          if (old && sameEntry(old.entry, entry) && old.status !== "stopping" && old.status !== "stopped") {
            kept.add(old);
            result.push(old);
            continue;
          }
          if (old) drain(old);
          const plugin = await load(entry);
          if (!plugin) continue;
          await startPlugin(plugin);
          result.push(plugin);
        }
        for (const plugin of plugins) if (!kept.has(plugin) && plugin.status !== "stopping" && plugin.status !== "stopped") drain(plugin);
        plugins = result;
        reorder();
      });
      return applying;
    },

    shutdown() {
      stopping ??= (async () => {
        await starting;
        await applying;
        // Plugins still draining stop now too.
        closing = true;
        for (const wake of [...wakers]) wake();
        await Promise.allSettled([...draining]);
        for (const plugin of plugins) {
          if (plugin.status !== "started" && plugin.status !== "loaded") continue;
          await shutdownPlugin(plugin);
          plugin.status = "stopped";
        }
      })();
      return stopping;
    },
  };
}
