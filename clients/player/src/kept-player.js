import { firstVariantUri } from "./engine/native-video-player.js";

// The player kept behind the home screen after Back
// (Agent Note 2026-10-11-yolo-owns-progress-and-resume), as YouTube keeps a
// video in its miniplayer. Back pauses and hides the player but keeps the
// engine, what it decoded and buffered, and the node's session; the
// now-playing bar shows the same player again and it goes on in place, with
// no new stream. Only one video plays at a time, so nothing releases the kept
// player with time or memory: only another stream on this screen, a stop, a
// move to another device, or the page going away does (keptReleaseReason).
// A hidden player does no decoding, drawing, or network work (the engines'
// suspend()). Released, it goes the way Back went before: Yolo's Hub stops
// the node's session, and the bar plays the item with a new stream at the
// saved position.

/**
 * Hidden at least this long, the player asks the node whether its stream
 * still answers before it goes on: the node may have ended the session (a
 * restart, two idle hours, a media token past its life), and Plex reclaims a
 * transcode idle for 180 seconds (Agent Note 2026-09-10-plex-session-recovery).
 */
const KEPT_CHECK_AFTER_MS = 60_000;

const PROBE_TIMEOUT_MS = 3_000;

/**
 * Why the kept player has to go now, or null while it stays.
 *
 * @param {{ sessionId: string } | null} kept
 * @param {object} event  what happened:
 *   - `{ type: "load" }` a new stream on this screen: another item, a
 *     transfer to it, or a track change that rebuilt the stream
 *   - `{ type: "stop" }` the owner or an agent stopped playback
 *   - `{ type: "deactivate" }` playback moved to another device, or another
 *     window of this screen took over
 *   - `{ type: "unload" }` the page goes away (not into the back-forward cache)
 *   - `{ type: "state", hub, self }` the Hub's playback state, from a
 *     broadcast or the welcome after a reconnect; `self` is this device
 * @returns {"another_stream" | "stopped" | "moved" | "unload" | null}
 */
function keptReleaseReason(kept, event) {
  if (!kept) return null;
  switch (event?.type) {
    case "load":
      return "another_stream";
    case "stop":
      return "stopped";
    case "deactivate":
      return "moved";
    case "unload":
      return "unload";
    case "state": {
      const hub = event.hub;
      if (!hub?.item || !hub.sessionId || hub.status === "idle") return "stopped";
      if (hub.deviceId !== event.self) return "moved";
      if (hub.sessionId !== kept.sessionId) return "another_stream";
      return null;
    }
    default:
      return null;
  }
}

/**
 * How the kept player goes on when it is shown again, decided at once inside
 * the tap: `resume` in place; `check` the node first (hidden a while); or
 * `rebuild`, a new stream of the same item at the same position through the
 * player's recovery, because this one cannot go on: its engine failed while
 * hidden, or the screen no longer takes the path its stream came by.
 *
 * @param {{ keptAt: number, position: number, seekTo?: number | null, network?: string | null, failed?: unknown }} kept
 * @param {{ now: number, path?: string | null, checkAfterMs?: number }} options
 *   `path` is the media path the screen takes now (media-paths.js), null
 *   when it has not found one
 * @returns {{ action: "resume" | "check", startTime: number }
 *   | { action: "rebuild", startTime: number, why: "failed" | "path" }}
 */
export function reopenPlan(kept, { now, path = null, checkAfterMs = KEPT_CHECK_AFTER_MS }) {
  const startTime = Number.isFinite(kept?.seekTo) ? kept.seekTo : Math.max(0, Number(kept?.position) || 0);
  if (kept?.failed) return { action: "rebuild", startTime, why: "failed" };
  // The stream came from the node's LAN or remote listener, and the screen
  // no longer takes that path (it left home, the address changed): its URLs
  // would not answer. A relayed stream goes through the Worker from anywhere.
  const network = kept?.network ?? null;
  if (path && (network === "lan" || network === "wan") && path !== network) return { action: "rebuild", startTime, why: "path" };
  if (now - (Number(kept?.keptAt) || 0) < checkAfterMs) return { action: "resume", startTime };
  return { action: "check", startTime };
}

