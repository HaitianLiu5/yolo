import { getOAuthApi, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { errorBody, YoloError } from "@useyolo/core";
import { createOwnerApp } from "./api/owner.js";
import { createV1App } from "./api/v1.js";
import { AUTHORIZE_PATH, createAuthApp } from "./auth/app.js";
import { DEVICE_SCOPES, deviceTokenRequest, withDeviceMetadata } from "./auth/device.js";
import { hubClient } from "./hub/hub.js";
import { createImageLinks, IMAGE_LINK_PATH, serveImageLink } from "./image-links.js";
import { handleMcpRequest } from "./mcp/handler.js";
import { SCOPES } from "./mcp/tools.js";
import { relayMedia } from "./media.js";
import { serveShareLink, SHARE_API_PATH } from "./share-links.js";
import { maintainMediaNames, ownerChecks } from "./edge/maintain.js";
import { frameLimiter, guardMedia, limitPublicRequest } from "./rate-limit.js";
import { createNodeClient, isNodeRequest } from "./node-client.js";
import pluginEntries from "./plugins.generated.js";
import { loadControlPlugins } from "./plugins.js";
import { handleRealtime, issueRealtimeTicket } from "./realtime.js";
import build from "./build-info.generated.js";
import { createServices } from "./services.js";
import { imageLinkVersion } from "./store/image-links.js";
import { mediaUsers } from "./store/media-settings.js";
import { resolveDeviceToken } from "./store/pairing.js";
import { health, HEALTH_PATHS, WELL_KNOWN_PATH, wellKnown } from "./well-known.js";

export { Hub } from "./hub/hub.js";

// Yolo control plane
// (Agent Note 2026-10-07-control-plane-on-cloudflare-media-node-at-home). One
// Worker serves:
//   /               the player (clients/player), as static assets with
//                   COOP/COEP (its _headers file); wrangler.jsonc sends the
//                   routes below to this Worker first
//   /mcp            remote MCP (Streamable HTTP), OAuth-protected
//   /v1/*           HTTP API, OAuth-protected or a paired device's credential
//   /v1/owner/*     the owner's settings, behind the passkey session cookie
//   /v1/realtime    WebSocket to the user's Hub Durable Object (ticket auth)
//   /i/*            the covers agents show, by image link (signed path
//                   token, no credential; image-links.js)
//   /v1/share/*     a share link's item and streams for a friend's browser
//                   (token in the path, no credential; share-links.js); the
//                   player's page for it is /s/<token>
//   /m/*            the media relay to the node (signed path token), the
//                   fallback unless the owner turned it off
//   /oauth/*        OAuth 2.1 authorization server, the device grant
//   /login, /device, /account   owner sign-in, device pairing, account
//   /.well-known/yolo, /healthz   version, protocol, and migration level
//                   (well-known.js)
// Its cron trigger keeps the node's media names, address records, and
// certificates current (edge/maintain.js, edge/lan.js, edge/wan.js).

// `agent` names who asks, for the per-agent frame limit and the share links
// it makes: the OAuth client, or a paired device. `origin` is Yolo's public
// origin, which share links start with.
function buildServices(env, userId, agent = "owner", origin = null) {
  return createServices({
    db: env.DB, userId, hub: hubClient(env, userId), node: createNodeClient(env), allowFrame: frameLimiter(env, `${userId}:${agent}`), agent, origin,
  });
}

// Control entries of the configured plugins, bundled at build time by
// scripts/generate-plugins.js. Their factories run on the first MCP request
// or the first run of the media names (their DNS providers), never in the
// Worker's global scope.
let controlPlugins = null;
const plugins = () => (controlPlugins ??= loadControlPlugins(pluginEntries));

const mcpApi = {
  async fetch(request, env, ctx) {
    // A paired device's credential is for playing, not for agents.
    if (ctx.props?.deviceId) {
      return Response.json(errorBody(new YoloError("forbidden", "Device credentials cannot use /mcp")), { status: 403 });
    }
    const origin = new URL(env.PUBLIC_ORIGIN || request.url);
    const { tools } = await plugins();
    const { userId } = ctx.props;
    return handleMcpRequest(request, {
      services: buildServices(env, userId, `client:${ctx.auth?.clientId ?? "unknown"}`, origin.origin),
      scopes: ctx.auth?.scope ?? [],
      allowedHostnames: [origin.hostname],
      tools,
      // Thumbnails as absolute image links on PUBLIC_ORIGIN, sealed with the
      // owner's current key version (Agent Note 2026-10-07-remote-mcp-server).
      images: createImageLinks({
        secret: env.NODE_SECRET, origin: origin.origin, userId, version: () => imageLinkVersion(env.DB, userId, { fresh: true }),
      }),
    });
  },
};

const v1App = createV1App({
  getContext: (c) => {
    const { props, auth } = c.executionCtx;
    return {
      services: buildServices(
        c.env, props.userId, props.deviceId ? `device:${props.deviceId}` : `client:${auth?.clientId ?? "unknown"}`, publicOrigin(c.env, c.req.raw),
      ),
      // OAuth grants carry their scopes; a device credential's are in props.
      scopes: props.deviceId ? props.scopes ?? [] : auth?.scope ?? [],
      userId: props.userId,
      deviceId: props.deviceId ?? null,
    };
  },
  issueRealtimeTicket,
});

const authApp = createAuthApp();

const publicOrigin = (env, request) => new URL(env.PUBLIC_ORIGIN || request.url).origin;

// The token audience is the deployment's origin, which covers /mcp and /v1.
// It comes from PUBLIC_ORIGIN, so the provider is built on first request.
function providerOptions(origin) {
  return {
    apiHandlers: {
      "/mcp": mcpApi,
      "/v1/": { fetch: (req, e, ctx) => v1App.fetch(req, e, ctx) },
    },
    defaultHandler: { fetch: (req, e, ctx) => authApp.fetch(req, e, ctx) },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: SCOPES,
    // Agents ask for every scope by default; the consent page can drop some.
    requiredScopes: SCOPES,
    accessTokenTTL: 60 * 60,
    resourceMetadata: { resource: origin, authorization_servers: [origin], resource_name: "Yolo" },
    // Credentials of paired devices (auth/device.js) are not the provider's
    // own tokens; they are checked against D1 on every request.
    resolveExternalToken: async ({ token, env: workerEnv }) => {
      const device = await resolveDeviceToken(workerEnv.DB, token);
      return device ? { props: { userId: device.userId, deviceId: device.deviceId, scopes: [...DEVICE_SCOPES] }, audience: origin } : null;
    },
  };
}

let provider = null;
let providerOrigin = null;

function oauthProvider(env, request) {
  const origin = publicOrigin(env, request);
  if (provider && providerOrigin === origin) return provider;
  providerOrigin = origin;
  provider = new OAuthProvider(providerOptions(origin));
  return provider;
}

// The remote origin changed (a new home address without a domain, or the
// path came or went): every Hub tells its connected screens, which probe
// the new list (Agent Note 2026-10-13-media-off-the-worker).
async function refreshScreens(env) {
  for (const userId of await mediaUsers(env.DB)) {
    await hubClient(env, userId).broadcastMedia().catch((error) => console.warn("Media paths broadcast failed", error?.message));
  }
}
// The node's media names, with the DNS providers the plugins registered,
// loaded only for an instance that chose one
// (Agent Note 2026-10-14-dns-provider-plugins).
const dnsProviders = async () => (await plugins()).dnsProviders;
const { checkLan, checkWan } = ownerChecks({ loadProviders: dnsProviders, onPathsChanged: refreshScreens });

// The owner's settings (api/owner.js) list and revoke agents' grants with the
// provider's helpers; they are not behind a bearer token, so they bypass it.
const ownerApp = createOwnerApp({
  servicesFor: buildServices,
  oauthFor: (env, request) => getOAuthApi(providerOptions(publicOrigin(env, request)), env),
  checkLan,
  checkWan,
});

export default {
  async fetch(request, env, ctx) {
    if (isNodeRequest(request)) {
      return Response.json(errorBody(new YoloError("invalid_request", "A media node request reached the control plane")), { status: 508 });
    }
    const { pathname } = new URL(request.url);
    if (pathname === WELL_KNOWN_PATH) {
      return wellKnown(request, env, {
        build, node: createNodeClient(env), plugins: pluginEntries.map(({ name, version }) => ({ name, version })), usage: (userId) => hubClient(env, userId).mediaUsage(),
      });
    }
    if (HEALTH_PATHS.includes(pathname)) return health(build);
    if (pathname === "/v1/realtime") return handleRealtime(request, env);
    if (pathname === "/v1/owner" || pathname.startsWith("/v1/owner/")) return ownerApp.fetch(request, env, ctx);
    if (pathname.startsWith("/m/")) return guardMedia(request, env, () => relayMedia(request, env));
    if (pathname.startsWith(IMAGE_LINK_PATH)) return serveImageLink(request, env, { servicesFor: (workerEnv, userId) => buildServices(workerEnv, userId, "image-link") });
    if (pathname.startsWith(SHARE_API_PATH)) return serveShareLink(request, env, { node: createNodeClient(env) });
    const limited = await limitPublicRequest(request, env);
    if (limited) return limited;
    if (pathname === "/oauth/token" && request.method === "POST") {
      const device = await deviceTokenRequest(request, env);
      if (device) return device;
    }
    const response = await oauthProvider(env, request).fetch(request, env, ctx);
    if (pathname === "/.well-known/oauth-authorization-server") return withDeviceMetadata(response, env, request);
    return response;
  },

  // The node's media names: nothing to do without a DNS provider (the
  // MEDIA_DNS_TOKEN secret, or a plugin's provider the instance chose), and
  // nothing remote while remote access is off.
  async scheduled(_controller, env) {
    await maintainMediaNames(env, { loadProviders: dnsProviders, wan: { onPathsChanged: () => refreshScreens(env) } });
  },
};
