import { sourceKey, toYoloError } from "@useyolo/core";

// Timed comments (danmaku) per item on the node (Agent Note 2026-10-13-danmaku).
// A source's `comments` answers with comments and the span they cover; this
// store keeps those answers for the most recent items and serves any range
// from them, to the media session (`/m/{token}/comments`) and to the control
// plane (`/internal/v1/comments`). It asks the source one window of
// WINDOW_SECONDS at a time, at most once at a time per window, and an answer
// may cover more (a whole item). A window that failed is asked again only
// after RETRY_MS. Memory is bounded by a count of comments over all items:
// the least recently used item goes first.

export const WINDOW_SECONDS = 360;
// Longer ranges are cut to this: the device asks for one window or two, an
// agent for a minute around a moment.
export const MAX_RANGE_SECONDS = 2 * WINDOW_SECONDS;
const MAX_ITEMS = 16;
const MAX_TOTAL_COMMENTS = 200_000;
const RETRY_MS = 60_000;

function firstAtOrAfter(comments, time) {
  let low = 0;
  let high = comments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (comments[middle].t < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function merge(left, right) {
  if (!left.length) return right;
  if (!right.length) return left;
  const out = new Array(left.length + right.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < left.length && j < right.length) out[k++] = left[i].t <= right[j].t ? left[i++] : right[j++];
  while (i < left.length) out[k++] = left[i++];
  while (j < right.length) out[k++] = right[j++];
  return out;
}

/**
 * @param {object} options
 * @param {{ comments: Function, hasComments: Function }} options.sources  the source registry (sources.js)
 */
export function createCommentStore({ sources, now = () => Date.now(), maxItems = MAX_ITEMS, maxTotal = MAX_TOTAL_COMMENTS } = {}) {
  const items = new Map(); // sourceKey → item, least recently used first
  let total = 0;

  function itemFor(source) {
    const key = sourceKey(source);
    let item = items.get(key);
    if (item) {
      items.delete(key);
    } else {
      // `from`: every window from this index on is covered (an answer to the item's end).
      item = { key, none: false, from: Infinity, windows: new Set(), comments: [], pending: new Map(), failed: new Map() };
    }
    items.set(key, item);
    return item;
  }

  function evict(keep) {
    for (const [key, item] of items) {
      if (total <= maxTotal && items.size <= maxItems) break;
      if (item === keep) continue;
      total -= item.comments.length;
      items.delete(key);
    }
  }

  const covered = (item, index) => index >= item.from || item.windows.has(index);

  function accept(item, index, answer) {
    // An item evicted while its source answered is in use again.
    if (items.get(item.key) !== item) {
      items.delete(item.key);
      items.set(item.key, item);
    }
    if (answer == null) {
      item.none = true;
      total -= item.comments.length;
      item.comments = [];
      return;
    }
    const start = Math.max(0, Number(answer.start) || 0);
    const end = answer.end == null ? Infinity : Number(answer.end);
    const firstFull = Math.ceil(start / WINDOW_SECONDS - 1e-9);
    const isNew = (window) => !covered(item, window)
      && (window === index || (window >= firstFull && (window + 1) * WINDOW_SECONDS <= end + 1e-9));
    const fresh = answer.comments.filter((comment) => isNew(Math.floor(comment.t / WINDOW_SECONDS)));
    item.windows.add(index);
    if (end === Infinity) {
      item.from = Math.min(item.from, firstFull);
    } else {
      for (let window = firstFull; (window + 1) * WINDOW_SECONDS <= end + 1e-9; window += 1) item.windows.add(window);
    }
    item.comments = merge(item.comments, fresh);
    total += fresh.length;
    // One item larger than the bound keeps its earliest comments.
    if (item.comments.length > maxTotal) {
      total -= item.comments.length - maxTotal;
      item.comments = item.comments.slice(0, maxTotal);
    }
    evict(item);
  }

  function fill(item, source, index) {
    if (item.none || covered(item, index)) return null;
    if (item.pending.has(index)) return item.pending.get(index);
    const failure = item.failed.get(index);
    if (failure && now() - failure.at < RETRY_MS) return Promise.reject(failure.error);
    const job = sources.comments(source, { start: index * WINDOW_SECONDS, end: (index + 1) * WINDOW_SECONDS })
      .then((answer) => {
        item.failed.delete(index);
        accept(item, index, answer);
      }, (error) => {
        const failure = { at: now(), error: toYoloError(error) };
        item.failed.set(index, failure);
        throw failure.error;
      })
      .finally(() => item.pending.delete(index));
    item.pending.set(index, job);
    return job;
  }

  /**
   * Comments with `start <= t < end`, oldest first. `available: false` when
   * the item has none; `complete: false` when a window could not be read
   * (a source error, retried later). Throws only when nothing of the range
   * could be read.
   */
  async function get(source, { start = 0, end = start + WINDOW_SECONDS } = {}) {
    const from = Math.max(0, Number(start) || 0);
    const to = Math.min(Math.max(from, Number(end) || 0), from + MAX_RANGE_SECONDS);
    const item = itemFor(source);
    const windows = [];
    for (let index = Math.floor(from / WINDOW_SECONDS); index * WINDOW_SECONDS < Math.max(to, from + 1e-6); index += 1) windows.push(index);
    const results = await Promise.allSettled(windows.map((index) => fill(item, source, index)));
    const failures = results.filter((result) => result.status === "rejected");
    if (item.none) return { available: false, start: from, end: to, complete: true, comments: [] };
    if (failures.length === windows.length) throw failures[0].reason;
    const comments = item.comments.slice(firstAtOrAfter(item.comments, from), firstAtOrAfter(item.comments, to));
    return { available: true, start: from, end: to, complete: failures.length === 0, comments };
  }

  return {
    /** Whether the item's source can have comments at all. */
    has: (source) => sources.hasComments(source),
    get,
    /** Read the window at `start` ahead of the first request, ignoring failures. */
    prefetch(source, start = 0) {
      if (!sources.hasComments(source)) return;
      void get(source, { start, end: start + 1 }).catch(() => {});
    },
    status: () => ({ items: items.size, comments: total }),
  };
}
