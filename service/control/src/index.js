import { getOAuthApi, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { errorBody, YoloError } from "@useyolo/core";
import { createOwnerApp } from "./api/owner.js";
import { createV1App } from "./api/v1.js";
import { AUTHORIZE_PATH, createAuthApp } from "./auth/app.js";
import { DEVICE_SCOPES, deviceTokenRequest, withDeviceMetadata } from "./auth/device.js";
import { hubClient } from "./hub/hub.js";
import { handleMcpRequest } from "./mcp/handler.js";
import { SCOPES } from "./mcp/tools.js";
import { proxyMedia } from "./media.js";
import { maintainLan } from "./lan/maintain.js";
import { createNodeClient, isNodeRequest } from "./node-client.js";
import pluginEntries from "./plugins.generated.js";
import { loadControlPlugins } from "./plugins.js";
import { handleRealtime, issueRealtimeTicket } from "./realtime.js";
import build from "./build-info.generated.js";
import { createServices } from "./services.js";
import { resolveDeviceToken } from "./store/pairing.js";
import { health, HEALTH_PATHS, WELL_KNOWN_PATH, wellKnown } from "./well-known.js";

export { Hub } from "./hub/hub.js";

// Yolo control plane
// (Agent Note 2026-10-07-control-plane-on-cloudflare-media-node-at-home). One
// Worker serves:
//   /               the Tesla client (clients/tesla), as static assets with
//                   COOP/COEP (its _headers file); wrangler.jsonc sends the
//                   routes below to this Worker first
//   /mcp            remote MCP (Streamable HTTP), OAuth-protected
//   /v1/*           HTTP API, OAuth-protected or a paired device's credential
//   /v1/owner/*     the owner's settings, behind the passkey session cookie
//   /v1/realtime    WebSocket to the user's Hub Durable Object (ticket auth)
//   /m/*            media passthrough to the node (signed path token)
//   /oauth/*        OAuth 2.1 authorization server, the device grant
//   /login, /device, /account   owner sign-in, device pairing, account
//   /.well-known/yolo, /healthz   version, protocol, and migration level
//                   (well-known.js)
// Its cron trigger keeps the node's LAN name, address record, and
// certificate current (lan/maintain.js).

function buildServices(env, userId) {
  return createServices({ db: env.DB, userId, hub: hubClient(env, userId), node: createNodeClient(env) });
}

// Control entries of the configured plugins, bundled at build time by
// scripts/generate-plugins.js. Their factories run on the first MCP request,
// never in the Worker's global scope.
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
    return handleMcpRequest(request, {
      services: buildServices(env, ctx.props.userId),
      scopes: ctx.auth?.scope ?? [],
      allowedHostnames: [origin.hostname],
      tools,
    });
  },
};

const v1App = createV1App({
  getContext: (c) => {
    const { props, auth } = c.executionCtx;
    return {
      services: buildServices(c.env, props.userId),
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

// The owner's settings (api/owner.js) list and revoke agents' grants with the
// provider's helpers; they are not behind a bearer token, so they bypass it.
const ownerApp = createOwnerApp({
  servicesFor: buildServices,
  oauthFor: (env, request) => getOAuthApi(providerOptions(publicOrigin(env, request)), env),
});

export default {
  async fetch(request, env, ctx) {
    if (isNodeRequest(request)) {
      return Response.json(errorBody(new YoloError("invalid_request", "A media node request reached the control plane")), { status: 508 });
    }
    const { pathname } = new URL(request.url);
    if (pathname === WELL_KNOWN_PATH) {
      return wellKnown(request, env, { build, node: createNodeClient(env), plugins: pluginEntries.map(({ name, version }) => ({ name, version })) });
    }
    if (HEALTH_PATHS.includes(pathname)) return health(build);
    if (pathname === "/v1/realtime") return handleRealtime(request, env);
    if (pathname === "/v1/owner" || pathname.startsWith("/v1/owner/")) return ownerApp.fetch(request, env, ctx);
    if (pathname.startsWith("/m/")) return proxyMedia(request, env);
    if (pathname === "/oauth/token" && request.method === "POST") {
      const device = await deviceTokenRequest(request, env);
      if (device) return device;
    }
    const response = await oauthProvider(env, request).fetch(request, env, ctx);
    if (pathname === "/.well-known/oauth-authorization-server") return withDeviceMetadata(response, env, request);
    return response;
  },

  // LAN direct play: nothing to do without the LAN_DNS_TOKEN secret.
  async scheduled(_controller, env) {
    try {
      await maintainLan(env);
    } catch (error) {
      console.error("LAN maintenance failed", error);
    }
  },
};
