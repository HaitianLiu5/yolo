import { spawn as spawnProcess } from "node:child_process";
import { originOf } from "./edge.js";
import { silentLogger } from "./log.js";

// The node's Bonjour advertisement (Agent Note 2026-10-19-client-protocol):
// `_yolo._tcp` on the home network with one TXT key, `origin`, the control
// plane's origin, so a TV app at home finds the address to pair with without
// typing. The client checks it with /.well-known/yolo and asks the owner to
// confirm the host before pairing, since anyone on the network can advertise.
//
// The operating system's own responder publishes it: `dns-sd` on macOS,
// `avahi-publish` on Linux; elsewhere, or when the command is missing, the
// node advertises nothing and clients take a typed address. BONJOUR=0 turns
// it off. Every 60 seconds the node checks the origin and republishes when it
// changed or the command exited.

export const BONJOUR_TYPE = "_yolo._tcp";
export const BONJOUR_CHECK_MS = 60_000;

/** The command that publishes `origin` on this platform, or null. */
export function bonjourCommand(origin, platform = process.platform) {
  const url = new URL(origin);
  const port = url.port || "443";
  const txt = `origin=${url.origin}`;
  if (platform === "darwin") return ["dns-sd", ["-R", url.hostname, BONJOUR_TYPE, "local", port, txt]];
  if (platform === "linux") return ["avahi-publish", ["-s", url.hostname, BONJOUR_TYPE, port, txt]];
  return null;
}

/**
 * @param {object} options
 * @param {() => string|null} options.origin  the control plane's origin, when known
 */
export function createBonjour({
  origin,
  env = process.env,
  platform = process.platform,
  spawn = spawnProcess,
  logger = silentLogger,
  intervalMs = BONJOUR_CHECK_MS,
}) {
  const enabled = env.BONJOUR !== "0";
  let child = null;
  let published = null;
  let watcher = null;
  // The command is not installed: no point trying again every minute.
  let missing = false;

  function stop() {
    const running = child;
    child = null;
    published = null;
    running?.kill();
  }

  function sync() {
    const wanted = enabled ? originOf(origin() ?? "") : null;
    if (wanted === published && child) return;
    stop();
    const command = wanted && !missing ? bonjourCommand(wanted, platform) : null;
    if (!command) return;
    const [file, args] = command;
    const started = spawn(file, args, { stdio: "ignore" });
    child = started;
    published = wanted;
    started.on("error", (failure) => {
      if (failure.code === "ENOENT") missing = true;
      logger.warn({ kind: "bonjour", err: failure.message }, `Bonjour advertisement is unavailable: ${file} did not start`);
      if (child === started) stop();
    });
    started.on("exit", (code) => {
      if (child !== started) return;
      logger.warn({ kind: "bonjour", code }, `Bonjour advertisement stopped: ${file} exited`);
      child = null;
      published = null;
    });
    logger.info({ kind: "bonjour", origin: wanted }, `Advertising ${BONJOUR_TYPE} for ${wanted}`);
  }

  return {
    start() {
      sync();
      watcher ??= setInterval(sync, intervalMs);
      watcher.unref?.();
    },
    close() {
      clearInterval(watcher);
      watcher = null;
      stop();
    },
    sync,
    published: () => published,
  };
}
