// This screen's media path (Agent Note 2026-10-13-media-off-the-worker). The
// Hub's welcome lists the node's listeners a device may use (`lan`, `wan`)
// and the owner's mode for the relay through the Worker: `auto` (the
// default) and `on` allow it, as the last path, and `off` never. The screen
// probes every listener at once and takes the first path that answers in
// the order lan, wan, relay, waiting for a higher path only until its
// probe's timeout, so the relay carries media only when no direct path
// works; it tells the Hub (`network`), and its own stream requests name the
// path, so the node prepares the next stream there.
//
// - "Play over the home network" in settings governs `lan` per screen
//   (Agent Note 2026-10-12-lan-direct-play). Until the owner turns it on, the
//   screen never probes the LAN, so the browser's Local Network Access
//   prompt appears when the owner expects it; a browser that already granted
//   the permission counts as on until the owner turns it off. Automatic
//   probes never fetch while the permission is denied, nor while it is
//   still to be asked on a screen that never reached the node.
// - `wan` resolves to a public address: no permission and no switch.
//   Without a domain it is the home's public address itself, and a screen
//   at home reaches it only where the router loops back to its own address
//   (NAT loopback, "hairpin"). The Hub marks the `wan` entry `home: true`
//   for a screen that connects from the home's address; that screen's
//   `wan` probe answers whether the router loops back (`hairpin`: "ok" or
//   "failed"), in its `media_probe` events and its `network` reports.
// - Probes run on the welcome, on the Hub's `media` message (the paths
//   changed: a new home address), on the browser's `online` event, when the
//   owner turns the switch on or asks again, and 30 seconds after a stream
//   failed on its path.
// - A stream that fails on its path moves the screen down the order at once
//   (`failed()`): the recovery that follows asks for the next path at the
//   same position. A stream that plays never moves up; the next one takes
//   the best path.
// - Telemetry: `media_probe` for each probe (outcome, trigger, time, the LAN
//   permission), `media_path` for each change of path with every probe's
//   outcome, and `media_path_fallback` for each move down.

export const PATH_ORDER = Object.freeze(["lan", "wan", "relay"]);
const RELAY_MODES = Object.freeze(["auto", "on", "off"]);
export const LAN_CHOICE_KEY = "yolo.lan";
const LAN_REACHED_KEY = "yolo.lan.reached";
export const PROBE_TIMEOUT_MS = Object.freeze({ lan: 2_000, wan: 5_000 });
// The owner's own probe may wait behind the browser's permission prompt.
export const PROMPT_PROBE_TIMEOUT_MS = 60_000;
export const REPROBE_AFTER_FAILURE_MS = 30_000;

/** Chrome's Local Network Access permission ("local-network" since 145), or null where the browser has none. */
export async function localNetworkPermission(nav = globalThis.navigator) {
  for (const name of ["local-network", "local-network-access"]) {
    try {
      const status = await nav?.permissions?.query({ name });
      if (status?.state) return status.state;
    } catch {
      // Not a permission this browser knows.
    }
  }
  return null;
}

// Why a probe that threw failed. A timeout is no answer at all (another
// network, a firewall, a router that does not forward the port). On the LAN
// a quick failure with the permission granted and a valid certificate means
// the name did not reach the node, usually because the router's DNS
// rebinding protection dropped its private answer.
// What a probe at the home's own address says about the router's loopback.
const hairpinOf = (outcome) => (outcome === "ok" ? "ok" : outcome === "timeout" || outcome === "failed" ? "failed" : null);

export function probeFailure(error, { path = "lan", permission, notAfter, now }) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  if (notAfter && notAfter <= now) return "certificate";
  if (path !== "lan") return "failed";
  if (permission === "denied") return "permission_denied";
  if (permission === "prompt") return "permission_prompt";
  return "dns_rebinding";
}

const storageOf = (win) => ({
  get: (key) => {
    try {
      return win.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      win.localStorage?.setItem(key, value);
    } catch {
      // Private mode: this page only.
    }
  },
});

/**
 * @param {object} options
 * @param {(message: object) => boolean} options.send  the realtime channel's send
 * @param {(type: string, fields: object) => void} [options.record]  device telemetry
 * @param {() => void} [options.onChange]  the path or a probe changed
 */
