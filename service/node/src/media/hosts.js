// How each upstream host has served the node lately, shared by every session
// and resource (Agent Note 2026-10-11-node-media-pipeline). A mirror host's
// quality changes by the hour and by byte range, so no host is preferred by
// name: the order an Input gives is only the tie-break, and what the node has
// seen recently decides.
//
// - A fault (an error, a reset, a short body, or an attempt that stalled or
//   was too slow and lost to a hedge) adds one to the host's fault score,
//   which halves every `halfLifeMs`. While the score rounds to 1 or more the
//   host ranks after hosts with a lower score.
// - A transfer of at least MIN_SAMPLE_BYTES updates the throughput of that
//   host for that file (the URL's path: an edge cache can be fast for one
//   file and cold for the next), an exponential moving average. Among hosts
//   with the same rounded score, faster ones for the file rank first, within
//   25% counting as equal; a host with no recent sample for the file counts
//   as fast as the best one, so the given order decides for a new file.

export const HEALTH_HALF_LIFE_MS = 3 * 60_000;
const MIN_SAMPLE_BYTES = 256 * 1024;
const SAMPLE_TTL_MS = 30 * 60_000;
const SAMPLE_WEIGHT = 0.3;
const MAX_HOSTS = 256;
const MAX_SAMPLES = 1024;

const parts = (url) => {
  try {
    const parsed = new URL(url);
    return { host: parsed.host.toLowerCase(), file: `${parsed.host.toLowerCase()}${parsed.pathname}` };
  } catch {
    return { host: String(url), file: String(url) };
  }
};

// A Map that forgets its oldest key past `max`.
function bounded(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}

const bucket = (kbps) => Math.floor(Math.log(Math.max(1, kbps)) / Math.log(1.25));

export function createHostHealth({ now = () => Date.now(), halfLifeMs = HEALTH_HALF_LIFE_MS } = {}) {
  const hosts = new Map(); // host → { faults, faultAt }
  const samples = new Map(); // host + path → { kbps, at }

  const score = (value) => (value?.faults ? value.faults * 0.5 ** ((now() - value.faultAt) / halfLifeMs) : 0);
  const speed = (value) => (value && now() - value.at <= SAMPLE_TTL_MS ? value.kbps : null);

  return {
    fault(url) {
      const { host } = parts(url);
      bounded(hosts, host, { faults: score(hosts.get(host)) + 1, faultAt: now() }, MAX_HOSTS);
    },

    success(url, { bytes, ms }) {
      if (!(bytes >= MIN_SAMPLE_BYTES) || !(ms > 0)) return;
      const { file } = parts(url);
      const kbps = (bytes * 8) / ms;
      const previous = speed(samples.get(file));
      bounded(samples, file, { kbps: previous == null ? kbps : previous + SAMPLE_WEIGHT * (kbps - previous), at: now() }, MAX_SAMPLES);
    },

    /** `urls` in the order to try them: fewest recent faults, then fastest for the file, then as given. */
    rank(urls) {
      const rows = urls.map((url, index) => {
        const { host, file } = parts(url);
        return { url, index, faults: Math.round(score(hosts.get(host))), kbps: speed(samples.get(file)) };
      });
      const best = Math.max(0, ...rows.map((row) => row.kbps ?? 0));
      const pace = (row) => bucket(row.kbps ?? best);
      return rows.sort((a, b) => (a.faults - b.faults) || (pace(b) - pace(a)) || (a.index - b.index)).map((row) => row.url);
    },

    /** Recent fault scores by host, for /internal/v1/health. */
    snapshot() {
      return Object.fromEntries([...hosts].map(([host, value]) => [host, Math.round(score(value) * 100) / 100]).filter(([, faults]) => faults >= 0.01));
    },
  };
}
