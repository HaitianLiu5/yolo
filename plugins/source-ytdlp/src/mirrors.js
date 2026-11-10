// Bilibili's CDN serves one signed file from many hosts: any path under
// `/upgcxcode/` plays on every upos mirror and on Bilibili's own PoPs
// (`cn-*.bilivideo.com`) with the same query, since the host is not part of
// the signature. Which host is good from where the node is changes by the
// hour and by byte range. Measured from the home node: on 2026-10-12
// upos-sz-mirrorcosov.bilivideo.com gave 172 kbps and stalled mid-body while
// upos-sz-mirrorali.bilivideo.com gave 2 Mbps; on 2026-10-13 cosov sent a
// file's head at 8–70 Mbps but took up to 6.6 s to start on ranges deep in
// the file, or reset after 1.4 MB, while ali and hw sent 3–5 Mbps throughout.
// So no host is preferred by name: every mirror is a candidate, measured live.
//
// For such a URL the candidates are yt-dlp's URL, any backup URLs yt-dlp
// lists for the format, and the same path and query on the hosts below.
// A URL signed for an Akamai host (upos-*.akamaized.net) is served by the
// bilivideo hosts as well; one signed for a bilivideo host is refused by
// Akamai (403), so Akamai is never added. Peer CDN hosts are never
// candidates (`isPeerUrl`): from abroad they are slow or never answer, and
// their own paths are signed for them alone (Agent Note
// 2026-10-27-bilibili-through-the-egress-rule). prepare() probes the
// candidates in parallel with a small range request where playback starts,
// and orders them by throughput over the whole probe (a host that answers at
// once and then stalls ranks low). The best becomes the Input's `url`, the
// rest its `alternates`; the node keeps re-ranking them by what it sees and
// hedges slow requests across them (Agent Note 2026-10-11-node-media-pipeline).

const BILIVIDEO_HOST = /^[a-z0-9-]+\.bilivideo\.com$/i;
const UPOS_AKAMAI_HOST = /^upos-[a-z0-9-]+\.akamaized\.net$/i;
const AKAMAI_HOST = /(^|\.)akamaized\.net$|akamai/i;
// Measured from the home node on 2026-11-08 and 2026-11-09, 8 MB from a cold
// offset of a 1080p file, twice each: these gave 16–32 Mbps. cosb (16) and
// bd (12) were slower, aliov gave 2 Mbps, and mirror08c did not connect.
// The order is only a tie-break after yt-dlp's own URL and its backups.
export const BILIBILI_MIRROR_HOSTS = Object.freeze([
  "cn-hk-eq-01-03.bilivideo.com",
  "cn-hk-eq-01-01.bilivideo.com",
  "upos-sz-mirrorali.bilivideo.com",
  "upos-sz-estgoss.bilivideo.com",
  "upos-sz-mirrorcoso1.bilivideo.com",
  "upos-sz-mirrorbos.bilivideo.com",
  "upos-sz-mirrorhw.bilivideo.com",
  "upos-sz-mirrorcos.bilivideo.com",
  "upos-sz-mirrorcosov.bilivideo.com",
]);
// Peer CDN hosts, and upos names that send a request on to one:
// upos-sz-302ppio redirects to *.nexusedgeio.com, and upos-sz-302kodo
// answered 460 (2026-11-09). A mirror URL whose query names `os=mcdn` is
// served by peers too.
const PEER_HOST = /(^|\.)(mcdn\.bilivideo\.(com|cn|net)|szbdyd\.com|nexusedgeio\.com|ahdohpiechei\.com|mountaintoys\.cn|bvmlt\.top)$/i;
// Answers that mean this host will never serve this URL.
const USELESS_STATUSES = new Set([401, 403, 404, 410]);
export const MIRROR_PROBE_BYTES = 512 * 1024;
export const MIRROR_PROBE_TIMEOUT_MS = 3_000;
// yt-dlp's URL, its backups, and the fixed hosts above, at most this many:
// every one is probed at once.
const MAX_CANDIDATES = 10;

