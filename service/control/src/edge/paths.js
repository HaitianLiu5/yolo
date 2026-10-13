import { readMediaSettings } from "../store/media-settings.js";
import { lanWelcome, readLanState } from "./lan.js";
import { readWanState, wanWelcome } from "./wan.js";

// The media paths a device may use (Agent Note 2026-10-13-media-off-the-worker),
// as the Hub's welcome carries them: `paths` lists the node's listeners whose
// last check found them serving with a valid certificate (`lan`, then `wan`
// once the Worker reached it from outside), and `relay` says whether the
// Worker relays media for this user.

export async function mediaWelcome(env, userId, now = Date.now()) {
  const [lan, wan, settings] = await Promise.all([readLanState(env.OAUTH_KV), readWanState(env.OAUTH_KV), readMediaSettings(env.DB, userId)]);
  const paths = [];
  const lanPath = lanWelcome(lan, now);
  if (lanPath) paths.push({ path: "lan", ...lanPath });
  const wanPath = settings.remote ? wanWelcome(wan, now) : null;
  if (wanPath) paths.push({ path: "wan", ...wanPath });
  return { paths, relay: settings.relay };
}

// What turning the relay on asks the owner to accept.
export const RELAY_WARNING = "Relaying video through your Cloudflare Worker is likely outside Cloudflare's terms on Free, Pro, and Business zones, and Workers Free is clearly not covered. Cloudflare may restrict video on your domain or act on your account. Turn this on only if you accept that risk.";

// What a probe outcome means, in words.
const OUTCOMES = {
  timeout: "no answer",
  permission_denied: "the browser blocks local network access",
  permission_prompt: "the browser's local network permission is not granted yet",
  certificate: "the certificate is not valid",
  dns_rebinding: "the router hides the name (DNS rebinding protection)",
  off: "turned off on this screen",
  failed: "failed during playback",
};

/**
 * The refusal when a device reaches no path and the relay is off: each
 * path, what the device found, and the setup it needs.
 */
export function unreachableMessage({ probes = {}, paths = [] } = {}) {
  const has = (path) => paths.some((entry) => entry.path === path);
  const found = (path) => (probes[path] ? OUTCOMES[probes[path]] ?? probes[path] : "not tried");
  const lan = has("lan") ? `the home network: ${found("lan")}` : "the home network: not set up (the MEDIA_DNS_TOKEN secret)";
  const wan = has("wan") ? `remote direct play: ${found("wan")}` : "remote direct play: not set up (turn on remote access in Yolo's settings)";
  return `This screen reaches no media path (${lan}; ${wan}), and the relay through Cloudflare is off. Set up remote direct play in Yolo's settings, or turn the relay on there.`;
}
