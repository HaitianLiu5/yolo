import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { envFilePath, loadPluginConfig, loadYoloEnv } from "@useyolo/plugin-api/host";
import { createAiSubtitles } from "./ai-subtitles.js";
import { createLocalApp, createNodeApp, NODE_VERSION } from "./app.js";
import { createBonjour } from "./bonjour.js";
import { createLan } from "./lan.js";
import { listenLocal, localSocketPath } from "./local.js";
import { createLogger, stampConsole } from "./log.js";
import { createCommentStore } from "./comments.js";
import { createEgress } from "./egress/egress.js";
import { createMediaPipeline } from "./media/pipeline.js";
import { createOwnerCodes } from "./owner-code.js";
import { createPluginManager, withSecretOptions } from "./plugin-manager.js";
import { loadPlugins } from "./plugins.js";
import { createWan } from "./wan.js";

// Yolo media node. Its internal API listens on loopback only; cloudflared +
// Workers VPC carry control plane requests to it
// (Agent Note 2026-10-07-node-internal-api). Two more listeners serve only
// media, over HTTPS, once the control plane has named them: on the private
// LAN address to devices at home (lan.js,
// Agent Note 2026-10-12-lan-direct-play), and through a router port to
// devices anywhere while the owner has remote access on (wan.js,
// Agent Note 2026-10-13-media-off-the-worker). Its source plugins read their
// settings from the repository .env.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
stampConsole();

// The repository .env, or the file YOLO_ENV_FILE names; an empty value
// loads none (tests).
const envFile = envFilePath({ root: ROOT });
loadYoloEnv({ root: ROOT });

// The programs this checkout pins (tools.json, linked by `npm install`) come
// first on PATH, for the node and every plugin's child processes
// (Agent Note 2026-10-25-pinned-node-tools).
const pinnedTools = resolve(ROOT, ".tools", "bin");
if (existsSync(pinnedTools)) process.env.PATH = [pinnedTools, process.env.PATH].filter(Boolean).join(delimiter);

if (!process.env.NODE_SECRET) {
  console.error([
    `NODE_SECRET is not set${envFile ? ` (read ${envFile})` : ""}.`,
    "It signs the control plane's requests and the media tokens, and must equal the Worker secret NODE_SECRET.",
    "Create one with `npm run yolo -- init --domain <your-domain>`, or put NODE_SECRET=<the output of `openssl rand -base64 32`> in .env.",
  ].join("\n"));
  process.exit(1);
}

const host = process.env.NODE_HOST || "127.0.0.1";
const port = Number(process.env.NODE_PORT || 9191);
const SHUTDOWN_TIMEOUT_MS = 5_000;
// Caches (.segment-cache, .hls-cache, .media-cache) live here; all are
// ignored by git.
const runtimeDir = resolve(process.env.YOLO_RUNTIME_DIR || ROOT);
const logger = createLogger();

// yolo.config.json if it exists, else the official list (plugins/official.json):
// built-in link playback only, until the owner chooses more
// (Agent Note 2026-10-31-home-cold-start).
const config = loadPluginConfig({ root: ROOT, env: process.env });
console.log(`Plugins from ${config.path}`);
// The owner's egress rules, which send chosen upstream requests through
// proxies that plugins provide (Agent Note 2026-10-13-node-egress-proxy).
const egress = createEgress({ config: config.egress, logger });
// The media pipeline, created below: a plugin turned off waits for its streams.
let media = null;
const plugins = await loadPlugins(withSecretOptions(config.plugins, runtimeDir), {
  env: process.env,
  cacheRoot: resolve(runtimeDir, ".media-cache", "plugins"),
  stateRoot: resolve(runtimeDir, ".yolo", "plugins"),
  egress,
  serving: (sourceIds) => media?.serving(sourceIds) ?? false,
});
await egress.start();
await plugins.start();
for (const plugin of plugins.status()) {
  const registered = [["sources", plugin.sources], ["agents", plugin.agents], ["transcribers", plugin.transcribers], ["translators", plugin.translators], ["proxy providers", plugin.proxyProviders]]
    .filter(([, ids]) => ids?.length).map(([kind, ids]) => `${kind}: ${ids.join(", ")}`);
  const detail = plugin.error ? `: ${plugin.error}` : registered.length ? ` (${registered.join("; ")})` : "";
  console.log(`  ${plugin.name} ${plugin.status}${detail}`);
}

