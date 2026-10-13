// This screen's media path (Agent Note 2026-10-13-media-off-the-worker). The
// Hub's welcome lists the node's listeners a device may use (`lan`, `wan`)
// and whether the relay through the Worker is on. The screen probes every
// listener at once and takes the first path that answers in the order lan,
// wan, relay, waiting for a higher path only until its probe's timeout; it
// tells the Hub (`network`), and its own stream requests name the path, so
// the node prepares the next stream there.
//
// - "Play over the home network" in settings governs `lan` per screen
//   (Agent Note 2026-10-12-lan-direct-play). Until the owner turns it on, the
//   screen never probes the LAN, so the browser's Local Network Access
//   prompt appears when the owner expects it; a browser that already granted
//   the permission counts as on until the owner turns it off. Automatic
//   probes never fetch while the permission is denied, nor while it is
//   still to be asked on a screen that never reached the node.
// - `wan` resolves to a public address: no permission and no switch.
// - Probes run on the welcome, on the browser's `online` event, when the
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
  // The welcome's listeners and relay; null until the first welcome.
  let listeners = { lan: null, wan: null };
  let relay = true;
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
    if (changed || announce) send({ type: "network", path: next, reason, probes: probeOutcomes });
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
    probes[path] = { outcome, trigger, at: now(), elapsedMs: now() - startedAt, permission: path === "lan" ? lastPermission : null };
    emit("media_probe", { path, outcome, trigger, elapsedMs: probes[path].elapsedMs, permission: probes[path].permission, host: new URL(target.origin).host });
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

    // The welcome: `media` ({ paths, relay }), or only `lan` from a control
    // plane before 0.5, which always relays.
    setPaths(welcome = {}) {
      const media = welcome.media ?? { paths: welcome.lan?.origin ? [{ path: "lan", ...welcome.lan }] : [], relay: true };
      const next = { lan: null, wan: null };
      for (const entry of media.paths || []) {
        if ((entry.path === "lan" || entry.path === "wan") && typeof entry.origin === "string") next[entry.path] = { origin: entry.origin, notAfter: Number(entry.notAfter) || null };
      }
      for (const path of ["lan", "wan"]) if (next[path]?.origin !== listeners[path]?.origin) probes[path] = null;
      listeners = next;
      relay = media.relay !== false;
      return probe("welcome");
    },

    probe,

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
      network: current,
      permission: lastPermission,
      last: probes.lan,
      probes: { ...probes },
    }),
  };
}
