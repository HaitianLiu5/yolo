import { BUILT_IN_PROVIDER, mediaDnsProvider } from "./dns.js";
import { createEdgeRun } from "./lease.js";
import { maintainLan } from "./lan.js";
import { maintainWan } from "./wan.js";

// One run of the node's media names, as the Worker's cron trigger runs it
// (Agent Note 2026-10-12-lan-direct-play,
// Agent Note 2026-10-13-media-off-the-worker,
// Agent Note 2026-10-14-dns-provider-plugins): nothing while another run's
// certificate order holds the lease (lease.js), else the LAN name, then the
// remote one, sharing one run, so at most one certificate is ordered between
// them. A failure of one never stops the other. The plugins' control
// entries load only for an instance whose media.dns chose a plugin's
// provider.

const consoleLog = (record) => console.log(record);

/**
 * @param {object} env  the Worker's env
 * @param {object} [options]
 *   loadProviders() → the plugins' DNS providers (plugins.js); lan and wan are
 *   the options of maintainLan() and maintainWan(), test seams included
 * @returns {Promise<{ busy: boolean, lan?: object, wan?: object }>} the owner's views
 */
const providersFor = async (env, loadProviders) => (mediaDnsProvider(env) === BUILT_IN_PROVIDER ? [] : await loadProviders());

/**
 * The owner's "Check now" and remote-access switch in settings (api/owner.js):
 * runs of their own that a person waits on, so a provider whose nameservers
 * need time gets no order inside the request; the cron run orders it.
 * @param {object} [options]  loadProviders() as below; `onPathsChanged(env)`
 *   for the remote check; lan and wan as below
 */
export function ownerChecks({ loadProviders = async () => [], onPathsChanged = async () => {}, lan = {}, wan = {} } = {}) {
  return {
    checkLan: async (env) => maintainLan(env, { ...lan, providers: await providersFor(env, loadProviders), interactive: true }),
    checkWan: async (env) => maintainWan(env, { onPathsChanged: () => onPathsChanged(env), ...wan, providers: await providersFor(env, loadProviders), interactive: true }),
  };
}

export async function maintainMediaNames(env, { loadProviders = async () => [], lan = {}, wan = {}, now = () => Date.now(), log = consoleLog } = {}) {
  const run = createEdgeRun(env.OAUTH_KV, { now });
  if (await run.busy()) {
    log({ kind: "edge", event: "busy", reason: "another run's certificate order holds the lease" });
    return { busy: true };
  }
  const providers = await providersFor(env, loadProviders);
  const views = { busy: false };
  try {
    for (const [path, label, maintain, options] of [["lan", "LAN", maintainLan, lan], ["wan", "Remote", maintainWan, wan]]) {
      try {
        views[path] = await maintain(env, { now, log, ...options, providers, run });
      } catch (error) {
        console.error(`${label} maintenance failed`, error);
      }
    }
  } finally {
    await run.done();
  }
  return views;
}
