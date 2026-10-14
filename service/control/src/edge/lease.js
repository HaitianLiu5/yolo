// One run of the media names: the cron run, or the owner's check
// (Agent Note 2026-10-14-dns-provider-plugins). A run orders at most one
// certificate. With a provider whose nameservers need time, an order keeps
// a run busy for about 4 minutes and the cron fires every 5, so the order is
// taken under a lease in KV that every run checks first: a run that finds
// another run's lease changes nothing. The lease is written only when an
// order starts and deleted when the run ends, which keeps a 5-minute cron
// far inside Workers Free's 1,000 KV writes and deletes a day; it expires by
// itself after 10 minutes, longer than any run. KV is eventually consistent
// within about a minute, far less than the 5 minutes between runs.

export const EDGE_LEASE_KEY = "yolo:edge:lease";
export const LEASE_MS = 10 * 60_000;

const randomId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function readLease(kv) {
  try {
    return JSON.parse((await kv?.get(EDGE_LEASE_KEY)) ?? "null");
  } catch {
    return null;
  }
}

/**
 * @param {object} kv  OAUTH_KV
 * @param {object} [options]  `interactive`: a person waits on this run (the
 *   owner's check), so it leaves orders that wait for a provider's
 *   nameservers to the cron run
 */
export function createEdgeRun(kv, { now = () => Date.now(), interactive = false, maxOrders = 1 } = {}) {
  const id = randomId();
  let holding = false;
  let orders = 0;
  return {
    interactive,

    /** Another run holds the lease: its order is under way. */
    async busy() {
      const lease = await readLease(kv);
      return Boolean(lease && lease.id !== id && Number(lease.until) > now());
    },

    /**
     * Whether this run may start an order now, and if so the lease is held:
     * false once it ordered `maxOrders`, for a `slow` order while a person
     * waits, and while another run holds the lease.
     */
    async mayOrder({ slow = false } = {}) {
      if (orders >= maxOrders || (slow && interactive)) return false;
      if (!holding) {
        if (await this.busy()) return false;
        await kv.put(EDGE_LEASE_KEY, JSON.stringify({ id, until: now() + LEASE_MS }), { expirationTtl: LEASE_MS / 1000 });
        holding = true;
      }
      orders += 1;
      return true;
    },

    /** The run is over: its lease, if it took one, goes. */
    async done() {
      if (!holding) return;
      holding = false;
      await Promise.resolve().then(() => kv.delete(EDGE_LEASE_KEY)).catch(() => {});
    },
  };
}