function parse(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

export const hostOf = (url) => parse(url)?.hostname.toLowerCase() || "";

/** A URL on a peer CDN host, or one that hands its request to a peer. */
export function isPeerUrl(url) {
  const parsed = parse(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return PEER_HOST.test(host) || (BILIVIDEO_HOST.test(host) && host.split(".")[0].includes("302")) || parsed.searchParams.get("os") === "mcdn";
}

/**
 * A signed `/upgcxcode/` URL whose path and query every Bilibili mirror and
 * PoP serves, even when its own host hands requests to a peer (302ppio). One
 * whose query names `os=mcdn` is signed for peers and is not moved.
 */
export function isMirrorUrl(url) {
  const parsed = parse(url);
  if (!parsed || !parsed.pathname.startsWith("/upgcxcode/") || parsed.searchParams.get("os") === "mcdn") return false;
  const host = parsed.hostname.toLowerCase();
  return BILIVIDEO_HOST.test(host) || UPOS_AKAMAI_HOST.test(host);
}

// Backup URLs yt-dlp may carry for a format (Bilibili's backupUrl, in the
// spellings yt-dlp and its extractors have used).
function backupUrls(format) {
  if (!format || typeof format !== "object") return [];
  const values = [format.backup_url, format.backupUrl, format.backup_urls, format.backupUrls].flat();
  return values.filter((value) => typeof value === "string" && parse(value));
}

/**
 * The URLs to try for one file: yt-dlp's own, its backups, then the same
 * path on the fixed hosts. A URL on a peer stays only as the last one, after
 * every mirror has failed. A URL no mirror serves is left alone.
 */
function mirrorCandidates(url, backups = []) {
  if (!isMirrorUrl(url)) return [url];
  const candidates = [url];
  for (const backup of backups) if (!AKAMAI_HOST.test(hostOf(backup)) && !isPeerUrl(backup)) candidates.push(backup);
  for (const host of BILIBILI_MIRROR_HOSTS) {
    const mirror = parse(url);
    mirror.hostname = host;
    candidates.push(mirror.href);
  }
  const mirrors = [...new Set(candidates)].filter((candidate) => !isPeerUrl(candidate)).slice(0, MAX_CANDIDATES);
  return isPeerUrl(url) ? [...mirrors, url] : mirrors;
}

/**
 * One small range request from byte `offset`; how fast the bytes came over
 * the whole request.
 * A redirect to a peer host ends the probe with `peer: true`.
 * @returns {Promise<{ url: string, host: string, status: number | null, peer: boolean, bytes: number, elapsedMs: number,
 *   firstByteMs: number | null, kbps: number, complete: boolean, error?: string }>}
 */
export async function probeMirror(url, { headers = {}, fetchImpl = globalThis.fetch, offset = 0, bytes = MIRROR_PROBE_BYTES, timeoutMs = MIRROR_PROBE_TIMEOUT_MS, signal = null, now = () => performance.now() } = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  const startedAt = now();
  const result = { url, host: hostOf(url), status: null, peer: false, bytes: 0, elapsedMs: 0, firstByteMs: null, kbps: 0, complete: false };
  try {
    const response = await fetchImpl(url, {
      headers: { ...headers, Range: `bytes=${offset}-${offset + bytes - 1}`, "Accept-Encoding": "identity" },
      redirect: "follow",
      signal: controller.signal,
    });
    result.status = response.status;
    result.peer = Boolean(response.redirected && isPeerUrl(response.url));
    if (result.peer || response.status !== 200 && response.status !== 206) {
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
 * 404) or send it on to a peer are dropped; hosts that failed otherwise stay
 * last, in case they recover. A URL on a peer is not probed and stays last.
 */
async function rankMirrors(all, { headers = {}, fetchImpl = globalThis.fetch, offset = 0, bytes = MIRROR_PROBE_BYTES, timeoutMs = MIRROR_PROBE_TIMEOUT_MS } = {}) {
  const peers = all.filter(isPeerUrl);
  const candidates = all.filter((url) => !isPeerUrl(url));
  if (candidates.length < 2) return { ordered: [...candidates, ...peers], probes: [] };
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
    .filter(({ probe }) => !probe.peer && !USELESS_STATUSES.has(probe.status))
    .sort((a, b) => (bucket(b.probe) - bucket(a.probe)) || (a.index - b.index));
  const ordered = usable.map(({ probe }) => probe.url);
  // Nothing answered at all (the node is offline?): keep yt-dlp's choice.
  return { ordered: [...(ordered.length ? ordered : [candidates[0]]), ...peers], probes };
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
  if (!isMirrorUrl(track.url)) return track;
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
 * Reorder a `file` or `split` Input's mirror URLs by measured speed and
 * attach the others as `alternates`. `formats` are yt-dlp's formats behind
 * the Input (for their backup URLs and sizes); the probe reads where
 * `startTime` falls in the file of `duration` seconds. Returns the Input,
 * the probed host order, and the chosen URL's probe rate (`kbps`, null when
 * nothing was probed). Inputs without mirror URLs are returned as they are.
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
  if (input?.type === "file" && isMirrorUrl(input.url)) {
    const { ordered, kbps } = await rank(input);
    return { input: withAlternates(input, ordered), hosts: ordered.map(hostOf), kbps };
  }
  if (input?.type === "split" && isMirrorUrl(input.video.url)) {
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
