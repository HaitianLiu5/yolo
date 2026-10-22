// The quiet mark for a realtime channel that is down (Agent Note
// 2026-10-11-yolo-web-client). A screen shows what it has, from its cache or
// from before the drop, and says nothing while the channel connects or
// reconnects: most drops last a moment (a wake, a tunnel, a new network).
// Only a channel down for QUIET_AFTER_MS shows the mark, and it goes as
// soon as the Hub welcomes the screen again.

export const QUIET_AFTER_MS = 4_000;

/**
 * @param {object} options
 * @param {() => void} options.show  shows the mark
 * @param {() => void} options.hide  hides it
 * @returns {{ status(status: "online" | "connecting" | "offline"): void, reset(): void }}
 */
export function createConnectionIndicator({ show, hide }) {
  let timer = null;
  let shown = false;

  function reset() {
    clearTimeout(timer);
    timer = null;
    if (shown) hide();
    shown = false;
  }

  return {
    // realtime.js's onStatus: "online" once welcomed, else down.
    status(status) {
      if (status === "online") {
        reset();
        return;
      }
      if (shown || timer) return;
      timer = setTimeout(() => {
        timer = null;
        shown = true;
        show();
      }, QUIET_AFTER_MS);
    },
    // The channel stopped on purpose (the screen pairs again).
    reset,
  };
}
