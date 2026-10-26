import { YoloError } from "@useyolo/plugin-api";

// Official proxy provider plugin: a fixed proxy for the media node's egress
// rules (Agent Note 2026-10-13-node-egress-proxy). It registers the provider
// "url"; each proxy in yolo.config.json's egress.proxies that names it says
// which environment variable holds the proxy's URL, credentials included:
//
//   "proxies": { "home": { "provider": "url", "options": { "env": "EGRESS_HOME_PROXY_URL" } } }
//
// and .env has EGRESS_HOME_PROXY_URL=http://user:password@proxy.example:8080.
// The variable is read on every request for an endpoint, so a changed .env
// takes effect after the node restarts, and a proxy that refuses the
// credentials gets the same URL again.

export const PROVIDER_ID = "url";
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function endpointFrom(options, env) {
  const name = String(options?.env ?? "");
  if (!ENV_NAME.test(name)) throw new YoloError("invalid_request", 'The url proxy provider needs options.env, the name of the environment variable that holds the proxy URL');
  const value = String(env[name] ?? "").trim();
  if (!value) throw new YoloError("not_found", `${name} is not set`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new YoloError("invalid_request", `${name} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new YoloError("invalid_request", `${name} must be an http:// or https:// proxy URL`);
  return {
    url: `${url.protocol}//${url.host}`,
    ...(url.username ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : {}),
  };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function proxyUrlPlugin(yolo) {
  yolo.registerProxyProvider(PROVIDER_ID, {
    endpoint: (options) => endpointFrom(options, yolo.env),
  });
}
