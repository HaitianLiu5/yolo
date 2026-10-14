import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { envFilePath, loadPluginConfig, loadYoloEnv } from "@useyolo/plugin-api/host";
import { createLocalApp, createNodeApp, NODE_VERSION } from "./app.js";
import { createLan } from "./lan.js";
import { listenLocal, localSocketPath } from "./local.js";
import { createLogger, stampConsole } from "./log.js";
import { createCommentStore } from "./comments.js";
import { createMediaPipeline } from "./media/pipeline.js";
import { createOwnerCodes } from "./owner-code.js";
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

// yolo.config.json if it exists, else the official plugins (plugins/official.json).
const config = loadPluginConfig({ root: ROOT, env: process.env });
console.log(`Plugins from ${config.path}`);
const plugins = await loadPlugins(config.plugins, { env: process.env, cacheRoot: resolve(runtimeDir, ".media-cache", "plugins") });
await plugins.start();
for (const plugin of plugins.status()) {
  const detail = plugin.error ? `: ${plugin.error}` : plugin.sources.length ? ` (sources: ${plugin.sources.join(", ")})` : "";
  console.log(`  ${plugin.name} ${plugin.status}${detail}`);
}

// Timed comments (danmaku) per item, shared by media sessions and the internal API.
const comments = createCommentStore({ sources: plugins.sources });
const media = createMediaPipeline({ secret: process.env.NODE_SECRET, runtimeDir, logger, env: process.env, comments });
media.init();

const lan = createLan({ runtimeDir, media, env: process.env, logger });
await lan.start();
const lanStatus = lan.status();
if (lanStatus.listening) console.log(`LAN media on ${lanStatus.origin} (${lanStatus.address})`);
const wan = createWan({ runtimeDir, media, secret: process.env.NODE_SECRET, env: process.env, logger });
await wan.start();
const wanStatus = wan.status();
if (wanStatus.listening) console.log(`Remote media on ${wanStatus.origin ?? wanStatus.name} (${wanStatus.addresses.join(", ")}; ${wanStatus.mapping.method ?? wanStatus.mapping.error ?? "no port mapping"})`);

const ownerCodes = createOwnerCodes();
const app = createNodeApp({ secret: process.env.NODE_SECRET, plugins, media, lan, wan, ownerCodes, comments });

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
// SIGTERM on stop and restart), and the router its port mapping back, then
// exit.
let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping media sessions and plugins`);
  const timeout = new Promise((resolveTimeout) => setTimeout(resolveTimeout, SHUTDOWN_TIMEOUT_MS).unref());
  await Promise.race([Promise.allSettled([lan.close(), wan.close(), media.close(), plugins.shutdown()]), timeout]);
  process.exit(0);
}
process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));