// Timed comments (danmaku) per item, shared by media sessions and the internal API.
const comments = createCommentStore({ sources: plugins.sources });
// Subtitles made from an item's sound, when a transcriber plugin is loaded.
const aiSubtitles = createAiSubtitles({ speech: plugins.speech, logger, egress });
media = createMediaPipeline({ secret: process.env.NODE_SECRET, runtimeDir, logger, env: process.env, comments, aiSubtitles, egress });
media.init();

const lan = createLan({ runtimeDir, media, env: process.env, logger });
await lan.start();
const lanStatus = lan.status();
if (lanStatus.listening) console.log(`LAN media on ${lanStatus.origin} (${lanStatus.address})`);
const wan = createWan({ runtimeDir, media, secret: process.env.NODE_SECRET, env: process.env, logger });
await wan.start();
const wanStatus = wan.status();
if (wanStatus.listening) console.log(`Remote media on ${wanStatus.origin ?? wanStatus.name} (${wanStatus.addresses.join(", ")}; ${wanStatus.mapping.method ?? wanStatus.mapping.error ?? "no port mapping"})`);

// The control plane's address on the home network, for TV apps to pair with.
const bonjour = createBonjour({ origin: () => process.env.PUBLIC_ORIGIN || lan.pageOrigin() || wan.pageOrigin(), logger });
bonjour.start();

// A plugin that cannot load in place waits for a restart, which the node
// does itself once no stream plays when a service manager starts it again:
// the service `npm run yolo -- service` installs sets YOLO_SERVICE, and one
// installed before it did is known by launchd's label or systemd's id.
const underServiceManager = process.env.YOLO_SERVICE === "1" || Boolean(process.env.XPC_SERVICE_NAME?.startsWith("app.useyolo.") || process.env.INVOCATION_ID);
const RESTART_CHECK_MS = 10_000;
function restartWhenIdle() {
  if (!underServiceManager) return false;
  const check = setInterval(() => {
    if (media.status().sessions > 0) return;
    clearInterval(check);
    console.log("Restarting to apply a plugin change");
    void stop("restart");
  }, RESTART_CHECK_MS);
  return true;
}
const pluginManager = createPluginManager({ root: ROOT, env: process.env, runtimeDir, plugins, config, restart: restartWhenIdle, logger });

const ownerCodes = createOwnerCodes();
const app = createNodeApp({
  secret: process.env.NODE_SECRET, plugins, media, lan, wan, ownerCodes, comments, logger, pluginManager,
  metadataCacheDir: resolve(runtimeDir, ".media-cache", "metadata"),
  metadataLanguage: process.env.YOLO_METADATA_LANGUAGE || "en",
});

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`Yolo node ${NODE_VERSION} listening on http://${host}:${info.port}`);
  process.send?.({ type: "yolo-node-listening", port: info.port });
});

// Owner pairing codes are issued only on this socket (see local.js).
const socketPath = localSocketPath();
listenLocal(createLocalApp({ secret: process.env.NODE_SECRET, ownerCodes, pluginManager }), socketPath).then(
  () => console.log(`Owner commands (npm run owner-code) on ${socketPath}`),
  (error) => console.error(`Owner commands are unavailable: ${error.message}`),
);

// Give plugins a bounded chance to release what they started (launchd sends
// SIGTERM on stop and restart), and the router its port mapping back, then
// exit.
let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping media sessions and plugins`);
  const timeout = new Promise((resolveTimeout) => setTimeout(resolveTimeout, SHUTDOWN_TIMEOUT_MS).unref());
  bonjour.close();
  await Promise.race([Promise.allSettled([lan.close(), wan.close(), media.close(), plugins.shutdown().then(() => egress.close())]), timeout]);
  process.exit(0);
}
process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));
