import { Hono } from "hono";
import { errorBody, toYoloError, YoloError } from "@useyolo/core";
import { createSession, destroySession, getSession, revokeAllSessions } from "../auth/session.js";
import { maintainLan, presentLan, readLanState } from "../edge/lan.js";
import { RELAY_WARNING } from "../edge/paths.js";
import { maintainWan, presentWan, readWanState } from "../edge/wan.js";
import { forgetRelay, readMediaSettings, remoteWanted, writeMediaSettings } from "../store/media-settings.js";
import { decideDeviceCode, normalizeUserCode } from "../store/pairing.js";
import { deletePasskey, listPasskeys } from "../store/users.js";

// Owner routes under /v1/owner (Agent Note 2026-10-07-v1-http-api): what the
// signed-in owner manages from Yolo's own settings — devices, connected
// agents, passkeys, the owner session, approving this browser's own
// pairing code, and the media paths: LAN direct play's status, remote
// access, and the relay. They authenticate with the owner's passkey session cookie
// (auth/session.js) and nothing else: a bearer token, a device credential
// included, never reaches them.
//
// Cross-site requests are refused three ways on top of the SameSite=Lax
// session cookie: every request carries the X-Yolo-Owner header (a custom
// header a cross-origin page cannot send without a CORS preflight, which
// these routes never answer), Sec-Fetch-Site must be same-origin when the
// browser sends it, and a request that changes something must carry an
// Origin header equal to Yolo's own.

export const OWNER_HEADER = "x-yolo-owner";
const READ_METHODS = new Set(["GET", "HEAD"]);
const MAX_GRANTS = 500;

const hostOf = (value) => {
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
};

// Grant timestamps are Unix seconds; Yolo's resources use milliseconds.
const millis = (value) => (Number(value) > 0 && Number(value) < 1e12 ? Number(value) * 1000 : Number(value) || null);

async function jsonBody(c) {
  if (!(c.req.header("content-type") || "").includes("application/json")) return {};
  try {
    const value = await c.req.json();
    return value && typeof value === "object" ? value : {};
  } catch {
    throw new YoloError("invalid_request", "Request body must be JSON");
  }
}

/**
 * @param {object} options
 * @param {(env: object, userId: string) => object} options.servicesFor  the service layer for a user
 * @param {(env: object, request: Request) => object} options.oauthFor  workers-oauth-provider's
 *   helpers (listUserGrants, revokeGrant, lookupClient)
 * @param {(env: object) => Promise<object>} [options.checkLan]  runs LAN maintenance now (edge/lan.js)
 * @param {(env: object) => Promise<object>} [options.checkWan]  runs remote maintenance now (edge/wan.js)
 */
