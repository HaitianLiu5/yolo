import { sourceKey } from "@useyolo/core";

// Playback health for agents (Agent Note 2026-10-07-remote-mcp-server): why a
// screen stutters, from what the Hub already knows (the stream it loaded, the
// device's media path and quality cap, the rebuilds it made) and the compact
// `health` a playing device adds to its reports
// (Agent Note 2026-10-07-hub-and-realtime-channel). Pure, so it can be
// tested without a Hub.

// A stream needs this much more throughput than its bitrate to keep up.
const HEADROOM = 1.15;
const RECENT_STALL_SECONDS = 5 * 60;
const RECENT_ERROR_SECONDS = 10 * 60;
const REBUILD_WINDOW_SECONDS = 30 * 60;
const LOW_BUFFER_SECONDS = 5;
// Shorter waits are a start or a seek, not a stutter: they are left out of
// the recent stalls, and only stalls of HINT_STALL_SECONDS or more count in
// the hints.
const MIN_STALL_SECONDS = 0.5;
const HINT_STALL_SECONDS = 1;
// Reasons a stream was rebuilt (the Hub's play reasons) or failed.
const REBUILDS = new Set(["recovery", "quality", "seek", "tracks", "transfer", "error"]);
const AFTER_ERRORS = new Set(["recovery", "error"]);

const tenths = (value) => Math.round(value * 10) / 10;

function bounded(value, max, round = Math.round) {
  const number = Number(value);
  return value !== null && value !== "" && Number.isFinite(number) && number >= 0 && number <= max ? round(number) : null;
}

const compact = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined));

/**
 * The `health` of a device's `report`, kept to known fields and bounds:
 * { engine, bufferSeconds, throughputKbps, buffering, stalls, stallSeconds,
 * recentStalls: [{ ago, seconds }], width, height, videoCodec, droppedFrames }.
 * Null when there is nothing usable.
 */
export function sanitizeHealthReport(raw) {
  if (!raw || typeof raw !== "object") return null;
  const recentStalls = (Array.isArray(raw.recentStalls) ? raw.recentStalls : [])
    .map((stall) => {
      const ago = bounded(stall?.ago, 86_400);
      const seconds = bounded(stall?.seconds, 86_400, tenths);
      return ago === null || seconds === null ? null : { ago, seconds };
    })
    .filter(Boolean)
    .slice(0, 5);
  const health = compact({
    engine: raw.engine === "canvas" || raw.engine === "native" ? raw.engine : null,
    bufferSeconds: bounded(raw.bufferSeconds, 3_600, tenths),
    throughputKbps: bounded(raw.throughputKbps, 10_000_000),
    buffering: typeof raw.buffering === "boolean" ? raw.buffering : null,
    stalls: bounded(raw.stalls, 1_000_000, Math.floor),
    stallSeconds: bounded(raw.stallSeconds, 10_000_000, tenths),
    recentStalls: recentStalls.length ? recentStalls : null,
    width: bounded(raw.width, 20_000, Math.floor),
    height: bounded(raw.height, 20_000, Math.floor),
    videoCodec: typeof raw.videoCodec === "string" && raw.videoCodec ? raw.videoCodec.slice(0, 40) : null,
    droppedFrames: bounded(raw.droppedFrames, 1e12, Math.floor),
  });
  return Object.keys(health).length ? health : null;
}

const secondsAgo = (now, at) => Math.max(0, Math.round((now - Number(at)) / 1000));
const size = (width, height) => (width && height ? `${width}x${height}` : null);

/**
 * One device's playback health. `stream` is the summary the Hub kept of the
 * device's last loaded stream, `report` its latest sanitized health with
 * `at` and `sessionId`, `network` its media path report, `media` the
 * owner's switches ({ relayMode }), `events` the Hub's recent stream events
 * ({ at, reason, maxVideoKbps?, network?, code? }).
 */
