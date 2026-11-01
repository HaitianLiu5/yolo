import { sourceKey } from "@useyolo/core";

// Resolving ahead (Agent Note 2026-10-07-node-internal-api, `/warm`): the
// first few sources a device's home screen offers go to their plugins'
// warm() with the context a prepare for that device would get. One runs at
// a time, so warming never competes with itself for the machine; at most
// WARM_QUEUE wait, and a source already waiting or warming is not added
// again. A failure is dropped: a tap then prepares as it would have anyway.
export const WARM_MAX_SOURCES = 3;
const WARM_QUEUE = 6;

export function createWarmer({ sources }) {
  const waiting = new Map(); // sourceKey → { source, context }, in order
  let busy = false;

  async function drain() {
    busy = true;
    try {
      while (waiting.size) {
        const [key, job] = waiting.entries().next().value;
        try {
          await sources.warm(job.source, job.context);
        } catch {
          // Best effort.
        }
        waiting.delete(key);
      }
    } finally {
      busy = false;
    }
  }

  return {
    /** Queues `source`; false when it already waits or the queue is full. */
    add(source, request) {
      const key = sourceKey(source);
      if (waiting.has(key) || waiting.size >= WARM_QUEUE) return false;
      waiting.set(key, {
        source,
        context: {
          capabilities: request.capabilities, viewport: request.viewport, limits: { maxVideoKbps: request.limits.maxVideoKbps }, network: request.network,
          startTime: request.startTime ?? null,
        },
      });
      if (!busy) void drain();
      return true;
    },
  };
}