export function createOwnerApp({ servicesFor, oauthFor, checkLan = (env) => maintainLan(env), checkWan = (env) => maintainWan(env), log = (record) => console.log(record) }) {
  const app = new Hono().basePath("/v1/owner");
  const publicOrigin = (c) => new URL(c.env.PUBLIC_ORIGIN || c.req.url).origin;

  app.onError((error, c) => {
    const yolo = toYoloError(error);
    if (yolo.code === "internal") console.error("owner request failed", error);
    return c.json(errorBody(yolo), yolo.status, { "cache-control": "no-store" });
  });
  app.notFound((c) => c.json(errorBody(new YoloError("not_found", "No such endpoint")), 404));

  app.use("*", async (c, next) => {
    if (c.req.header(OWNER_HEADER) !== "1") {
      throw new YoloError("forbidden", "Owner requests come only from Yolo's own pages");
    }
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin") throw new YoloError("forbidden", "Owner requests come only from Yolo's own pages");
    if (!READ_METHODS.has(c.req.method)) {
      const from = c.req.header("origin");
      if (!from || (from !== publicOrigin(c) && from !== new URL(c.req.url).origin)) {
        throw new YoloError("forbidden", "Owner requests come only from Yolo's own pages");
      }
    }
    await next();
    c.header("cache-control", "no-store");
  });

  // Every route but /session needs the owner signed in with a passkey.
  const owner = async (c, next) => {
    const session = await getSession(c.env.OAUTH_KV, c.req.raw);
    if (!session?.userId) throw new YoloError("unauthorized", "Sign in with your passkey to manage Yolo");
    c.set("userId", session.userId);
    await next();
  };
  const services = (c) => servicesFor(c.env, c.get("userId"));
  const oauth = (c) => oauthFor(c.env, c.req.raw);

  // --- The owner session --------------------------------------------------
  app.get("/session", async (c) => {
    const session = await getSession(c.env.OAUTH_KV, c.req.raw);
    return c.json({ signedIn: Boolean(session?.userId) });
  });
  app.post("/session/sign-out", async (c) => {
    c.header("set-cookie", await destroySession(c.env.OAUTH_KV, c.req.raw));
    return c.json({ signedIn: false });
  });

  // --- Devices -------------------------------------------------------------
  app.get("/devices", owner, async (c) => c.json(await services(c).devices()));
  app.patch("/devices/:id", owner, async (c) => {
    const { name, kind } = await jsonBody(c);
    return c.json(await services(c).renameDevice(c.req.param("id"), { name, kind }));
  });
  app.delete("/devices/:id", owner, async (c) => c.json(await services(c).deleteDevice(c.req.param("id"))));

  // This browser's own pairing code, approved by the owner signed in on it
  // (Agent Note 2026-10-07-device-code-pairing): no QR code to scan.
  app.post("/pairing/approve", owner, async (c) => {
    const { userCode, name, kind } = await jsonBody(c);
    const code = normalizeUserCode(userCode);
    if (!code) throw new YoloError("invalid_request", "userCode must be a pairing code like BCDF-GHJK");
    const decided = await decideDeviceCode(c.env.DB, c.get("userId"), code, { approve: true, name, kind });
    return c.json({ deviceId: decided.deviceId, name: decided.deviceName, kind: decided.deviceKind });
  });

  // --- Connected agents: OAuth grants, one row per client -------------------
  async function grantsOf(c) {
    const grants = [];
    let cursor;
    do {
      const page = await oauth(c).listUserGrants(c.get("userId"), { limit: 100, ...(cursor ? { cursor } : {}) });
      grants.push(...(page.items || []));
      cursor = page.cursor;
    } while (cursor && grants.length < MAX_GRANTS);
    return grants;
  }

  app.get("/agents", owner, async (c) => {
    const byClient = new Map();
    for (const grant of await grantsOf(c)) {
      const entry = byClient.get(grant.clientId) ?? { clientId: grant.clientId, grants: [] };
      entry.grants.push(grant);
      byClient.set(grant.clientId, entry);
    }
    const agents = await Promise.all([...byClient.values()].map(async ({ clientId, grants }) => {
      let client = null;
      try {
        client = await oauth(c).lookupClient(clientId);
      } catch {
        // A metadata document that cannot be fetched now: show what the grant says.
      }
      const scope = [...new Set(grants.flatMap((grant) => grant.scope || []))];
      const createdAt = Math.min(...grants.map((grant) => millis(grant.createdAt) ?? Infinity));
      return {
        id: clientId,
        name: client?.clientName || hostOf(clientId) || "Unnamed app",
        // The site that published a metadata-document client; a self-registered
        // client's name is its own claim.
        site: hostOf(clientId) || hostOf(client?.clientUri) || null,
        redirectHosts: [...new Set(grants.map((grant) => hostOf(grant.redirectUri)).filter(Boolean))],
        scope,
        connections: grants.length,
        createdAt: Number.isFinite(createdAt) ? createdAt : null,
      };
    }));
    agents.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return c.json({ agents });
  });

  // Revoking an agent revokes every grant its client holds, and with them its
  // access and refresh tokens; it must ask for the owner's consent again.
  app.delete("/agents/:id", owner, async (c) => {
    const clientId = c.req.param("id");
    const grants = (await grantsOf(c)).filter((grant) => grant.clientId === clientId);
    if (!grants.length) throw new YoloError("not_found", "No connected agent has that id");
    await Promise.all(grants.map((grant) => oauth(c).revokeGrant(grant.id, c.get("userId"))));
    return c.json({ revoked: clientId, grants: grants.length });
  });

  // --- LAN direct play (Agent Note 2026-10-12-lan-direct-play) --------------
  // The node's name, address, and certificate as the last check left them,
  // and a check now (which may take a minute when a certificate is due).
  app.get("/lan", owner, async (c) => c.json(presentLan(await readLanState(c.env.OAUTH_KV), c.env)));
  app.post("/lan/check", owner, async (c) => c.json(await checkLan(c.env)));

  // --- Media paths (Agent Note 2026-10-13-media-off-the-worker) ------------
  // Each path's state, the relay switch, and remote access. Turning the
  // relay on needs `acceptRelayWarning: true`, the owner's confirmation of
  // RELAY_WARNING; every change of the relay writes a security log line.
  const mediaView = async (c, { lan, wan } = {}) => {
    const settings = await readMediaSettings(c.env.DB, c.get("userId"));
    const remote = await remoteWanted(c.env.DB);
    return {
      relay: { on: settings.relay, acceptedAt: settings.relayAcceptedAt },
      warning: RELAY_WARNING,
      lan: lan ?? presentLan(await readLanState(c.env.OAUTH_KV), c.env),
      remote: wan ?? presentWan(await readWanState(c.env.OAUTH_KV), c.env, { remote }),
    };
  };
  app.get("/media", owner, async (c) => c.json(await mediaView(c)));
  app.patch("/media", owner, async (c) => {
    const { relay, acceptRelayWarning, remote } = await jsonBody(c);
    const userId = c.get("userId");
    const before = await readMediaSettings(c.env.DB, userId);
    const changes = {};
    if (typeof relay === "boolean" && relay !== before.relay) {
      if (relay && acceptRelayWarning !== true) throw new YoloError("invalid_request", `Turning the relay on needs your confirmation: ${RELAY_WARNING}`);
      Object.assign(changes, { relay, relayAcceptedAt: relay ? Date.now() : before.relayAcceptedAt });
    }
    if (typeof remote === "boolean" && remote !== before.remote) changes.remote = remote;
    if (!Object.keys(changes).length) return c.json(await mediaView(c));
    await writeMediaSettings(c.env.DB, userId, changes);
    if ("relay" in changes) {
      forgetRelay(userId);
      log({ kind: "security", event: changes.relay ? "relay_on" : "relay_off", userId, warningAccepted: changes.relay === true });
    }
    // Remote access on or off: name, record, certificate, and router now
    // (it may take a minute for a certificate).
    const wan = "remote" in changes ? await checkWan(c.env) : undefined;
    return c.json(await mediaView(c, { wan }));
  });
  app.post("/media/check", owner, async (c) => {
    const lan = await checkLan(c.env);
    const wan = await checkWan(c.env);
    return c.json(await mediaView(c, { lan, wan }));
  });

  // --- Passkeys ----------------------------------------------------------------
  // Adding one uses the existing sign-in flow (/auth/passkey/register/*) with
  // this session; no pairing code is needed then.
  app.get("/passkeys", owner, async (c) => {
    const passkeys = (await listPasskeys(c.env.DB, c.get("userId"))).map((passkey) => ({
      id: passkey.id,
      name: passkey.name,
      synced: passkey.backedUp,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt ?? null,
    }));
    return c.json({ passkeys });
  });

  // Removing a passkey signs out every other owner session (one may have
  // come from it); this browser stays signed in with a new session.
  app.delete("/passkeys/:id", owner, async (c) => {
    const userId = c.get("userId");
    const passkeys = await listPasskeys(c.env.DB, userId);
    const id = c.req.param("id");
    if (!passkeys.some((passkey) => passkey.id === id)) throw new YoloError("not_found", "No passkey has that id");
    if (passkeys.length === 1) throw new YoloError("invalid_request", "This is your only passkey. Add another before removing it.");
    await deletePasskey(c.env.DB, userId, id);
    await revokeAllSessions(c.env.OAUTH_KV);
    c.header("set-cookie", await createSession(c.env.OAUTH_KV, userId));
    return c.json({ deleted: id });
  });

  return app;
}