/**
 * reopenPlan, with the node asked when the plan says so: a stream that
 * answers 410 ended while hidden, and is rebuilt at the same position.
 *
 * @param {object} kept  as for reopenPlan
 * @param {{ now: number, path?: string | null, probe: () => Promise<"alive" | "expired" | "unknown">, checkAfterMs?: number }} options
 */
export async function planReopen(kept, { probe, ...options }) {
  const plan = reopenPlan(kept, options);
  if (plan.action !== "check") return plan;
  return (await probe()) === "expired"
    ? { action: "rebuild", startTime: plan.startTime, why: "session_expired" }
    : { action: "resume", startTime: plan.startTime };
}

const isPlaylist = (url) => /\.m3u8(?:[?#]|$)/i.test(url);

/**
 * Whether the node still serves a stream: "expired" when it answers 410
 * (the session, or its media token, ended), "alive" when it serves it, and
 * "unknown" when it could not be asked. A master playlist comes from what
 * the node holds, so for HLS its first variant, which the node asks the
 * source for, answers too: a transcode the source dropped is a 410 there.
 */
export async function probeStreamSession(url, { fetchFn = (...args) => globalThis.fetch(...args), timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const ask = async (target, method) => {
    try {
      const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
      return await fetchFn(target, { method, cache: "no-store", signal });
    } catch {
      return null;
    }
  };
  if (!url) return "unknown";
  if (!isPlaylist(url)) {
    const response = await ask(url, "HEAD");
    if (!response) return "unknown";
    return response.status === 410 ? "expired" : response.ok ? "alive" : "unknown";
  }
  const master = await ask(url, "GET");
  if (!master) return "unknown";
  if (master.status === 410) return "expired";
  if (!master.ok) return "unknown";
  const variant = firstVariantUri(await master.text().catch(() => ""));
  if (!variant) return "alive";
  const response = await ask(new URL(variant, url).href, "HEAD");
  if (!response) return "unknown";
  return response.status === 410 ? "expired" : "alive";
}

/**
 * The one player this screen keeps. player.js holds the engine and its
 * picture in the record; this decides when it goes.
 *
 * @param {object} options
 * @param {() => number} [options.now]  the clock, in ms
 * @param {(record: object, how: { keep: boolean }) => void} options.report
 *   tells the Hub: `idle` with `keep` while kept, so the node's session
 *   goes on; plain `idle` when the page lets it go, so the Hub stops it
 * @param {(record: object, reason: string) => void} options.dispose
 *   destroys the engine and drops its picture
 */
export function createKeptPlayer({ now = () => Date.now(), report, dispose }) {
  let record = null;

  function release(reason) {
    const released = record;
    if (!released) return null;
    record = null;
    // Another stream, a stop, or a move: Yolo's Hub replaced or stopped the
    // session itself, and this screen is no longer the one it listens to.
    // Only a page that goes away still has to tell it.
    if (reason === "unload") report(released, { keep: false });
    dispose(released, reason);
    return reason;
  }

  return {
    /** The record while a player is kept, else null. */
    get current() {
      return record;
    },

    /** Back: keep this player; the Hub hears `idle` with `keep`. */
    keep(entry) {
      if (record) release("another_stream");
      record = { ...entry, keptAt: now(), seekTo: null, failed: null };
      report(record, { keep: true });
      return record;
    },

    /** Asked again (a pause, a welcome): the Hub hears that it is still kept. */
    remind() {
      if (record) report(record, { keep: true });
    },

    /** A seek while hidden (an agent's, the bar's): it goes on there. */
    seek(position) {
      const target = Number(position);
      if (!record || !Number.isFinite(target)) return;
      const duration = Number(record.duration) || 0;
      record.seekTo = Math.max(0, duration > 0 ? Math.min(duration, target) : target);
    },

    /** The engine failed while hidden: shown again, it rebuilds. */
    fail(player, error) {
      if (record?.player === player) record.failed = error || true;
    },

    /** What happened; releases the player when a rule says so. */
    note(event) {
      const reason = keptReleaseReason(record, event);
      return reason ? release(reason) : null;
    },

    release,

    /** Shown again: the caller owns the player from here. */
    take() {
      const taken = record;
      record = null;
      return taken;
    },
  };
}
