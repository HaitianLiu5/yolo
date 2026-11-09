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

const keyOf = (source) => (source?.plugin && source.id != null ? `${source.plugin}:${source.id}` : null);

/**
 * Whether a `load`'s item is what a request asked for (`wants`): a claimed
 * source, or an item id (`<source id>:<item id>`, a source's key). A
 * request whose item is not known before Yolo answers (a link, or a queue
 * entry's link no source plugin claimed yet) takes any `load`. An item Yolo
 * found again under a new id is known by the id it was asked for
 * (`movedFrom`, Agent Note 2026-10-21-moved-library-items).
 */
export function asksFor(wants, item, movedFrom = null) {
  const wanted = knownKey(wants);
  if (!wanted) return true;
  return keyOf(item?.source) === wanted || movedFrom === wanted;
}

const knownKey = (wants) => keyOf(wants?.source) ?? wants?.itemId ?? null;

/**
 * @param {object} options
 * @param {(path: string) => boolean} options.navigate  pushes a route (router.js)
 * @param {() => { view: string }} options.parseRoute
 * @param {() => void} [options.back]  history.back()
 */
export function createOnItsWay({
  navigate, parseRoute, back = () => history.back(), setTimer = (task, ms) => setTimeout(task, ms),
}) {
  // { resume: { sessionId, position } | null, wants, request, pushed }
  let current = null;
  // The left requests whose `load` may still come: { wants }, each until
  // its `load` comes or a moment after its request settles.
  const pending = new Set();
  // Every request whose loading screen the owner left.
  const leftRequests = new WeakSet();

  return {
    /**
     * The loading screen of a stream on its way: `resume` names Yolo's
     * session it resumes, `wants` what it asked for (asksFor()).
     */
    start({ resume = null, wants = null } = {}) {
      const pushed = parseRoute().view !== "player" && navigate("/play");
      current = { resume, wants, request: null, pushed: Boolean(pushed || current?.pushed) };
    },
    /** The request whose `load` is awaited was sent. */
    sent(request) {
      if (current) current.request = request;
    },
    get waiting() {
      return current !== null;
    },
    /** True when the loading screen awaits a request known to ask for `item`. */
    awaits(item, movedFrom = null) {
      return Boolean(current) && knownKey(current.wants) !== null && asksFor(current.wants, item, movedFrom);
    },
    /** True while the loading screen awaits `request`'s `load`. */
    waitingFor(request) {
      return Boolean(request) && current?.request === request;
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
        const entry = { wants: mine.wants };
        pending.add(entry);
        const settle = () => setTimer(() => pending.delete(entry), GRACE_MS);
        Promise.resolve(mine.request).then(settle, settle);
      }
      return mine;
    },
    /**
     * A `load` of `item` (asked for as `movedFrom`, when Yolo found it under
     * a new id) arrived with nothing on screen: true when it is a left
     * request's, once.
     */
    takeLeft(item, movedFrom = null) {
      for (const entry of pending) {
        // While another press waits, a left request whose item is not known
        // cannot tell its `load` from that press's: the newer press wins.
        if (current && knownKey(entry.wants) === null) continue;
        if (!asksFor(entry.wants, item, movedFrom)) continue;
        pending.delete(entry);
        return true;
      }
      return false;
    },
  };
}
