import { Hono } from "hono";
import { errorBody, relayMode as asRelayMode, toYoloError, YoloError } from "@useyolo/core";
import { createSession, destroySession, getSession, revokeAllSessions } from "../auth/session.js";
import { maintainLan, presentLan, readLanState } from "../edge/lan.js";
import { RELAY_NOTE } from "../edge/paths.js";
import { maintainWan, presentWan, readWanState } from "../edge/wan.js";
import { readImageLinks, resetImageLinks } from "../store/image-links.js";
import { forgetRelay, readMediaSettings, remoteWanted, writeMediaSettings } from "../store/media-settings.js";
import { decideDeviceCode, normalizeUserCode } from "../store/pairing.js";
import { resolveProfile } from "../store/profiles.js";
import { readVoiceLanguages, writeVoiceLanguages } from "../store/voice-settings.js";
import { deletePasskey, listPasskeys } from "../store/users.js";

// Owner routes under /v1/owner (Agent Note 2026-10-07-v1-http-api): what the
// signed-in owner manages from Yolo's own settings — devices, connected
// agents, passkeys, the owner session, approving this browser's own
// pairing code, the media paths (LAN direct play's status, remote access,
// and the relay), the languages the owner speaks to Yolo, resetting agents'
// image links, and the share links sent to friends. They authenticate with
// the owner's passkey session cookie (auth/session.js) and nothing else: a
// bearer token, a device credential included, never reaches them.
//
// Cross-site requests are refused three ways on top of the SameSite=Lax
// session cookie: every request carries the X-Yolo-Owner header (a custom
// header a cross-origin page cannot send without a CORS preflight, which
// these routes never answer), Sec-Fetch-Site must be same-origin when the
// browser sends it, and a request that changes something must carry an
// Origin header equal to Yolo's own.

const OWNER_HEADER = "x-yolo-owner";
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
 * @param {(env: object) => Promise<object>} [options.checkLan]  runs LAN maintenance now (edge/lan.js), as an
 *   interactive run: a slow DNS provider's certificate order is left to the cron run
 * @param {(env: object) => Promise<object>} [options.checkWan]  runs remote maintenance now (edge/wan.js)
 */
