// A press made before the page's welcome (Agent Note
// 2026-10-11-yolo-web-client): a tap on an item, or one of the
// now-playing bar's buttons. Until Yolo's Hub has welcomed the page,
// where it plays or what it controls is not known, so it waits. Only the
// latest press of a kind waits: one made while another waits takes its
// place, so a tap repeated out of impatience plays once. A press runs at
// most once, when the welcome comes, and is dropped when the wait fails
// (the channel stopped, or did not come back in time).

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
     * whichever way (the press's own sign of waiting goes then).
     * Resolves with what `action` returns, or undefined when it never runs.
     */
    later(action, { onEnd = null } = {}) {
      const previous = latest;
      const mine = { onEnd };
      latest = mine;
      previous?.onEnd?.();
      return welcomed().then(
        () => (settle(mine) ? action() : undefined),
        () => {
          settle(mine);
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