export function createMediaPaths({
  send,
  record = () => {},
  onChange = () => {},
  win = globalThis,
  fetchImpl = (...args) => globalThis.fetch(...args),
  permission = () => localNetworkPermission(win.navigator),
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
}) {
  const store = storageOf(win);
  let choice = store.get(LAN_CHOICE_KEY);
  let reached = store.get(LAN_REACHED_KEY) === "1";
  // The welcome's listeners and relay mode; null until the first welcome.
  let listeners = { lan: null, wan: null };
  let relayMode = "auto";
  let relay = true;
  // False on an instance without a domain: no LAN path can exist.
  let domain = true;
  let current = null;
  let decided = false;
  // The latest probe of each listener, and the paths that failed since.
  const probes = { lan: null, wan: null };
  const failed = new Set();
  let lastPermission = null;
  let round = null;
  let roundResult = Promise.resolve();
  let retryTimer = null;

  const emit = (type, fields) => {
    try {
      record(type, fields);
    } catch {
      // Telemetry never breaks playback.
    }
  };

  const outcomes = () => Object.fromEntries(Object.entries(probes).filter(([path, probe]) => probe && listeners[path]).map(([path, probe]) => [path, failed.has(path) ? "failed" : probe.outcome]));

  // Tell the Hub when the path changes, and once per welcome, which may
  // follow a reconnect that the Hub saw with an older answer.
  function settle(next, reason, { announce = false } = {}) {
    const from = current;
    const changed = next !== current || !decided;
    current = next;
    decided = true;
    const probeOutcomes = outcomes();
    const hairpin = listeners.wan?.home ? probes.wan?.hairpin ?? null : null;
    if (changed || announce) send({ type: "network", path: next, reason, probes: probeOutcomes, ...(hairpin ? { hairpin } : {}) });
    if (changed) {
      emit("media_path", { path: next, from, reason, probes: probeOutcomes });
      onChange();
    }
  }

  async function lanEnabled() {
    if (choice === "on") return true;
    if (choice === "off") return false;
    lastPermission = await permission();
    return lastPermission === "granted";
  }

  async function probeOne(path, trigger, { owner }) {
    const target = listeners[path];
    const startedAt = now();
    let outcome;
    if (path === "lan") {
      lastPermission = await permission();
      if (!owner && (lastPermission === "denied" || (lastPermission === "prompt" && !reached))) {
        outcome = lastPermission === "denied" ? "permission_denied" : "permission_prompt";
      }
    }
    if (!outcome) {
      try {
        const response = await fetchImpl(`${target.origin}/edge/probe`, {
          cache: "no-store", credentials: "omit", mode: "cors",
          signal: AbortSignal.timeout(owner && path === "lan" ? PROMPT_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS[path]),
        });
        const body = response.ok ? await response.json().catch(() => null) : null;
        outcome = body?.ok === true ? "ok" : `http_${response.status}`;
      } catch (error) {
        if (path === "lan") lastPermission = await permission();
        outcome = probeFailure(error, { path, permission: lastPermission, notAfter: target.notAfter, now: now() });
      }
    }
    if (listeners[path]?.origin !== target.origin) return null;
    if (path === "lan" && outcome === "ok" && !reached) {
      reached = true;
      store.set(LAN_REACHED_KEY, "1");
    }
    const home = path === "wan" && target.home === true;
    probes[path] = { outcome, trigger, at: now(), elapsedMs: now() - startedAt, permission: path === "lan" ? lastPermission : null, hairpin: home ? hairpinOf(outcome) : null };
    emit("media_probe", {
      path, outcome, trigger, elapsedMs: probes[path].elapsedMs, permission: probes[path].permission, host: new URL(target.origin).host,
      ...(home ? { home: true, hairpin: probes[path].hairpin } : {}),
    });
    return outcome;
  }

  // One round: every candidate at once; the first in order that answers.
  async function runRound(trigger, { owner }) {
    failed.clear();
    const lanOn = listeners.lan && (owner || (await lanEnabled()));
    if (listeners.lan && !lanOn) probes.lan = { outcome: "off", trigger, at: now(), elapsedMs: 0, permission: lastPermission };
    const started = {
      lan: lanOn ? probeOne("lan", trigger, { owner }) : null,
      wan: listeners.wan ? probeOne("wan", trigger, { owner: false }) : null,
    };
    let chosen = null;
    for (const path of ["lan", "wan"]) {
      if (started[path] && (await started[path]) === "ok") {
        chosen = path;
        break;
      }
    }
    if (!chosen && relay) chosen = "relay";
    settle(chosen, "probe", { announce: trigger === "welcome" });
    // The rest finish for telemetry and the settings sheet.
    void Promise.allSettled(Object.values(started).filter(Boolean)).then(() => onChange());
  }

  function probe(trigger, { owner = false } = {}) {
    round ??= runRound(trigger, { owner }).finally(() => {
      round = null;
    });
    roundResult = round;
    return round.then(() => probes.lan ?? null);
  }

  // The path below `path` that the last probes found working.
  function below(path) {
    for (const next of PATH_ORDER.slice(PATH_ORDER.indexOf(path) + 1)) {
      if (next === "relay") return relay ? "relay" : null;
      if (listeners[next] && probes[next]?.outcome === "ok" && !failed.has(next)) return next;
    }
    return null;
  }

  return {
    /** The path the next stream should take: "lan", "wan", "relay", or null for none. */
    network: () => current,

    /** Resolves once the probes in flight (after a welcome) have chosen a path. */
    settled: () => roundResult.catch(() => {}),

    // The welcome, or the Hub's `media` message (`trigger` "paths"): `media`
    // ({ paths, relay, relayMode }; `relay` alone from a control plane
    // before the modes), or only `lan` from one before 0.5, which always
    // relays.
    setPaths(welcome = {}, trigger = "welcome") {
      const media = welcome.media ?? { paths: welcome.lan?.origin ? [{ path: "lan", ...welcome.lan }] : [], relay: true };
      const next = { lan: null, wan: null };
      for (const entry of media.paths || []) {
        if ((entry.path === "lan" || entry.path === "wan") && typeof entry.origin === "string") {
          next[entry.path] = { origin: entry.origin, notAfter: Number(entry.notAfter) || null, home: entry.path === "wan" && entry.home === true };
        }
      }
      for (const path of ["lan", "wan"]) if (next[path]?.origin !== listeners[path]?.origin) probes[path] = null;
      listeners = next;
      relayMode = RELAY_MODES.includes(media.relayMode) ? media.relayMode : media.relay === false ? "off" : "on";
      relay = relayMode !== "off";
      domain = media.domain !== false;
      return probe(trigger);
    },

    probe,

    // The owner changed the relay's mode from this screen: choose again
    // now, before the Hub's `media` message says the same.
    setRelayMode(mode) {
      if (!RELAY_MODES.includes(mode)) return roundResult.catch(() => {});
      relayMode = mode;
      relay = mode !== "off";
      return probe("settings");
    },

    // The owner's LAN switch for this screen. Turning it on probes at once,
    // which may show the browser's permission prompt.
    async setEnabled(on) {
      choice = on ? "on" : "off";
      store.set(LAN_CHOICE_KEY, choice);
      onChange();
      return probe("settings", { owner: on });
    },

    /** Whether a stream on `path` has a path below it to fall back to. */
    canFallBack: (path) => below(path) !== null,

    // A stream failed on `path`: the next path down, from now on, until a
    // probe 30 seconds later. Returns that path, or null.
    failed(error, { position = null, path = current } = {}) {
      if (path !== "relay") failed.add(path);
      const next = below(path);
      emit("media_path_fallback", { from: path, to: next, code: error?.code || null, message: String(error?.message || error || "").slice(0, 200), position });
      settle(next, "media_error");
      clearTimer(retryTimer);
      retryTimer = setTimer(() => {
        retryTimer = null;
        void probe("after_failure");
      }, REPROBE_AFTER_FAILURE_MS);
      return next;
    },

    status: () => ({
      choice,
      enabled: choice === "on" || (choice !== "off" && lastPermission === "granted"),
      origin: listeners.lan?.origin ?? null,
      remoteOrigin: listeners.wan?.origin ?? null,
      relay,
      relayMode,
      network: current,
      permission: lastPermission,
      last: probes.lan,
      probes: { ...probes },
      domain,
      // At the home's own address: whether the router loops back to it.
      home: Boolean(listeners.wan?.home),
      hairpin: listeners.wan?.home ? probes.wan?.hairpin ?? null : null,
    }),
  };
}
