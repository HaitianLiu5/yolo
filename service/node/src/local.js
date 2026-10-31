import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { signNodeRequest } from "@useyolo/core";

// Owner commands on the home machine (`npm run owner-code`) reach the node
// over a Unix socket instead of TCP. cloudflared and the Workers VPC service
// carry control plane requests to the TCP listener on NODE_PORT only, and the
// control plane signs every request it sends there, including public /m/*
// paths it forwards. A signature therefore cannot tell the owner from the
// control plane; a route that exists only on this socket can, because nothing
// from Cloudflare can open a Unix socket. A second loopback port would rely on
// the tunnel never being pointed at it. The socket file is mode 0600, and
// requests on it must still be signed with NODE_SECRET.

export const DEFAULT_LOCAL_SOCKET = fileURLToPath(new URL("../../../.yolo-node.sock", import.meta.url));

// macOS allows 104 bytes for a socket path (Linux 108), including the NUL.
const MAX_SOCKET_PATH_BYTES = 103;

const uid = () => (typeof process.getuid === "function" ? process.getuid() : "user");

// NODE_LOCAL_SOCKET, else .yolo-node.sock in the repository. A checkout whose
// path makes that too long for a socket uses /tmp/yolo-<uid>/<hash>.sock
// instead: short, private to the user, and derived from the checkout, so the
// node and `npm run owner-code` from the same checkout agree on it.
export function localSocketPath(env = process.env, defaultPath = DEFAULT_LOCAL_SOCKET) {
  if (env.NODE_LOCAL_SOCKET) return env.NODE_LOCAL_SOCKET;
  if (Buffer.byteLength(defaultPath) <= MAX_SOCKET_PATH_BYTES) return defaultPath;
  return join("/tmp", `yolo-${uid()}`, `${createHash("sha256").update(defaultPath).digest("hex").slice(0, 16)}.sock`);
}

export function socketPathFits(path) {
  return Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES;
}

function isLive(path) {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

// Remove a socket file a crashed node left behind, but never one a running
// node still answers on, and never a file that is not a socket.
async function removeStaleSocket(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stats.isSocket()) throw new Error(`${path} exists and is not a socket`);
  if (await isLive(path)) throw new Error(`Another Yolo node already listens on ${path}`);
  unlinkSync(path);
}

// The fallback directory must belong to this user and be closed to others.
function ensurePrivateDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  if (!stats.isDirectory() || stats.uid !== uid() || (stats.mode & 0o077) !== 0) {
    throw new Error(`${dir} must be a directory only you can open (mode 700); remove it or set NODE_LOCAL_SOCKET`);
  }
}

export async function listenLocal(app, path) {
  if (!socketPathFits(path)) {
    throw new Error(`Socket path ${path} is longer than ${MAX_SOCKET_PATH_BYTES} bytes; set NODE_LOCAL_SOCKET to a shorter path`);
  }
  if (path.startsWith(`/tmp/yolo-${uid()}/`)) ensurePrivateDirectory(dirname(path));
  await removeStaleSocket(path);
  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  return server;
}

// Signed request over the local socket; resolves to { status, body }.
export async function requestLocal(path, { socketPath, secret, method = "POST", body = {}, timeoutMs = 5000 }) {
  // A GET carries no body, as the node's signature check expects.
  const payload = method === "GET" || method === "HEAD" ? "" : JSON.stringify(body);
  const signature = await signNodeRequest(secret, { method, path, body: payload });
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      path,
      method,
      timeout: timeoutMs,
      headers: { ...signature, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          // Leave body null; callers report the status.
        }
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("The node did not answer"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(payload);
  });
}
