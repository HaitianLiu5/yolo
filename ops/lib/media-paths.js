// The media paths as the operator sees them (Agent Note 2026-10-13-media-off-the-worker),
// from the operator's view of /.well-known/yolo (`operator.media`): doctor's
// relay check, the deploy's last step, which reports the path that works,
// and the router step for remote direct play. The relay is the fallback in
// the owner's own Cloudflare account, so automatic and on are information;
// only the relay off with no direct path at all fails.

const PATH_WORDS = { lan: "the home network", wan: "remote direct play", relay: "the relay" };

const streamsText = (streams) => (streams && Number.isFinite(streams.relay)
  ? `; ${streams.relay} relay ${streams.relay === 1 ? "stream" : "streams"} in the last ${streams.days ?? 7} days`
  : "");

/** The router step that makes remote direct play reachable, with the port, the node's address, and the router's when known. */
export function routerSteps(remote = {}) {
  if (!remote.status || remote.status === "off") {
    return "Turn on Remote direct play in Settings › Media paths (after the owner's passkey); the node then asks the router for its port by PCP, NAT-PMP, or UPnP";
  }
  if (remote.status === "cgnat") return "This internet connection is behind carrier-grade NAT, so remote direct play cannot work on it; the relay covers screens away from home";
  const forward = remote.forward ?? {};
  const port = forward.port ?? 9444;
  const to = forward.address ? `${forward.address}${forward.internalPort && forward.internalPort !== port ? ` port ${forward.internalPort}` : ""}` : "this machine";
  return `On the router${forward.gateway ? ` (${forward.gateway})` : ""}: turn on UPnP, or forward TCP port ${port} to ${to}, set WAN_MAPPING=manual in .env, and run npm run yolo -- service restart node (skills/yolo-deploy lists router-specific steps)`;
}

const directPaths = (media) => ({ lan: media?.lan?.status === "ready", wan: media?.remote?.status === "ok" });

/** doctor's `worker.relay` check: { id, status, message, fix? }. */
export function relayCheck(media) {
  const mode = media?.relayMode ?? (media?.relay === false ? "off" : media?.relay === true ? "on" : "auto");
  const direct = directPaths(media);
  if (mode === "auto") {
    return { id: "worker.relay", status: "info", message: `The relay is automatic: media goes through your Cloudflare account only when no direct path works for a screen${streamsText(media?.streams)}` };
  }
  if (mode === "on") {
    return { id: "worker.relay", status: "info", message: `The relay is on: the last path for screens no direct path reaches${streamsText(media?.streams)}` };
  }
  if (!direct.lan && !direct.wan) {
    return {
      id: "worker.relay", status: "fail",
      message: "The relay is off and no direct path works: no screen can play",
      fix: `The owner sets Relay to Automatic in Settings › Media paths, or makes remote direct play reachable: ${routerSteps(media?.remote)}`,
    };
  }
  if (!direct.wan) {
    return {
      id: "worker.relay", status: "warn",
      message: "The relay is off and remote direct play is not reachable: screens play only at home, over the home network",
      fix: `The owner sets Relay to Automatic in Settings › Media paths, or: ${routerSteps(media?.remote)}`,
    };
  }
  return { id: "worker.relay", status: "info", message: "The relay is off: screens play only by direct paths" };
}

/**
 * The deploy's last step: which media path works now. Never a failure, so
 * the deploy stands; a step that needs the owner says so in `fix`.
 * `operator` is /.well-known/yolo's operator view, or null.
 */
export function mediaStep(operator) {
  const media = operator?.media;
  if (!media) {
    return { id: "media", status: "warn", message: "Cannot read the media paths from the Worker", fix: "npm run yolo -- doctor" };
  }
  const direct = directPaths(media);
  const mode = media.relayMode ?? (media.relay === false ? "off" : "auto");
  const relayWorks = mode !== "off" && operator.node?.reachable === true;
  const working = [direct.lan ? "lan" : null, direct.wan ? "wan" : null, relayWorks ? "relay" : null].filter(Boolean);
  const listed = working.map((path) => (path === "wan" && media.remote?.origin ? `${PATH_WORDS.wan} (reachable from outside at ${media.remote.origin})` : path === "relay" ? `${PATH_WORDS.relay} (${mode}, through the tunnel)` : PATH_WORDS[path]));
  if (direct.wan) return { id: "media", status: "ok", message: `Media paths that work: ${listed.join(", ")}` };
  const router = routerSteps(media.remote);
  if (relayWorks) {
    return {
      id: "media", status: "info",
      message: `Media paths that work: ${listed.join(", ")}. Remote direct play is ${media.remote?.status ?? "off"}, so away from home screens play through the relay until it is reachable`,
      fix: router,
    };
  }
  return {
    id: "media", status: "warn",
    message: working.length ? `Media paths that work: ${listed.join(", ")}; away from home no screen plays` : "No media path works yet",
    fix: mode === "off" ? `The owner sets Relay to Automatic in Settings › Media paths, or: ${router}` : `The Worker does not reach the node: npm run yolo -- doctor. Then: ${router}`,
  };
}
