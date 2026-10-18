// Bilibili's upos CDN serves one signed file from several mirror hosts, and
// which one is good from where the node is changes by the hour and by byte
// range. Measured from the home node: on 2026-10-12
// upos-sz-mirrorcosov.bilivideo.com gave 172 kbps and stalled mid-body while
// upos-sz-mirrorali.bilivideo.com gave 2 Mbps; on 2026-10-13 cosov sent a
// file's head at 8–70 Mbps but took up to 6.6 s to start on ranges deep in
// the file, or reset after 1.4 MB, while ali and hw sent 3–5 Mbps throughout.
// So no host is preferred by name: every mirror is a candidate, measured live.
//
// For an upos URL the candidates are yt-dlp's URL, the same path and query on
// the other mirror hosts, and any backup URLs yt-dlp lists for the format.
// A URL signed for an Akamai host (upos-*.akamaized.net) is served by the
// bilivideo mirrors as well; one signed for a bilivideo host is refused by
// Akamai (403), so Akamai is never added. prepare() probes the candidates in
// parallel with a small range request where playback starts, and orders them
// by throughput over the whole probe (a host that answers at once and then
// stalls ranks low). The best becomes the Input's `url`, the rest its
// `alternates`; the node keeps re-ranking them by what it sees and hedges
// slow requests across them (Agent Note 2026-10-11-node-media-pipeline).

const UPOS_HOST = /^upos-[a-z0-9-]+\.bilivideo\.com$/i;
const UPOS_AKAMAI_HOST = /^upos-[a-z0-9-]+\.akamaized\.net$/i;
const AKAMAI_HOST = /(^|\.)akamaized\.net$|akamai/i;
// The order is only a tie-break after yt-dlp's own host.
export const BILIBILI_MIRROR_HOSTS = Object.freeze(["upos-sz-mirrorcosov.bilivideo.com", "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com"]);
// Answers that mean this host will never serve this URL.
const USELESS_STATUSES = new Set([401, 403, 404, 410]);
export const MIRROR_PROBE_BYTES = 512 * 1024;
export const MIRROR_PROBE_TIMEOUT_MS = 3_000;
const MAX_CANDIDATES = 6;

function parse(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

export const hostOf = (url) => parse(url)?.hostname.toLowerCase() || "";
export const isUposUrl = (url) => UPOS_HOST.test(hostOf(url)) || UPOS_AKAMAI_HOST.test(hostOf(url));

// Backup URLs yt-dlp may carry for a format (Bilibili's backupUrl, in the
// spellings yt-dlp and its extractors have used).
function backupUrls(format) {
  if (!format || typeof format !== "object") return [];
  const values = [format.backup_url, format.backupUrl, format.backup_urls, format.backupUrls].flat();
  return values.filter((value) => typeof value === "string" && parse(value));
}

/** The URLs to try for one file, yt-dlp's own first; a non-upos URL is left alone. */
function mirrorCandidates(url, backups = []) {
  if (!isUposUrl(url)) return [url];
  const candidates = [url];
  for (const host of BILIBILI_MIRROR_HOSTS) {
    const mirror = parse(url);
    mirror.hostname = host;
    candidates.push(mirror.href);
  }
  for (const backup of backups) if (!AKAMAI_HOST.test(hostOf(backup))) candidates.push(backup);
  return [...new Set(candidates)].slice(0, MAX_CANDIDATES);
}

/**
 * One small range request from byte `offset`; how fast the bytes came over
 * the whole request.
 * @returns {Promise<{ url: string, host: string, status: number | null, bytes: number, elapsedMs: number,
 *   firstByteMs: number | null, kbps: number, complete: boolean, error?: string }>}
 */
export async function probeMirror(url, { headers = {}, fetchImpl = globalThis.fetch, offset = 0, bytes = MIRROR_PROBE_BYTES, timeoutMs = MIRROR_PROBE_TIMEOUT_MS, signal = null, now = () => performance.now() } = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  const startedAt = now();
  const result = { url, host: hostOf(url), status: null, bytes: 0, elapsedMs: 0, firstByteMs: null, kbps: 0, complete: false };
  try {
    const response = await fetchImpl(url, {
      headers: { ...headers, Range: `bytes=${offset}-${offset + bytes - 1}`, "Accept-Encoding": "identity" },
      redirect: "follow",
      signal: controller.signal,
    });
    result.status = response.status;
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      return result;
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        result.firstByteMs ??= Math.round(now() - startedAt);
        result.bytes += value.byteLength;
        if (result.bytes >= bytes) break;
      }
      result.complete = true;
    } finally {
      reader.cancel().catch(() => {});
    }
  } catch (error) {
    // Aborted at the deadline (or because a faster mirror finished): what
    // arrived until then still counts.
    if (!controller.signal.aborted) result.error = error?.message || String(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    result.elapsedMs = Math.max(1, Math.round(now() - startedAt));
    result.kbps = Math.round((result.bytes * 8) / result.elapsedMs);
  }
  return result;
}

/**
 * Probe every candidate at once and order them, fastest first. Once one has
 * finished, the others get half as long again (at least 300 ms) before they
 * are cut off and judged on what arrived. Hosts that refuse the URL (403,
 * 404) are dropped; hosts that failed otherwise stay last, in case they
 * recover.
 */
