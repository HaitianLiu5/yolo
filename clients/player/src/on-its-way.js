// A stream on its way to this screen: the loading screen shows before
// Yolo's `load` (a start's resume, a tap on home, Continue here), with no
// picture yet and so none of the player's controls. /play stands over the
// screen it opened from, so Back, the browser's or a TV remote's, goes back
// there instead of out of Yolo; on 2026-11-08 a car that woke into its
// last item's slow load had no way home. Leaving it leaves the stream, as
// Back from the player does (main.js): what Yolo resumed waits in the
// now-playing bar, and the `load` of a request already sent is left, not
// played.

// A `load` comes before its request's answer; one that comes this long
// after is not the left request's. While the request is pending (it may
// wait for a welcome, then for the node to prepare), its `load` may come.
const GRACE_MS = 3_000;

/**
 * @param {object} options
 * @param {(path: string) => boolean} options.navigate  pushes a route (router.js)
 * @param {() => { view: string }} options.parseRoute
 * @param {() => void} [options.back]  history.back()
 */
export function createOnItsWay({
  navigate, parseRoute, back = () => history.back(), setTimer = (task, ms) => setTimeout(task, ms),
}) {
  // { resume: { sessionId, position } | null, request, pushed }
  let current = null;
  // The left request's `load`, until it comes or can no longer come: a token.
  let left = null;
  // Every request whose loading screen the owner left.
  const leftRequests = new WeakSet();

  return {
    /** The loading screen of a stream on its way: `resume` names Yolo's session it resumes. */
    start(resume = null) {
      left = null;
      const pushed = parseRoute().view !== "player" && navigate("/play");
      current = { resume, request: null, pushed: Boolean(pushed || current?.pushed) };
    },
    /** The request whose `load` is awaited was sent. */
    sent(request) {
      if (current) current.request = request;
    },
    get waiting() {
      return current !== null;
    },
    /** Its `load` arrived, or the request failed and says so on screen; `request`: only if it is still that one's. */
    arrived(request) {
      if (!request || current?.request === request) current = null;
    },
    /** True when the owner left the loading screen of `request`. */
    leftFrom(request) {
      return Boolean(request) && leftRequests.has(request);
    },
    /** Nothing comes after all: back to the screen it opened from. True when it went back. */
    drop() {
      const mine = current;
      current = null;
      if (!mine?.pushed || parseRoute().view !== "player") return false;
      back();
      return true;
    },
    /** The owner left the loading screen: what was on its way, or null. */
    leave() {
      const mine = current;
      current = null;
      if (!mine) return null;
      if (mine.request) {
        leftRequests.add(mine.request);
        const token = {};
        left = token;
        const settle = () => setTimer(() => {
          if (left === token) left = null;
        }, GRACE_MS);
        Promise.resolve(mine.request).then(settle, settle);
      }
      return mine;
    },
    /** A `load` arrived with nothing on screen: true when it is the left request's, once. */
    takeLeft() {
      const mine = left;
      left = null;
      return Boolean(mine);
    },
  };
}
