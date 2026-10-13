import { errorBody, NODE_PROTOCOL, toYoloError, verifyOperatorRequest, YoloError } from "@useyolo/core";
import { presentLan, readLanState } from "./edge/lan.js";
import { presentWan, readWanState } from "./edge/wan.js";
import { remoteWanted } from "./store/media-settings.js";
import { countPasskeys } from "./store/users.js";

// Public, secret-free facts about this deployment, for `yolo doctor` and
// upgrades (Agent Note 2026-10-13-agent-deployment):
//
//   GET /.well-known/yolo   version, commit, internal protocol, and the D1
//                           migrations this code needs and the database has
//   GET /healthz, /health   { ok, version }: the Worker answers
//
// A request signed by the operator with NODE_SECRET (signOperatorRequest in
// @useyolo/core) also gets what only the owner should see: whether the Worker
// reaches the node through the tunnel, the node's version and protocol,
// whether an owner passkey exists, the bundled control plugins, and the
// media paths: the LAN and remote names' states and whether any user has
// the relay on (Agent Note 2026-10-13-media-off-the-worker). With
// `?address=1` it gets only `operator.address`, the address the request came
// from: the node asks this over IPv4 to learn the home's public address.

export const WELL_KNOWN_PATH = "/.well-known/yolo";
export const HEALTH_PATHS = Object.freeze(["/healthz", "/health"]);

const NO_STORE = { "cache-control": "no-store" };

// The newest migration D1 recorded (wrangler's d1_migrations table keeps the
// file name, ".sql" included), named like the build info, or null when the
// table does not exist yet.
async function appliedMigration(db) {
  try {
    const name = await db.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first("name");
    return name ? String(name).replace(/\.sql$/, "") : null;
  } catch {
    return null;
  }
}

async function probeNode(node) {
  try {
    const health = await node.get("/internal/v1/health", undefined, { timeoutMs: 8_000 });
    return { reachable: true, version: health?.version ?? null, protocol: health?.protocol ?? 0, error: null };
  } catch (error) {
    return { reachable: false, version: null, protocol: null, error: toYoloError(error).message };
  }
}

async function mediaState(env) {
  const [lan, wan, remote, relay] = await Promise.all([
    readLanState(env.OAUTH_KV), readWanState(env.OAUTH_KV), remoteWanted(env.DB),
    env.DB.prepare("SELECT 1 AS on_ FROM media_settings WHERE relay = 1 LIMIT 1").first("on_"),
  ]);
  const { status: lanStatus, error: lanError } = presentLan(lan, env);
  const { status: wanStatus, reason, error: wanError, origin } = presentWan(wan, env, { remote });
  return { relay: Boolean(relay), lan: { status: lanStatus, error: lanError }, remote: { status: wanStatus, origin, reason, error: wanError } };
}

export function health(build) {
  return Response.json({ ok: true, version: build.version }, { headers: NO_STORE });
}

// `build` is src/build-info.generated.js; `node` a node client
// (node-client.js); `plugins` the bundled control plugins' { name, version }.
export async function wellKnown(request, env, { build, node, plugins = [] }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json(errorBody(new YoloError("invalid_request", "Use GET")), { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const body = {
    name: "Yolo",
    version: build.version,
    commit: build.commit ?? null,
    protocol: NODE_PROTOCOL,
    migrations: { required: build.migrations?.required ?? null, applied: await appliedMigration(env.DB) },
  };
  if (await verifyOperatorRequest(env.NODE_SECRET, { path: WELL_KNOWN_PATH, headers: request.headers })) {
    if (new URL(request.url).searchParams.get("address") === "1") {
      body.operator = { address: request.headers.get("cf-connecting-ip") || null };
      return Response.json(body, { headers: NO_STORE });
    }
    const [nodeState, passkeys, media] = await Promise.all([probeNode(node), countPasskeys(env.DB).catch(() => null), mediaState(env).catch(() => null)]);
    body.operator = {
      node: nodeState,
      owner: { passkey: passkeys == null ? null : passkeys > 0 },
      plugins,
      media,
    };
  }
  return Response.json(body, { headers: NO_STORE });
}