export function assemblePlaybackHealth({ now = Date.now(), device, state = null, stream = null, report = null, network = null, media = null, events = [] }) {
  const active = Boolean(state?.item) && state.deviceId === device.id;
  const current = (entry) => entry && (!active || !entry.sessionId || entry.sessionId === state.sessionId) ? entry : null;
  const loaded = current(stream);
  const health = current(report);
  const reportAge = health?.at ? secondsAgo(now, health.at) : 0;
  const profile = loaded?.profile ?? {};
  const limits = loaded?.limits ?? null;

  const recentStalls = (health?.recentStalls ?? [])
    .filter((stall) => stall.seconds >= MIN_STALL_SECONDS)
    .map((stall) => ({ ago: stall.ago + reportAge, seconds: stall.seconds }));
  const rebuilds = (Array.isArray(events) ? events : [])
    .filter((event) => REBUILDS.has(event?.reason) && secondsAgo(now, event.at) <= REBUILD_WINDOW_SECONDS)
    .map((event) => compact({
      ago: secondsAgo(now, event.at), reason: event.reason, capKbps: event.maxVideoKbps ?? null, path: event.network ?? null, code: event.code ?? null,
    }));
  const probes = network?.probes && Object.keys(network.probes).length ? network.probes : null;
  const path = compact({
    now: loaded?.network ?? network?.path ?? null,
    probes,
    hairpin: network?.hairpin ?? null,
    relayMode: typeof media?.relayMode === "string" ? media.relayMode : null,
  });

  const hints = [];
  const status = active ? state.status : null;
  if (!health) hints.push("The device sent no buffer report: it may run an older player.");
  if (status === "buffering") hints.push(health?.bufferSeconds != null ? `Buffering now, with ${health.bufferSeconds} s of buffer.` : "Buffering now.");
  else if (status === "playing" && health?.bufferSeconds != null && health.bufferSeconds < LOW_BUFFER_SECONDS) hints.push(`The buffer is low: ${health.bufferSeconds} s.`);
  const needKbps = Math.round(((Number(profile.videoKbps) || 0) + (Number(profile.audioKbps) || 0)) * HEADROOM);
  if (needKbps && health?.throughputKbps && health.throughputKbps < needKbps) {
    hints.push(`Measured throughput ${health.throughputKbps} kbps is below the ${needKbps} kbps this stream needs.`);
  }
  const lately = recentStalls.filter((stall) => stall.ago <= RECENT_STALL_SECONDS && stall.seconds >= HINT_STALL_SECONDS).length;
  if (lately) hints.push(`${lately} ${lately === 1 ? "stall" : "stalls"} of a second or more in the last 5 minutes.`);
  if (limits?.capped && limits.maxVideoKbps < limits.ceilingKbps) {
    hints.push(`The video is capped at ${limits.maxVideoKbps} kbps (the node allows ${limits.ceilingKbps}): where this screen's streams on this path start, from its own history or the path's default.`);
  }
  if (path.now === "relay") {
    const why = probes ? `; ${[["lan", "the LAN probe"], ["wan", "the remote probe"]].filter(([key]) => probes[key]).map(([key, label]) => `${label}: ${probes[key]}`).join(", ")}` : "";
    hints.push(`Media goes through the Cloudflare relay${why}.`);
  }
  const errors = rebuilds.filter((event) => AFTER_ERRORS.has(event.reason) && event.ago <= RECENT_ERROR_SECONDS).length;
  if (errors) hints.push(`${errors} stream ${errors === 1 ? "rebuild" : "rebuilds"} after errors in the last 10 minutes.`);
  if (!hints.length && health) {
    hints.push(`No problem seen: ${health.bufferSeconds ?? "?"} s buffered${health.throughputKbps ? `, ${health.throughputKbps} kbps measured` : ""}.`);
  }

  return compact({
    device: { id: device.id, name: device.name, online: Boolean(device.online), active: Boolean(device.active) },
    engine: health?.engine ?? null,
    item: active ? { id: sourceKey(state.item.source), title: state.item.title ?? null, status: state.status, position: Math.round(Number(state.position) || 0) } : null,
    stream: loaded ? compact({
      delivery: loaded.delivery ?? null,
      resolution: size(profile.width, profile.height),
      fps: profile.fps ?? null,
      videoKbps: profile.videoKbps ?? null,
      audioKbps: profile.audioKbps ?? null,
      videoCodec: profile.videoCodec ?? null,
      audioCodec: profile.audioCodec ?? null,
      original: profile.original === true ? true : null,
      decoded: size(health?.width, health?.height),
      decodedCodec: health?.videoCodec ?? null,
      droppedFrames: health?.droppedFrames ?? null,
      since: loaded.at ? secondsAgo(now, loaded.at) : null,
    }) : null,
    quality: limits ? { capKbps: limits.maxVideoKbps ?? null, ceilingKbps: limits.ceilingKbps ?? null, capped: Boolean(limits.capped) } : null,
    path,
    buffer: health ? compact({ aheadSeconds: health.bufferSeconds ?? null, throughputKbps: health.throughputKbps ?? null, buffering: health.buffering ?? null, reported: reportAge }) : null,
    stalls: health ? compact({ count: health.stalls ?? null, seconds: health.stallSeconds ?? null, recent: recentStalls.length ? recentStalls : null }) : null,
    rebuilds: rebuilds.length ? rebuilds : null,
    hints,
  });
}
