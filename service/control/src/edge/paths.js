import { readMediaSettings } from "../store/media-settings.js";
import { mediaDnsConfigured } from "./dns.js";
import { lanWelcome, readLanState } from "./lan.js";
import { readWanState, wanCertificate, wanWelcome } from "./wan.js";

// The media paths a device may use (Agent Note 2026-10-13-media-off-the-worker),
// as the Hub's welcome carries them: `paths` lists the node's listeners whose
// last check found them serving with a valid certificate (`lan`, then `wan`
// once it was reached from outside), `relayMode` the owner's mode for the
// relay through the Worker (auto, on, or off), and `relay` whether the
// relay may carry this user's media at all, as players before the modes
// read it. For the Hub alone, not the devices: `homeAddress`, the home's
// public address, against which the Hub marks the `wan` entry `home: true`
// for a device that connects from it, whose `wan` probe then tests the
// router's NAT loopback (hairpin); `lanNeedsDomain` when the instance names
// nothing (no domain and no DNS provider plugin), so no LAN path can exist;
// and `remote` and `forward`, remote access's state and the router port to
// forward, for the refusal's fix.

export async function mediaWelcome(env, userId, now = Date.now()) {
  const [lan, wan, settings] = await Promise.all([readLanState(env.OAUTH_KV), readWanState(env.OAUTH_KV), readMediaSettings(env.DB, userId)]);
  const paths = [];
  const lanPath = lanWelcome(lan, now);
  if (lanPath) paths.push({ path: "lan", ...lanPath });
  const wanPath = settings.remote ? wanWelcome(wan, now) : null;
  if (wanPath) paths.push({ path: "wan", ...wanPath });
  return {
    paths,
    relayMode: settings.relayMode,
    homeAddress: wanPath ? wan.address ?? null : null,
    lanNeedsDomain: !mediaDnsConfigured(env) && wanCertificate(env) === "ip",
    remote: { on: settings.remote, status: settings.remote ? wan?.status ?? "pending" : "off" },
    forward: forwardOf(wan),
  };
}

// The router port remote direct play needs, as the node last reported it:
// the external port (granted, or asked for), the node's address and port
// behind it, and the router's address; null before remote access ran once.
function forwardOf(wan) {
  const port = wan?.mapping?.externalPort ?? wan?.mapping?.requestedPort ?? wan?.listener?.port ?? null;
  if (!port) return null;
  return {
    port,
    internalPort: wan?.listener?.port ?? port,
    address: wan?.listener?.address ?? null,
    gateway: wan?.mapping?.gateway ?? null,
    method: wan?.mapping?.method ?? null,
  };
}

/**
 * What a device is told: the paths, with `home: true` on `wan` when it
 * connects from the home's address, the relay, and `domain: false` on an
 * instance without a domain, where the screen's LAN switch has nothing to find.
 */
export function deviceMedia(media, address = null) {
  if (!media) return null;
  const home = Boolean(address && media.homeAddress && address === media.homeAddress);
  const mode = media.relayMode ?? "auto";
  return {
    paths: (media.paths || []).map((entry) => (entry.path === "wan" && home ? { ...entry, home: true } : entry)),
    relay: mode !== "off",
    relayMode: mode,
    ...(media.lanNeedsDomain ? { domain: false } : {}),
  };
}

// What the settings say about the relay, once, in plain words.
export const RELAY_NOTE = "Media goes through your Cloudflare account when no direct path works. Direct paths come first: they are faster and spend no Cloudflare bandwidth.";

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

const REMOTE_PROBLEMS = {
  cgnat: "this internet connection is behind carrier-grade NAT",
  unreachable: "not reachable from outside the home",
  error: "needs attention",
  certificate: "waiting for a valid certificate",
  pending: "being set up",
};

// The router step for remote direct play, with the port, the node's
// address, and the router's when the node reported them.
function forwardFix(forward) {
  const port = forward?.port ?? null;
  const to = forward?.address ? `${forward.address}${forward.internalPort && forward.internalPort !== port ? ` port ${forward.internalPort}` : ""}` : "the media node's computer";
  const router = forward?.gateway ? `the router (${forward.gateway})` : "the router";
  const text = port
    ? `On ${router}, turn on UPnP, or forward TCP port ${port} to ${to} and set WAN_MAPPING=manual in the node's .env`
    : `On ${router}, turn on UPnP, or forward the node's remote port (TCP 9444 unless WAN_EXTERNAL_PORT says otherwise) to the media node's computer`;
  return { action: "forward", text, port, address: forward?.address ?? null, gateway: forward?.gateway ?? null };
}

/**
 * The refusal when a device reaches no path and the relay is off: each
 * path, what the device found, and what fixes it, in `message` for agents
 * and as `details.fixes` for the screen ({ action, text }: `relay` turns
 * the relay to automatic, `remote` turns remote access on, `forward` is the
 * router step, `domain` adds direct play at home).
 */
export function unreachableRefusal({ probes = {}, paths = [], lanNeedsDomain = false, remote = null, forward = null } = {}) {
  const has = (path) => paths.some((entry) => entry.path === path);
  const found = (path) => (probes[path] ? OUTCOMES[probes[path]] ?? probes[path] : "not tried");
  const remoteOn = remote?.on === true;
  const lan = has("lan") ? `the home network: ${found("lan")}`
    : lanNeedsDomain ? "the home network: needs a domain" : "the home network: not set up (npm run yolo -- provision media-dns)";
  const wan = has("wan") ? `remote direct play: ${found("wan")}`
    : remoteOn ? `remote direct play: ${REMOTE_PROBLEMS[remote.status] ?? "not ready"}`
      : "remote direct play: not set up (turn on remote access in Yolo's settings)";
  const fixes = [{ action: "relay", text: "Turn the relay to Automatic in Settings › Media paths: media then goes through your Cloudflare account when no direct path works" }];
  if (!remoteOn) fixes.push({ action: "remote", text: "Turn on Remote direct play in Settings › Media paths: the node asks the router for its port itself" });
  else if (remote.status !== "cgnat") fixes.push(forwardFix(forward));
  const reason = `This screen reaches no media path (${lan}; ${wan}), and the relay is off`;
  return { message: `${reason}. ${fixes.map((fix) => fix.text).join(". Or: ")}.`, details: { relayMode: "off", reason, fixes } };
}
