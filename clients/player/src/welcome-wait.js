// A press made before the page's welcome (Agent Note
// 2026-10-11-yolo-web-client): a tap on an item, or one of the
// now-playing bar's buttons. Until Yolo's Hub has welcomed the page,
// where it plays or what it controls is not known, so it waits. Only the
// latest press of a kind waits: one made while another waits takes its
// place, so a tap repeated out of impatience plays once. A press runs at
// most once, when the welcome comes, and is dropped when the wait fails
// (the channel stopped, the screen pairs again, or no welcome came within
// realtime.js's wait).

import { t } from "./i18n.js";

// A press whose wait ran out (no welcome within realtime.js's wait, not a
// stop or a new pairing) says so in the home screen's one-line notice: it
// did nothing.
export const WAIT_TIMED_OUT = t("Yolo did not answer in time. Try again.");
export const waitTimedOut = (error) => error?.code === "realtime_unavailable";

/**
 * @param {() => Promise<void>} welcomed  resolves once the page is welcomed
 *   (main.js), rejects when that will not happen
 */
export function createWelcomeWait(welcomed) {
  let latest = null;

  function settle(mine) {
    if (latest !== mine) return false;
    latest = null;
    mine.onEnd?.();
    return true;
  }

  return {
    /** True while a press waits. */
    get waiting() {
      return latest !== null;
    },

    /**
     * Runs `action` once the page is welcomed, unless a later press takes
     * its place or the wait fails. `onEnd` runs when it stops waiting,
     * whichever way (the press's own sign of waiting goes then); `onFail`
     * with the wait's error when it failed while this press still waited.
     * Resolves with what `action` returns, or undefined when it never runs.
     */
    later(action, { onEnd = null, onFail = null } = {}) {
      const previous = latest;
      const mine = { onEnd };
      latest = mine;
      previous?.onEnd?.();
      return welcomed().then(
        () => (settle(mine) ? action() : undefined),
        (error) => {
          if (settle(mine)) onFail?.(error);
          return undefined;
        },
      );
    },

    /** The press that waits goes without running (the screen pairs again). */
    drop() {
      if (latest) settle(latest);
    },
  };
}
