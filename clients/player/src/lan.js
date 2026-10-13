// LAN direct play on this screen (Agent Note 2026-10-12-lan-direct-play).
// The Hub's welcome names the node's LAN origin; this screen probes it and
// tells the Hub whether it reaches it (`network`), and its own stream
// requests say so too, so the node prepares the next stream on that path.
//
// - "Play over the home network" in settings is per screen. Until the owner
//   turns it on, the screen never probes, so the browser's Local Network
//   Access prompt appears when the owner expects it; a browser that already
//   granted the permission counts as on until the owner turns it off.
// - Probes: on the welcome, on the browser's `online` event, when the owner
//   turns it on or asks again in settings, and 30 seconds after a LAN stream
//   failed. Automatic probes never fetch while the permission is denied, nor
//   while it is still to be asked on a screen that never reached the node,
//   so no prompt appears by itself. (A browser may keep saying "prompt"
//   although it lets the probe through; once one went through, it counts.)
// - A LAN stream that fails turns the path off at once: the recovery that
//   follows asks for the tunnel at the same position.
// - Each probe is a `lan_probe` device event: its outcome (ok, timeout,
//   permission_denied, permission_prompt, certificate, dns_rebinding,
//   http_<status>), the permission state, and how long it took.

export const LAN_CHOICE_KEY = "yolo.lan";
const LAN_REACHED_KEY = "yolo.lan.reached";
export const PROBE_TIMEOUT_MS = 2_000;
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
// network, a firewall); a quick failure with the permission granted and a
// valid certificate means the name did not reach the node, usually because
// the router's DNS rebinding protection dropped its private answer.
export function probeFailure(error, { permission, notAfter, now }) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  if (permission === "denied") return "permission_denied";
  if (permission === "prompt") return "permission_prompt";
  if (notAfter && notAfter <= now) return "certificate";
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
 * @param {() => void} [options.onChange]  the path or the last probe changed
 */
export function createLan({
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
  let lan = null;
  let reachable = false;
  let last = null;
  let lastPermission = null;
  let probing = null;
  let retryTimer = null;

  const emit = (type, fields) => {
    try {
      record(type, fields);
    } catch {
      // Telemetry never breaks playback.
    }
  };

  // Tell the Hub when the answer changes, and once per welcome, which may
  // follow a reconnect that the Hub saw with an older answer.
  function settle(next, reason, { announce = false } = {}) {
    const changed = next !== reachable;
    reachable = next;
    if (changed || announce) send({ type: "network", lan: next, reason });
    if (changed) onChange();
  }

  async function enabled() {
    if (choice === "on") return true;
    if (choice === "off") return false;
    lastPermission = await permission();
    return lastPermission === "granted";
  }

  async function run(trigger, { owner }) {
    const startedAt = now();
    const origin = lan.origin;
    lastPermission = await permission();
    let outcome;
    if (!owner && (lastPermission === "denied" || (lastPermission === "prompt" && !reached))) {
      outcome = lastPermission === "denied" ? "permission_denied" : "permission_prompt";
    } else {
      try {
        const response = await fetchImpl(`${origin}/lan/probe`, {
          cache: "no-store", credentials: "omit", mode: "cors", signal: AbortSignal.timeout(owner ? PROMPT_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS),
        });
        outcome = response.ok ? "ok" : `http_${response.status}`;
      } catch (error) {
        lastPermission = await permission();
        outcome = probeFailure(error, { permission: lastPermission, notAfter: lan?.notAfter, now: now() });
      }
    }
    if (lan?.origin !== origin) return last;
    if (outcome === "ok" && !reached) {
      reached = true;
      store.set(LAN_REACHED_KEY, "1");
    }
    last = { outcome, trigger, at: now(), elapsedMs: now() - startedAt, permission: lastPermission };
    emit("lan_probe", { outcome, trigger, elapsedMs: last.elapsedMs, permission: lastPermission, host: new URL(origin).host });
    settle(outcome === "ok", outcome, { announce: trigger === "welcome" });
    onChange();
    return last;
  }

  async function probe(trigger, { owner = false } = {}) {
    if (!lan?.origin) {
      settle(false, "no_origin", { announce: trigger === "welcome" });
      return null;
    }
    if (!owner && !(await enabled())) {
      settle(false, "off", { announce: trigger === "welcome" });
      return null;
    }
    probing ??= run(trigger, { owner }).finally(() => {
      probing = null;
    });
    return probing;
  }

  return {
    /** "lan" when the next stream should come from the node's LAN origin. */
    network: () => (reachable && lan?.origin && choice !== "off" ? "lan" : "tunnel"),

    // The welcome's `lan`: { origin, notAfter } or null.
    setOrigin(next) {
      const origin = typeof next?.origin === "string" ? next.origin : null;
      if (origin !== lan?.origin) reachable = false;
      lan = origin ? { origin, notAfter: Number(next.notAfter) || null } : null;
      return probe("welcome");
    },

    probe,

    // The owner's switch for this screen. Turning it on probes at once,
    // which may show the browser's permission prompt.
    async setEnabled(on) {
      choice = on ? "on" : "off";
      store.set(LAN_CHOICE_KEY, choice);
      onChange();
      if (on) return probe("settings", { owner: true });
      settle(false, "off");
      return null;
    },

    // A LAN stream failed: the tunnel from now on, until a probe says the
    // LAN works again.
    failed(error, { position = null } = {}) {
      emit("lan_fallback", { code: error?.code || null, message: String(error?.message || error || "").slice(0, 200), position });
      settle(false, "media_error");
      clearTimer(retryTimer);
      retryTimer = setTimer(() => {
        retryTimer = null;
        void probe("after_failure");
      }, REPROBE_AFTER_FAILURE_MS);
    },

    status: () => ({
      choice,
      enabled: choice === "on" || (choice !== "off" && lastPermission === "granted"),
      origin: lan?.origin ?? null,
      network: reachable && lan?.origin && choice !== "off" ? "lan" : "tunnel",
      permission: lastPermission,
      last,
    }),
  };
}