async function rankMirrors(candidates, { headers = {}, fetchImpl = globalThis.fetch, offset = 0, bytes = MIRROR_PROBE_BYTES, timeoutMs = MIRROR_PROBE_TIMEOUT_MS } = {}) {
  if (candidates.length < 2) return { ordered: [...candidates], probes: [] };
  const cutoff = new AbortController();
  const startedAt = performance.now();
  let graceTimer = null;
  const probes = await Promise.all(candidates.map((url) => probeMirror(url, { headers, fetchImpl, offset, bytes, timeoutMs, signal: cutoff.signal }).then((probe) => {
    if (probe.complete && !graceTimer) {
      const elapsed = performance.now() - startedAt;
      graceTimer = setTimeout(() => cutoff.abort(), Math.max(300, elapsed * 0.5));
    }
    return probe;
  })));
  clearTimeout(graceTimer);
  // Within 25% of each other counts as equal: keep yt-dlp's order then.
  const bucket = (probe) => (probe.kbps > 0 ? Math.floor(Math.log(probe.kbps) / Math.log(1.25)) : -Infinity);
  const usable = probes
    .map((probe, index) => ({ probe, index }))
    .filter(({ probe }) => !USELESS_STATUSES.has(probe.status))
    .sort((a, b) => (bucket(b.probe) - bucket(a.probe)) || (a.index - b.index));
  const ordered = usable.map(({ probe }) => probe.url);
  // Nothing answered at all (the node is offline?): keep yt-dlp's choice.
  return { ordered: ordered.length ? ordered : [candidates[0]], probes };
}

// The same order for a file on the same hosts (the audio of a split pair).
function followHosts(candidates, hosts) {
  const rank = (url) => {
    const index = hosts.indexOf(hostOf(url));
    return index === -1 ? hosts.length : index;
  };
  const known = new Set(hosts);
  return candidates
    .filter((url, index) => index === 0 || known.has(hostOf(url)) || !hosts.length)
    .map((url, index) => ({ url, index }))
    .sort((a, b) => (rank(a.url) - rank(b.url)) || (a.index - b.index))
    .map(({ url }) => url);
}

const withAlternates = (track, ordered) => ({ ...track, url: ordered[0], ...(ordered.length > 1 ? { alternates: ordered.slice(1) } : {}) });

/** A split track of another format on the hosts a probe ordered. */
export function trackOnHosts(track, format, hosts) {
  if (!isUposUrl(track.url)) return track;
  const ordered = followHosts(mirrorCandidates(track.url, backupUrls(format)), hosts);
  return withAlternates(track, ordered.length ? ordered : [track.url]);
}

// Where playback starts in a file: its share of the duration, at most 90% in
// (a size estimate may run long). 0 when the size or duration is unknown.
export function probeOffset(format, { startTime = 0, duration = null } = {}) {
  const seconds = Number(duration);
  const size = Number(format?.filesize) || Number(format?.filesize_approx) || (Number(format?.tbr) > 0 && seconds > 0 ? (format.tbr * 1000 / 8) * seconds : 0);
  if (!(size > 0) || !(seconds > 0) || !(Number(startTime) > 0)) return 0;
  return Math.floor(size * Math.min(0.9, Number(startTime) / seconds));
}

/**
 * Reorder a `file` or `split` Input's upos URLs by measured mirror speed and
 * attach the others as `alternates`. `formats` are yt-dlp's formats behind
 * the Input (for their backup URLs and sizes); the probe reads where
 * `startTime` falls in the file of `duration` seconds. Returns the Input,
 * the probed host order, and the chosen URL's probe rate (`kbps`, null when
 * nothing was probed). Inputs without upos URLs are returned as they are.
 */
export async function preferFastMirrors(input, formats = [], { fetchImpl = globalThis.fetch, bytes, timeoutMs, startTime = 0, duration = null, logger = null } = {}) {
  const formatFor = (url) => formats.find((format) => format?.url === url) || null;
  const rank = async (track) => {
    const format = formatFor(track.url);
    const { ordered, probes } = await rankMirrors(mirrorCandidates(track.url, backupUrls(format)), {
      headers: track.headers || {}, fetchImpl, bytes, timeoutMs, offset: probeOffset(format, { startTime, duration }),
    });
    logRanking(logger, probes, ordered);
    return { ordered, kbps: probes.find((probe) => probe.url === ordered[0])?.kbps || null };
  };
  if (input?.type === "file" && isUposUrl(input.url)) {
    const { ordered, kbps } = await rank(input);
    return { input: withAlternates(input, ordered), hosts: ordered.map(hostOf), kbps };
  }
  if (input?.type === "split" && isUposUrl(input.video.url)) {
    const { ordered, kbps } = await rank(input.video);
    const hosts = ordered.map(hostOf);
    return { input: { ...input, video: withAlternates(input.video, ordered), audio: trackOnHosts(input.audio, formatFor(input.audio.url), hosts) }, hosts, kbps };
  }
  return { input, hosts: [], kbps: null };
}

function logRanking(logger, probes, ordered) {
  if (!logger?.info || !probes.length) return;
  const summary = probes.map((probe) => `${probe.host} ${probe.status ?? probe.error ?? "no answer"} ${probe.kbps} kbps`).join(", ");
  logger.info(`mirror probe: ${summary}; using ${hostOf(ordered[0])}`);
}