export function createOwnerApp({ servicesFor, oauthFor, checkLan = (env) => maintainLan(env, { interactive: true }), checkWan = (env) => maintainWan(env, { interactive: true }), log = (record) => console.log(record) }) {
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
    const { name, kind, profile } = await jsonBody(c);
    return c.json(await services(c).renameDevice(c.req.param("id"), { name, kind, profile }));
  });

  // --- Profiles, who watches (Agent Note 2026-10-31-screen-sessions) --------
  app.get("/profiles", owner, async (c) => c.json(await services(c).profiles()));
  app.post("/profiles", owner, async (c) => c.json(await services(c).createProfile(await jsonBody(c)), 201));
  app.patch("/profiles/:id", owner, async (c) => c.json(await services(c).renameProfile(c.req.param("id"), await jsonBody(c))));
  app.delete("/profiles/:id", owner, async (c) => c.json(await services(c).deleteProfile(c.req.param("id"))));
  app.delete("/devices/:id", owner, async (c) => c.json(await services(c).deleteDevice(c.req.param("id"))));

  // This browser's own pairing code, approved by the owner signed in on it
  // (Agent Note 2026-10-07-device-code-pairing): no QR code to scan.
  app.post("/pairing/approve", owner, async (c) => {
    const { userCode, name, kind, profile } = await jsonBody(c);
    const code = normalizeUserCode(userCode);
    if (!code) throw new YoloError("invalid_request", "userCode must be a pairing code like BCDF-GHJK");
    const profileId = profile ? (await resolveProfile(c.env.DB, c.get("userId"), profile)).id : null;
    const decided = await decideDeviceCode(c.env.DB, c.get("userId"), code, { approve: true, name, kind, profileId });
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

  // --- Media paths (Agent Note 2026-10-13-media-off-the-worker) ------------
  // Each path's state, LAN direct play's included (the node's name, address,
  // and certificate as the last check left them; Agent Note
  // 2026-10-12-lan-direct-play), the relay's mode (auto, on, or off) with
  // one plain line about it, remote access, the path of each screen's last
  // stream, and the streams each path carried over 7 days. A change of the
  // mode writes a security log line and tells the connected screens, which
  // probe again. A check now may take a minute when a certificate is due.
  const mediaView = async (c, { lan, wan } = {}) => {
    const settings = await readMediaSettings(c.env.DB, c.get("userId"));
    const remote = await remoteWanted(c.env.DB);
    const usage = await Promise.resolve().then(() => services(c).mediaUsage()).catch(() => null);
    return {
      relay: { mode: settings.relayMode, on: settings.relay, note: RELAY_NOTE },
      lan: lan ?? presentLan(await readLanState(c.env.OAUTH_KV), c.env),
      remote: wan ?? presentWan(await readWanState(c.env.OAUTH_KV), c.env, { remote }),
      screens: usage?.screens ?? null,
      streams: usage?.streams ?? null,
    };
  };
  app.get("/media", owner, async (c) => c.json(await mediaView(c)));
  app.patch("/media", owner, async (c) => {
    const { relay, remote } = await jsonBody(c);
    const userId = c.get("userId");
    const before = await readMediaSettings(c.env.DB, userId);
    const changes = {};
    if (relay !== undefined) {
      // Only a mode: true and false, the switch of a settings page from
      // before the modes, are refused (Agent Note 2026-10-13-versions-and-releases).
      const mode = asRelayMode(relay);
      if (!mode) throw new YoloError("invalid_request", "relay must be auto, on, or off");
      if (mode !== before.relayMode) changes.relayMode = mode;
    }
    if (typeof remote === "boolean" && remote !== before.remote) changes.remote = remote;
    if (!Object.keys(changes).length) return c.json(await mediaView(c));
    await writeMediaSettings(c.env.DB, userId, changes);
    if ("relayMode" in changes) {
      forgetRelay(userId);
      log({ kind: "security", event: "relay_mode", userId, from: before.relayMode, to: changes.relayMode });
      await Promise.resolve().then(() => services(c).refreshMedia()).catch(() => {});
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

  // --- Voice (Agent Note 2026-10-18-agent-from-the-screen) -----------------
  // The languages the owner speaks, first first, which every screen's voice
  // input chooses among; an empty list forgets them.
  app.get("/voice", owner, async (c) => c.json({ languages: await readVoiceLanguages(c.env.DB, c.get("userId")) }));
  app.put("/voice", owner, async (c) => {
    const { languages } = await jsonBody(c);
    return c.json({ languages: await writeVoiceLanguages(c.env.DB, c.get("userId"), languages) });
  });

  // --- Image links (Agent Note 2026-10-07-remote-mcp-server) ---------------
  // The covers agents show come from links that keep working in old chats; a
  // reset moves to the next key version, so every link given so far stops
  // working, and writes a security log line.
  app.get("/image-links", owner, async (c) => c.json(await readImageLinks(c.env.DB, c.get("userId"))));
  app.post("/image-links/reset", owner, async (c) => {
    const userId = c.get("userId");
    const links = await resetImageLinks(c.env.DB, userId);
    log({ kind: "security", event: "image_links_reset", userId, version: links.version });
    return c.json(links);
  });

  // --- Share links (Agent Note 2026-10-20-share-links) ---------------------
  // The links screens and agents made, with how often friends played them;
  // revoking one stops it at once and writes a security log line
  // (services.js).
  app.get("/shares", owner, async (c) => c.json(await services(c).shareLinks()));
  app.post("/shares/:id/revoke", owner, async (c) => c.json(await services(c).revokeShareLink(c.req.param("id"))));

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
