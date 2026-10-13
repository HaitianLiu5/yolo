import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { loadPluginConfig } from "@useyolo/plugin-api/host";
import { createLocalApp, createNodeApp, NODE_VERSION } from "./app.js";
import { createLan } from "./lan.js";
import { listenLocal, localSocketPath } from "./local.js";
import { createLogger, stampConsole } from "./log.js";
import { createMediaPipeline } from "./media/pipeline.js";
import { createOwnerCodes } from "./owner-code.js";
import { loadPlugins } from "./plugins.js";

// Yolo media node. Its internal API listens on loopback only; cloudflared +
// Workers VPC carry control plane requests to it
// (Agent Note 2026-10-07-node-internal-api). A second listener, HTTPS on the
// private LAN address, serves only media to devices at home once the control
// plane has configured it (lan.js, Agent Note 2026-10-12-lan-direct-play). Its
// source plugins read their settings from the repository .env.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
stampConsole();

// DRIVEIN_ENV_FILE picks another file; an empty value loads none (tests).
const envFile = process.env.DRIVEIN_ENV_FILE ?? `${ROOT}.env`;
if (envFile) {
  try {
    loadEnvFile(envFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const host = process.env.NODE_HOST || "127.0.0.1";
const port = Number(process.env.NODE_PORT || 9191);
const SHUTDOWN_TIMEOUT_MS = 5_000;
// Caches (.segment-cache, .hls-cache, .media-cache) live here; all are
// ignored by git.
const runtimeDir = resolve(process.env.YOLO_RUNTIME_DIR || process.env.DRIVEIN_RUNTIME_DIR || ROOT);
const logger = createLogger();

// yolo.config.json if it exists, else the official plugins (plugins/official.json).
const config = loadPluginConfig({ root: ROOT, env: process.env });
console.log(`Plugins from ${config.path}`);
const plugins = await loadPlugins(config.plugins, { env: process.env, cacheRoot: resolve(runtimeDir, ".media-cache", "plugins") });
await plugins.start();
for (const plugin of plugins.status()) {
  const detail = plugin.error ? `: ${plugin.error}` : plugin.sources.length ? ` (sources: ${plugin.sources.join(", ")})` : "";
  console.log(`  ${plugin.name} ${plugin.status}${detail}`);
}

const media = createMediaPipeline({ secret: process.env.NODE_SECRET, runtimeDir, logger, env: process.env });
media.init();

const lan = createLan({ runtimeDir, media, env: process.env, logger });
await lan.start();
const lanStatus = lan.status();
if (lanStatus.listening) console.log(`LAN media on ${lanStatus.origin} (${lanStatus.address})`);

const ownerCodes = createOwnerCodes();
const app = createNodeApp({ secret: process.env.NODE_SECRET, plugins, media, lan, ownerCodes });

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`Yolo node ${NODE_VERSION} listening on http://${host}:${info.port}`);
  process.send?.({ type: "yolo-node-listening", port: info.port });
});

// Owner pairing codes are issued only on this socket (see local.js).
const socketPath = localSocketPath();
listenLocal(createLocalApp({ secret: process.env.NODE_SECRET, ownerCodes }), socketPath).then(
  () => console.log(`Owner commands (npm run owner-code) on ${socketPath}`),
  (error) => console.error(`Owner commands are unavailable: ${error.message}`),
);

// Give plugins a bounded chance to release what they started (launchd sends
// SIGTERM on stop and restart), then exit.
let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping media sessions and plugins`);
  const timeout = new Promise((resolveTimeout) => setTimeout(resolveTimeout, SHUTDOWN_TIMEOUT_MS).unref());
  await Promise.race([Promise.allSettled([lan.close(), media.close(), plugins.shutdown()]), timeout]);
  process.exit(0);
}
process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));
