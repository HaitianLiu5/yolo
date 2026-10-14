import {
  canPlay,
  currentPosition,
  emptyPlaybackState,
  isClaimed,
  isFinished,
  LOAD_REASONS,
  MEDIA_PATHS as MEDIA_PATH_NAMES,
  mediaPath,
  newId,
  preferenceFromTrack,
  randomToken,
  redactText,
  sha256,
  sourceKey,
  YoloError,
} from "@useyolo/core";
import { getDevice, listDevices, touchDevice, updateDevice, upsertDevice } from "../store/devices.js";
import { getTrackPreferences, saveTrackPreferences } from "../store/preferences.js";
import { getHistoryEntry, listHistory, recordPlay, recordProgress } from "../store/history.js";
import { listQueue, shiftQueue, addQueueItems } from "../store/queue.js";
import { listPlaylists } from "../store/playlists.js";
import { claimSource } from "../sources.js";
import { deviceMedia, unreachableRefusal } from "../edge/paths.js";
import { assemblePlaybackHealth, sanitizeHealthReport } from "./playback-health.js";

// The Hub owns "what is playing now" for one user
// (Agent Note 2026-10-07-hub-and-realtime-channel): the PlaybackState, which
// device is active, and the commands sent to devices. The node owns media
// sessions. This class has no Workers imports so it can be unit tested; hub.js
// wraps it in a Durable Object.
//
// Every device is a realtime device: it connects to /v1/realtime and receives
// `load`, `pause`, …. The node's media pipeline prepares a stream for the
// device's capabilities (Agent Note 2026-10-07-capability-negotiation) and the
// device plays it from /m/*. The player (clients/player) is one; the channel
// stays in core (Agent Note 2026-10-07-hub-and-realtime-channel).

const STATE_KEY = "state";
const VIEWPORT_KEY = "viewport:";
const QUALITY_KEY = "quality:";
const NETWORK_KEY = "network:";
// Per device, for playback health (hub/playback-health.js): the last stream
// loaded, the device's latest `health` report, and recent stream events.
const STREAM_KEY = "stream:";
const HEALTH_KEY = "health:";
const EVENTS_KEY = "events:";
// Per device, what a connection that died without the Hub noticing may have
// taken: the last pause or resume and the last seek sent for its stream,
// { sessionId, playback?: { id, action }, seek?: { id, position } }, which
// its next welcome names; and an agent's danmaku change it has not
// acknowledged, { id, settings }, which goes again after that welcome.
const COMMANDS_KEY = "commands:";
const DANMAKU_KEY = "danmaku:";
const MAX_EVENTS = 12;
// How many streams each media path carried per UTC day, for the owner's
// settings and `yolo doctor`: { "2026-10-14": { lan, wan, relay } }, the
// last PATH_COUNT_DAYS days.
const PATH_COUNTS_KEY = "path_counts";
const PATH_COUNT_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;
const EVENTS_KEPT_MS = 30 * 60_000;
const PROFILE_FIELDS = ["width", "height", "fps", "videoKbps", "audioKbps", "videoCodec", "audioCodec", "original"];
// One-time realtime tickets: { [sha256(ticket)]: { deviceId, expiresAt } }.
const TICKETS_KEY = "tickets";
export const TICKET_TTL_MS = 30_000;
// More than a buggy client's reconnect loop can issue in 30 seconds without
// being rate limited; the oldest ticket goes first.
const MAX_TICKETS = 64;
// A device's adaptive-quality cap applies to what it plays next for this
// long: a new item on the same slow connection starts at the same cap.
const QUALITY_MEMORY_MS = 30 * 60_000;
const MIN_VIDEO_KBPS = 100;
const MAX_VIDEO_KBPS = 50_000;
const PROGRESS_WRITE_INTERVAL_MS = 30_000;
const PREPARE_TIMEOUT_MS = 60_000;
const NODE_CHECK_TIMEOUT_MS = 5_000;
// What a home screen may ask the node to resolve ahead, and how long the
// Hub waits for the node to take it (it answers before resolving).
const WARM_SOURCES = 3;
const WARM_TIMEOUT_MS = 5_000;
// A saved position this close to the start is not worth resuming.
const MIN_RESUME_SECONDS = 5;
// Reasons a device asks for a new stream of what it already plays.
const REBUILD_REASONS = new Set(["recovery", "seek", "quality", "tracks"]);
// A device that wakes up (the car after sleeping) reconnects its socket and
// asks for a new stream at the same moment; the request can reach the Hub
// before the new socket's hello. That long, at most, the Hub waits for it.
export const HELLO_WAIT_MS = 5_000;

// One structured line per Hub event, for Workers Logs (filter `kind = hub`).
const consoleLog = (record) => console.log(record);

export class HubCore {
  // `media()` resolves to the media paths a welcome lists and the relay's
  // mode, { paths: [{ path, origin, notAfter }], relayMode }, with what a
  // refusal's fix needs (edge/paths.js, Agent Note 2026-10-13-media-off-the-worker).
  constructor({
    userId, storage, db, node, transport, signMediaToken = null, now = () => Date.now(), helloWaitMs = HELLO_WAIT_MS, log = consoleLog,
    media = async () => ({ paths: [], relayMode: "auto" }),
  }) {
    this.userId = userId;
    this.media = media;
    this.storage = storage;
    this.db = db;
    this.node = node;
    this.transport = transport;
    this.signMediaToken = signMediaToken;
    this.now = now;
    this.helloWaitMs = helloWaitMs;
    this.writeLog = log;
    this.generation = 0;
    this.lastProgressWrite = 0;
    // The session whose `ended` is being handled: a screen sends it again
    // after a welcome that still names that stream, and the next item is
    // taken once. Only while it is handled, which keeps the Hub awake.
    this.ending = null;
    // What the last `state` log said, so a report every 5 seconds logs
    // nothing until something changes. Lost on hibernation: one extra line.
    this.loggedState = null;
  }

  log(event, fields = {}) {
    try {
      this.writeLog({ kind: "hub", event, userId: this.userId, ...fields });
    } catch {
      // Logging never fails a command.
    }
  }

  // A refusal the owner may need to explain later (device_offline,
  // node_offline, superseded): log why, then return the error to throw,
  // with `details` for a client to act on.
  refuse(code, message, fields = {}, details = undefined) {
    this.log("decision", { decision: code, reason: message, ...fields });
    return new YoloError(code, message, { details });
  }

  // A realtime ticket (Agent Note 2026-10-07-hub-and-realtime-channel): the
  // Worker issues it for a bearer token and the Hub redeems it when the
  // WebSocket upgrade arrives. It lives in this Hub's storage, which has no
  // daily write cap that matters here, rather than in KV, whose 1,000 writes a
  // day on Workers Free a reconnecting car could use up. A paired device's
  // ticket carries its device id, so its connection can only be that device.
  async issueTicket(deviceId = null) {
    const secret = randomToken();
    const key = await sha256(secret);
    const now = this.now();
    const expiresAt = now + TICKET_TTL_MS;
    // No await between the read and the write: the Durable Object's input
    // gate keeps another request from interleaving.
    const live = Object.entries((await this.storage.get(TICKETS_KEY)) || {}).filter(([, entry]) => entry.expiresAt > now);
    const tickets = Object.fromEntries([...live.slice(-(MAX_TICKETS - 1)), [key, { deviceId, expiresAt }]]);
    await this.storage.put(TICKETS_KEY, tickets);
    return { secret, expiresAt };
  }

  // → { deviceId } once for a live ticket, else null.
  async redeemTicket(secret) {
    if (!secret) return null;
    const key = await sha256(String(secret));
    const tickets = (await this.storage.get(TICKETS_KEY)) || {};
    const entry = tickets[key];
    if (!entry) return null;
    delete tickets[key];
    await this.storage.put(TICKETS_KEY, tickets);
    return entry.expiresAt > this.now() ? { deviceId: entry.deviceId ?? null } : null;
  }

  async state() {
    const state = (await this.storage.get(STATE_KEY)) || emptyPlaybackState();
    // A state saved before source plugins (Yolo 0.2) names its item in a form
    // this version cannot address; treat it as stopped on the same device.
    if (state.item && !isClaimed(state.item.source)) return { ...emptyPlaybackState(), deviceId: state.deviceId };
    return state;
  }

  // `cause` says what moved the state, for the log (`play:recovery`,
  // `report`, `disconnect`, …).
  async setState(next, cause = null) {
    await this.storage.put(STATE_KEY, next);
    this.transport.broadcast({ v: 1, type: "state", state: next });
    const previous = this.loggedState;
    if (!previous || previous.status !== next.status || previous.sessionId !== next.sessionId || previous.deviceId !== next.deviceId) {
      this.loggedState = { status: next.status, sessionId: next.sessionId, deviceId: next.deviceId };
      this.log("state", {
        cause,
        status: next.status,
        sessionId: next.sessionId,
        deviceId: next.deviceId,
        position: Math.round((Number(next.position) || 0) * 10) / 10,
        previousStatus: previous?.status ?? null,
        previousSessionId: previous?.sessionId ?? null,
        interrupted: Boolean(next.interruptedAt),
      });
    }
    return next;
  }

  async getState() {
    const state = await this.state();
    return { ...state, position: currentPosition(state, this.now()), positionAt: this.now() };
  }

  // --- Devices ---------------------------------------------------------

  async listDevices() {
    const state = await this.state();
    const connected = this.transport.connectedDeviceIds();
    const devices = (await listDevices(this.db, this.userId)).map((device) => ({
      ...device,
      online: connected.has(device.id),
      active: state.deviceId === device.id,
    }));
    return { devices };
  }

  // Whether the node answers, so a refusal with no device online names the
  // side that is missing. A node that answers with an error is online.
  async nodeAnswers() {
    try {
      await this.node.get("/internal/v1/health", undefined, { timeoutMs: NODE_CHECK_TIMEOUT_MS });
      return true;
    } catch (error) {
      return error?.code !== "node_offline";
    }
  }

  // `ref` is a device id or a name. Without one, use the active device, or the
  // only online device that can play. A remote (Yolo Web in a browser that
  // cannot play) is never picked and cannot be named.
  async resolveDevice(ref) {
    const { devices } = await this.listDevices();
    if (ref) {
      const needle = String(ref).trim().toLowerCase();
      const device = devices.find((candidate) => candidate.id.toLowerCase() === needle)
        || devices.find((candidate) => candidate.name.toLowerCase() === needle)
        || devices.find((candidate) => candidate.name.toLowerCase().includes(needle));
      if (!device) throw new YoloError("not_found", `No device matches "${ref}". Use list_devices to see device names.`);
      if (!canPlay(device.capabilities)) {
        throw new YoloError("invalid_request", `${device.name} is a remote: it controls playback but cannot play. Choose a screen that plays.`);
      }
      if (!device.online) {
        throw this.refuse("device_offline", `${device.name} is offline`, { deviceId: device.id, why: "no socket of this device has said hello" });
      }
      return device;
    }
    const online = devices.filter((device) => device.online && canPlay(device.capabilities));
    const active = online.find((device) => device.active);
    if (active) return active;
    if (online.length === 1) return online[0];
    if (!online.length && !(await this.nodeAnswers())) {
      throw this.refuse("node_offline", "The home media node is offline, so nothing can play right now.", { why: "no device online and the node did not answer" });
    }
    if (!online.length) {
      throw this.refuse(
        "device_offline",
        "No playback device is online. Open Yolo in the car's browser (or another paired screen) first.",
        { why: "no device online" },
      );
    }
    throw new YoloError(
      "invalid_request",
      `Several devices are online (${online.map((device) => device.name).join(", ")}); say which one to use.`,
    );
  }

  // --- Playback --------------------------------------------------------

  // Where to start `key` when nobody said: Yolo's history first; a finished
  // item starts over; with no useful position, null lets the source decide
  // (a library source may resume at its own watch position).
  async resumePosition(key) {
    const entry = await getHistoryEntry(this.db, this.userId, key);
    if (!entry) return null;
    if (isFinished(entry.position, entry.duration)) return 0;
    return entry.position > MIN_RESUME_SECONDS ? entry.position : null;
  }

  // A paired device asking to play on itself (`requester`, from its
  // credential) may be ahead of its own socket: after the car wakes, the
  // stream request and the reconnect race, and the request can arrive
  // before the new socket's hello. Wait for that hello, briefly, instead of
  // answering device_offline. Others' requests never wait.
  async waitForOwnHello(requester, deviceRef) {
    if (!requester) return;
    const own = deviceRef == null
      ? (await this.state()).deviceId === requester
      : String(deviceRef).trim().toLowerCase() === requester.toLowerCase();
    if (!own || this.transport.connectedDeviceIds().has(requester)) return;
    const startedAt = Date.now();
    const said = await this.transport.waitForHello(requester, this.helloWaitMs);
    this.log("hello_wait", { deviceId: requester, outcome: said ? "hello" : "timeout", waitedMs: Date.now() - startedAt });
  }

  // `source` may be an unclaimed { url } from the queue; the node claims it.
  // `replaces` is the session a device asks to rebuild (recovery, seek,
  // quality): if something else started meanwhile, the request is stale.
  // `requester` is the paired device whose credential made the request.
  async play({
    source: ref,
    device: deviceRef = null,
    startTime = null,
    reason = "play",
    sessionId = null,
    item = null,
    autoplay = true,
    replaces = null,
    requester = null,
    maxVideoKbps = undefined,
    network: requestedNetwork = undefined,
  }) {
    if (!LOAD_REASONS.includes(reason)) throw new YoloError("invalid_request", `reason must be one of ${LOAD_REASONS.join(", ")}`);
    const generation = ++this.generation;
    const source = await claimSource(this.node, ref);
    await this.waitForOwnHello(requester, deviceRef);
    const previous = await this.state();
    if (REBUILD_REASONS.has(reason) && replaces && previous.sessionId !== replaces) {
      throw this.refuse("superseded", "Something else is playing now", {
        reason, replaces, current: previous.sessionId, requester, why: "the session to rebuild was already replaced",
      });
    }
    const device = await this.resolveDevice(deviceRef);
    const key = sourceKey(source);
    const preferences = await getTrackPreferences(this.db, this.userId, key);
    const nextSessionId = sessionId || newId("ses");
    const mediaToken = this.signMediaToken ? await this.signMediaToken(nextSessionId) : null;
    let start = startTime == null ? null : Math.max(0, Number(startTime) || 0);
    if (start == null && !REBUILD_REASONS.has(reason)) start = await this.resumePosition(key);
    const limits = await this.deviceLimits(device, { maxVideoKbps, requester });
    const { path: reported, probes } = await this.devicePath(device, { network: requestedNetwork, requester });
    // The relay is the path when no direct path works for the screen
    // (automatic, the default, or on): a screen whose report found none,
    // from a welcome that did not allow the relay yet, gets it too. With
    // the relay off, no path is refused before the node does any work,
    // with what fixes it.
    const media = await this.media().catch(() => null);
    const relayOff = media ? (media.relayMode ?? "auto") === "off" : false;
    const network = reported === "none" && !relayOff ? "relay" : reported;
    if (network === "none" || (network === "relay" && relayOff)) {
      const { message, details } = unreachableRefusal({
        probes, paths: media?.paths, lanNeedsDomain: media?.lanNeedsDomain, remote: media?.remote, forward: media?.forward,
      });
      throw this.refuse("media_unreachable", message, { deviceId: device.id, requester, path: network, probes }, details);
    }

    const descriptor = await this.node.post("/internal/v1/prepare", {
      sessionId: nextSessionId,
      source,
      capabilities: device.capabilities,
      viewport: await this.viewport(device.id),
      startTime: start,
      reason,
      tracks: { preferences },
      limits,
      network,
      mediaToken,
    }, { timeoutMs: PREPARE_TIMEOUT_MS });
    // Which path the stream took: the node serves "lan" or "wan" only while
    // that listener does, whatever was asked, and the relay otherwise.
    const served = mediaPath(descriptor.network) ?? "relay";
    this.log("stream", {
      sessionId: nextSessionId, deviceId: device.id, reason, requester, asked: network, network: served,
      deliveryType: descriptor.delivery?.type ?? null, maxVideoKbps: descriptor.limits?.maxVideoKbps ?? null,
    });
    if (served === "relay" && network !== "relay" && relayOff) {
      void this.stopNodeSession(nextSessionId);
      const { details } = unreachableRefusal({ paths: [], remote: media?.remote, forward: media?.forward });
      throw this.refuse("media_unreachable", `The node's ${network === "lan" ? "LAN" : "remote"} listener is not serving now, and the relay is off. Turn the relay to Automatic in Settings › Media paths, or check the node (npm run yolo -- doctor)`, {
        deviceId: device.id, requester, path: network,
      }, { ...details, fixes: details.fixes.filter((fix) => fix.action === "relay") });
    }

    if (generation !== this.generation) {
      void this.stopNodeSession(nextSessionId);
      throw this.refuse("superseded", "A newer play request replaced this one", {
        reason, requester, deviceId: device.id, why: "another play started while this one was being prepared",
      });
    }

    if (previous.sessionId && previous.sessionId !== nextSessionId) void this.stopNodeSession(previous.sessionId);
    if (previous.deviceId && previous.deviceId !== device.id) {
      this.transport.send(previous.deviceId, { v: 1, type: "deactivate", deviceId: device.id });
    }
    // Leaving an item part way through keeps its place.
    if (previous.item && previous.sessionId !== nextSessionId && sourceKey(previous.item.source) !== key && previous.status !== "idle") {
      await recordProgress(this.db, this.userId, sourceKey(previous.item.source), {
        position: currentPosition(previous, this.now()), duration: previous.item.duration,
      }).catch((error) => this.log("progress_write_failed", { sourceKey: sourceKey(previous.item.source), code: error?.code || error?.name || "error" }));
    }

    const playbackItem = {
      source,
      title: descriptor.title || item?.title || key,
      thumbnail: descriptor.thumbnail ?? item?.thumbnail ?? null,
      duration: descriptor.duration ?? item?.duration ?? null,
      isLive: Boolean(descriptor.isLive),
    };
    const position = Number(descriptor.startTime ?? start) || 0;
    const state = {
      status: "loading",
      deviceId: device.id,
      item: playbackItem,
      position,
      positionAt: this.now(),
      tracks: {
        subtitles: (descriptor.tracks?.selected?.subtitles || []).map(String),
        audio: descriptor.tracks?.selected?.audio ?? null,
      },
      sessionId: nextSessionId,
    };

    this.transport.send(device.id, {
      v: 1, type: "load", id: newId("cmd", 8), stream: descriptor, item: playbackItem, startTime: position, autoplay: autoplay !== false, reason,
    });
    // The state names the stream the moment its `load` has gone out, before
    // anything else is awaited: a welcome read after it names this stream,
    // whichever connection the `load` went to (hello()).
    this.lastProgressWrite = this.now();
    await this.setState(state, `play:${reason}`);
    await this.rememberStream(device.id, nextSessionId, descriptor, reason);
    if (reason === "play" || reason === "transfer") {
      // History is best effort: the stream plays already.
      await recordPlay(this.db, this.userId, { ...playbackItem, position })
        .catch((error) => this.log("history_write_failed", { sourceKey: key, code: error?.code || error?.name || "error" }));
    }
    return { state, device: { id: device.id, name: device.name } };
  }

  // Resolve ahead (Agent Note 2026-10-07-v1-http-api, `/v1/playback/warm`):
  // the first items a device's home screen offers, at most WARM_SOURCES,
  // go to the node with what a play on that device would ask (its
  // capabilities, its path, its remembered cap), so their source plugins
  // can resolve them before a tap. Only a device that plays asks, for
  // itself; nothing is stored, and the node answers without waiting.
  async warm({ sources = [], requester = null, network: requestedNetwork = undefined } = {}) {
    const list = (Array.isArray(sources) ? sources : []).filter(isClaimed).slice(0, WARM_SOURCES);
    if (!requester || !list.length) return { warming: 0 };
    const { devices } = await this.listDevices();
    const device = devices.find((candidate) => candidate.id === requester);
    if (!device?.online || !canPlay(device.capabilities)) return { warming: 0 };
    const limits = await this.deviceLimits(device, { requester });
    const network = mediaPath(requestedNetwork) ?? (await this.devicePath(device, { requester })).path;
    if (network === "none") return { warming: 0 };
    const answer = await this.node.post("/internal/v1/warm", {
      sources: list, capabilities: device.capabilities, viewport: await this.viewport(device.id), limits, network,
    }, { timeoutMs: WARM_TIMEOUT_MS }).catch(() => null);
    return { warming: Number(answer?.warming) || 0 };
  }

  // What playback health needs of a stream the device was sent, and the
  // event of sending it. Best effort: it never fails a play.
  async rememberStream(deviceId, sessionId, descriptor, reason) {
    try {
      const profile = Object.fromEntries(PROFILE_FIELDS.filter((field) => descriptor.profile?.[field] != null).map((field) => [field, descriptor.profile[field]]));
      const network = mediaPath(descriptor.network) ?? "relay";
      const previous = await this.storage.get(`${STREAM_KEY}${deviceId}`);
      await this.storage.put(`${STREAM_KEY}${deviceId}`, {
        sessionId, at: this.now(), reason, network, delivery: descriptor.delivery?.type ?? null, profile, limits: descriptor.limits ?? null,
      });
      await this.noteStreamEvent(deviceId, { reason, maxVideoKbps: descriptor.limits?.maxVideoKbps ?? null, network });
      // A new stream counts for its path; a rebuild only when it moved to another path.
      if (!REBUILD_REASONS.has(reason) || previous?.network !== network) await this.countStream(network);
    } catch {
      // Health is diagnostics; playing matters more.
    }
  }

  // The UTC days whose counts are kept, today last.
  countedDays() {
    const today = Math.floor(this.now() / DAY_MS);
    return Array.from({ length: PATH_COUNT_DAYS }, (_, index) => new Date((today - PATH_COUNT_DAYS + 1 + index) * DAY_MS).toISOString().slice(0, 10));
  }

  async countStream(network) {
    const days = this.countedDays();
    const today = days.at(-1);
    const counts = (await this.storage.get(PATH_COUNTS_KEY)) || {};
    const kept = Object.fromEntries(Object.entries(counts).filter(([day]) => days.includes(day)));
    kept[today] = { ...kept[today], [network]: (kept[today]?.[network] ?? 0) + 1 };
    await this.storage.put(PATH_COUNTS_KEY, kept);
  }

  // The owner's view of the media paths (Agent Note 2026-10-13-media-off-the-worker):
  // the path of each screen's last stream and when it started, and the
  // streams each path carried over the last 7 days.
  async mediaUsage() {
    const { devices } = await this.listDevices();
    const screens = [];
    for (const device of devices.filter((candidate) => canPlay(candidate.capabilities))) {
      const stream = await this.storage.get(`${STREAM_KEY}${device.id}`);
      screens.push({ id: device.id, name: device.name, kind: device.kind, online: device.online, path: stream?.network ?? null, at: stream?.at ?? null });
    }
    // The screen that played last first; screens that never played at the end.
    screens.sort((a, b) => (b.at ?? -1) - (a.at ?? -1));
    const counts = (await this.storage.get(PATH_COUNTS_KEY)) || {};
    const streams = { days: PATH_COUNT_DAYS, lan: 0, wan: 0, relay: 0 };
    for (const day of this.countedDays()) {
      for (const path of MEDIA_PATH_NAMES) streams[path] += counts[day]?.[path] ?? 0;
    }
    return { screens, streams };
  }

  async noteStreamEvent(deviceId, event) {
    const key = `${EVENTS_KEY}${deviceId}`;
    const now = this.now();
    const kept = ((await this.storage.get(key)) || []).filter((entry) => now - entry.at < EVENTS_KEPT_MS);
    await this.storage.put(key, [...kept, { at: now, ...event }].slice(-MAX_EVENTS));
  }

  // Why a screen stutters (Agent Note 2026-10-07-remote-mcp-server): the
  // active device's, or `deviceRef`'s, stream, buffer, stalls, path, and cap.
  async playbackHealth(deviceRef = null) {
    const [{ devices }, state] = await Promise.all([this.listDevices(), this.getState()]);
    let device = null;
    if (deviceRef) {
      const needle = String(deviceRef).trim().toLowerCase();
      device = devices.find((candidate) => candidate.id.toLowerCase() === needle)
        || devices.find((candidate) => candidate.name.toLowerCase() === needle)
        || devices.find((candidate) => candidate.name.toLowerCase().includes(needle));
      if (!device) throw new YoloError("not_found", `No device matches "${deviceRef}". Use list_devices to see device names.`);
    } else {
      device = devices.find((candidate) => candidate.id === state.deviceId) ?? null;
      if (!device) throw new YoloError("invalid_request", "No device is active; pass device to check a screen");
    }
    const [stream, report, network, events, media] = await Promise.all([
      this.storage.get(`${STREAM_KEY}${device.id}`),
      this.storage.get(`${HEALTH_KEY}${device.id}`),
      this.storage.get(`${NETWORK_KEY}${device.id}`),
      this.storage.get(`${EVENTS_KEY}${device.id}`),
      this.media().catch(() => null),
    ]);
    return assemblePlaybackHealth({
      now: this.now(), device, state, stream: stream ?? null, report: report ?? null, network: network ?? null, media, events: events ?? [],
    });
  }

  async viewport(deviceId) {
    return (await this.storage.get(`${VIEWPORT_KEY}${deviceId}`)) ?? null;
  }

  // The device's adaptive-quality cap for this prepare
  // (Agent Note 2026-10-11-adaptive-quality): what the device's own request
  // says (kbps, or null for none, which it then keeps), else what it last said
  // within QUALITY_MEMORY_MS. Agents never set it; the node's own ceiling
  // applies on top either way.
  async deviceLimits(device, { maxVideoKbps, requester }) {
    const key = `${QUALITY_KEY}${device.id}`;
    if (maxVideoKbps !== undefined) {
      const value = Number(maxVideoKbps);
      const cap = maxVideoKbps != null && Number.isFinite(value) && value >= MIN_VIDEO_KBPS
        ? Math.min(MAX_VIDEO_KBPS, Math.floor(value))
        : null;
      if (requester === device.id) await this.storage.put(key, { maxVideoKbps: cap, at: this.now() });
      return cap ? { maxVideoKbps: cap } : null;
    }
    const remembered = await this.storage.get(key);
    if (remembered?.maxVideoKbps && this.now() - remembered.at < QUALITY_MEMORY_MS) return { maxVideoKbps: remembered.maxVideoKbps };
    return null;
  }

  // The media path the device asks for (Agent Note 2026-10-13-media-off-the-worker):
  // what its own request says, which is kept, else its last `network`
  // report; "none" when it found no path, or names none Yolo knows. Others'
  // requests never set it. A device that never said has no direct path the
  // Hub knows of, so the relay.
  async devicePath(device, { network, requester }) {
    const key = `${NETWORK_KEY}${device.id}`;
    const saved = await this.storage.get(key);
    if (network !== undefined && requester === device.id) {
      const path = mediaPath(network) ?? "none";
      await this.storage.put(key, { ...saved, path, at: this.now() });
      return { path, probes: saved?.probes ?? {} };
    }
    return { path: saved?.path ?? "relay", probes: saved?.probes ?? {} };
  }

  async requireSession() {
    const state = await this.state();
    if (!state.sessionId || !state.deviceId) throw new YoloError("invalid_request", "Nothing is playing");
    return state;
  }

  // → the command's id, once a socket of the active device took it.
  async sendCommand(state, command) {
    const id = newId("cmd", 8);
    const sent = this.transport.send(state.deviceId, { v: 1, id, ...command, type: command.action });
    if (!sent) {
      throw this.refuse("device_offline", "The active device is offline", {
        deviceId: state.deviceId, action: command.action, why: "no socket of the active device took the command",
      });
    }
    return id;
  }

  // A socket that took a command may have died without the Hub noticing,
  // and the next report would undo what the command set. The last pause or
  // resume (`playback`) and the last seek sent for the device's stream are
  // kept, and its next welcome names them (hello()); a new stream starts
  // with none.
  async rememberCommand(state, slot, command) {
    const key = `${COMMANDS_KEY}${state.deviceId}`;
    const saved = await this.storage.get(key);
    const current = saved?.sessionId === state.sessionId ? saved : { sessionId: state.sessionId };
    await this.storage.put(key, { ...current, [slot]: command });
  }

  async stopNodeSession(sessionId) {
    try {
      await this.node.post(`/internal/v1/sessions/${encodeURIComponent(sessionId)}/stop`, {}, { timeoutMs: 5_000 });
    } catch {
      // Best effort: the node reaps idle sessions on its own.
    }
  }

  async control(action) {
    if (action === "next") return this.next();
    if (action === "previous") return this.previous();
    const state = await this.requireSession();
    const position = currentPosition(state, this.now());
    if (action === "stop") {
      this.transport.send(state.deviceId, { v: 1, type: "stop" });
      void this.stopNodeSession(state.sessionId);
      if (state.item) await recordProgress(this.db, this.userId, sourceKey(state.item.source), { position, duration: state.item.duration });
      return { state: await this.setState({ ...emptyPlaybackState(), deviceId: state.deviceId }, "control:stop") };
    }
    if (action !== "pause" && action !== "resume") throw new YoloError("invalid_request", `Unknown action ${action}`);
    const id = await this.sendCommand(state, { action });
    await this.rememberCommand(state, "playback", { id, action });
    // The owner chose: a later wake follows this, not an earlier interruption.
    // An item left with Back stays in its device's bar through a pause, and
    // so does the player that device keeps for it.
    const { interruptedAt: _interrupted, leftAt, kept, ...current } = state;
    return {
      state: await this.setState({
        ...current,
        ...(action === "pause" && leftAt ? { leftAt } : {}),
        ...(action === "pause" && kept ? { kept } : {}),
        status: action === "pause" ? "paused" : "playing",
        position,
        positionAt: this.now(),
      }, `control:${action}`),
    };
  }

  async next() {
    const item = await shiftQueue(this.db, this.userId);
    if (!item) throw new YoloError("not_found", "The queue is empty");
    void this.broadcastQueue();
    try {
      return await this.play({ source: item.source, item });
    } catch (error) {
      // Put it back at the head so a failed advance does not lose the item.
      await addQueueItems(this.db, this.userId, [item], { position: "next" });
      void this.broadcastQueue();
      throw error;
    }
  }

  async previous() {
    const state = await this.state();
    const currentKey = state.item ? sourceKey(state.item.source) : null;
    const entry = (await listHistory(this.db, this.userId, { limit: 20 })).find((candidate) => candidate.sourceKey !== currentKey);
    if (!entry) throw new YoloError("not_found", "There is nothing earlier in history");
    return this.play({ source: entry.source, item: entry });
  }

  async seek(positionSeconds) {
    const position = Number(positionSeconds);
    if (!Number.isFinite(position) || position < 0) throw new YoloError("invalid_request", "position must be a non-negative number of seconds");
    const state = await this.requireSession();
    const id = await this.sendCommand(state, { action: "seek", position });
    await this.rememberCommand(state, "seek", { id, position });
    return { state: await this.setState({ ...state, position, positionAt: this.now() }, "seek") };
  }

  async transfer(deviceRef) {
    if (!deviceRef) throw new YoloError("invalid_request", "device is required");
    const target = await this.resolveDevice(deviceRef);
    const state = await this.state();
    if (state.deviceId === target.id) return { state, device: { id: target.id, name: target.name } };
    if (!state.item) {
      if (state.deviceId) this.transport.send(state.deviceId, { v: 1, type: "deactivate", deviceId: target.id });
      return { state: await this.setState({ ...state, deviceId: target.id }, "transfer"), device: { id: target.id, name: target.name } };
    }
    const position = currentPosition(state, this.now());
    return this.play({ source: state.item.source, device: target.id, startTime: position, reason: "transfer", item: state.item });
  }

  // --- Tracks ----------------------------------------------------------

  async listTracks(source = null) {
    const state = await this.state();
    const target = source ? await claimSource(this.node, source) : state.item?.source;
    if (!target) throw new YoloError("invalid_request", "Nothing is playing; pass an item to list its tracks");
    const tracks = await this.node.get("/internal/v1/tracks", { source: JSON.stringify(target) });
    const current = !source || (state.item && sourceKey(state.item.source) === sourceKey(target));
    return { source: target, ...tracks, selected: current ? state.tracks : tracks.selected ?? null };
  }

  async setTracks({ subtitles, audio }) {
    if (subtitles !== undefined && !Array.isArray(subtitles)) throw new YoloError("invalid_request", "subtitles must be an array of track ids");
    const state = await this.requireSession();
    const result = await this.node.post(`/internal/v1/sessions/${encodeURIComponent(state.sessionId)}/tracks`, {
      source: state.item.source,
      subtitles,
      audio,
      position: currentPosition(state, this.now()),
    });
    const available = [...(result.tracks?.subtitles || []), ...(result.tracks?.audio || [])];
    const byId = (id) => available.find((track) => String(track.id) === String(id));
    const selected = {
      subtitles: subtitles ?? state.tracks.subtitles,
      audio: audio ?? state.tracks.audio,
    };
    await saveTrackPreferences(this.db, this.userId, sourceKey(state.item.source), {
      subtitles: selected.subtitles.map(byId).filter(Boolean).map(preferenceFromTrack),
      audio: selected.audio && byId(selected.audio) ? preferenceFromTrack(byId(selected.audio)) : null,
    });
    this.transport.send(state.deviceId, result.reload
      ? {
        v: 1, type: "load", id: newId("cmd", 8), stream: result.reload, item: state.item, startTime: result.reload.startTime ?? currentPosition(state, this.now()),
        autoplay: state.status !== "paused", reason: "tracks",
      }
      : { v: 1, type: "tracks", id: newId("cmd", 8), tracks: result.tracks, selected });
    if (result.reload) await this.rememberStream(state.deviceId, state.sessionId, result.reload, "tracks");
    return { state: await this.setState({ ...state, tracks: selected }, "tracks"), tracks: result.tracks };
  }

  // --- Danmaku ---------------------------------------------------------

  // A screen's danmaku settings (Agent Note 2026-10-13-danmaku): the screen
  // keeps them itself, so the Hub only passes the change on to it. Until
  // the screen acknowledges it, the change is kept, with any earlier one it
  // has not acknowledged either, and goes again after its next welcome: a
  // socket that died without the Hub noticing may have taken it.
  async setDanmaku(deviceRef, settings) {
    const device = await this.resolveDevice(deviceRef);
    const id = newId("cmd", 8);
    const sent = this.transport.send(device.id, { v: 1, type: "danmaku", id, settings });
    if (!sent) {
      throw this.refuse("device_offline", `${device.name} is offline`, { deviceId: device.id, why: "no socket of the device took the danmaku settings" });
    }
    const key = `${DANMAKU_KEY}${device.id}`;
    const unacknowledged = await this.storage.get(key);
    await this.storage.put(key, { id, settings: { ...unacknowledged?.settings, ...settings } });
    return { device: { id: device.id, name: device.name }, settings };
  }

  // --- Realtime devices ------------------------------------------------

  // `boundDeviceId` is the device a paired credential belongs to (the device
  // code flow); such a connection cannot speak for another device.
  // `address` is the address the device connected from, which marks the
  // remote path `home` when it is the home's own (edge/paths.js).
  // `bind(device)` makes this connection the device's (hub.js), before the
  // welcome is read: a `load` or `state` the Hub sends from then on reaches
  // it, and the state, read last, names any `load` sent before.
  // `isBound()` says whether it still is: another window of the device
  // that said hello meanwhile replaced it, and a replaced connection gets
  // no welcome (null), so it never acts on one; it keeps the `deactivate`
  // it was sent.
  // The welcome names the last pause or resume and seek sent for the
  // stream its state names (`commands`), and `after` is what goes to this
  // connection right after the welcome: an agent's danmaku change the
  // device has not acknowledged. A connection that died without the Hub
  // noticing may have taken them.
  async hello(message, { boundDeviceId = null, address = null, bind = () => {}, isBound = () => true } = {}) {
    let device;
    if (boundDeviceId) {
      device = await updateDevice(this.db, this.userId, boundDeviceId, {
        name: message.name, kind: message.kind, capabilities: message.capabilities,
      });
      if (!device) throw new YoloError("unauthorized", "This device was removed; pair it again");
    } else {
      device = await upsertDevice(this.db, this.userId, {
        id: typeof message.deviceId === "string" ? message.deviceId : null,
        name: message.name,
        kind: message.kind,
        capabilities: message.capabilities,
      });
    }
    bind(device);
    const [queue, playlists, media] = await Promise.all([
      listQueue(this.db, this.userId), listPlaylists(this.db, this.userId), this.media().catch(() => null),
    ]);
    const state = await this.getState();
    const [commands, danmaku] = await Promise.all([
      this.storage.get(`${COMMANDS_KEY}${device.id}`), this.storage.get(`${DANMAKU_KEY}${device.id}`),
    ]);
    if (!isBound()) return { device, welcome: null, after: [] };
    const current = state.deviceId === device.id && state.sessionId && commands?.sessionId === state.sessionId;
    return {
      device,
      welcome: {
        v: 1, type: "welcome", deviceId: device.id, state, queue, playlists, media: deviceMedia(media, address),
        ...(current ? { commands } : {}),
      },
      after: danmaku ? [{ v: 1, type: "danmaku", id: danmaku.id, settings: danmaku.settings }] : [],
    };
  }

  async saveProgress(state, position = currentPosition(state, this.now())) {
    if (!state.item) return;
    await recordProgress(this.db, this.userId, sourceKey(state.item.source), { position, duration: state.item.duration });
  }

  async deviceMessage(deviceId, message) {
    const state = await this.state();
    switch (message.type) {
      case "report": {
        if (message.viewport && typeof message.viewport === "object") {
          const { width, height, devicePixelRatio } = message.viewport;
          await this.storage.put(`${VIEWPORT_KEY}${deviceId}`, {
            width: Number(width) || null, height: Number(height) || null, devicePixelRatio: Number(devicePixelRatio) || null,
          });
        }
        if (state.deviceId !== deviceId) return;
        // A report about an older stream (one replaced while it was in
        // flight) must not move the current one.
        if (message.sessionId && message.sessionId !== state.sessionId) return;
        const position = Number(message.position);
        const { interruptedAt: _interrupted, leftAt: _left, kept: _kept, ...current } = state;
        if (message.status === "idle") {
          // The player left the video itself (its Back): the item waits
          // paused on this device at the position reached, marked `leftAt`,
          // for its now-playing bar to play it again. With `keep`, the
          // screen keeps the paused player behind its home screen, so the
          // node's session goes on, marked `kept`, until the screen lets it
          // go with a plain idle; otherwise the node's stream stops now
          // (Agent Note 2026-10-11-yolo-owns-progress-and-resume).
          if (!state.sessionId) return;
          const keep = message.keep === true;
          if (!keep) void this.stopNodeSession(state.sessionId);
          const at = Number.isFinite(position) ? position : currentPosition(state, this.now());
          await this.saveProgress(state, at);
          await this.setState({
            ...current, status: "paused", position: at, positionAt: this.now(), leftAt: state.leftAt || this.now(), ...(keep ? { kept: true } : {}),
          }, keep ? "report:kept" : "report:idle");
          return;
        }
        // The player's buffer, stalls, and picture, sent every 15 seconds
        // or so while it plays, for playback health.
        const health = sanitizeHealthReport(message.health);
        if (health) await this.storage.put(`${HEALTH_KEY}${deviceId}`, { ...health, sessionId: state.sessionId, at: this.now() });
        const status = ["loading", "playing", "paused", "buffering"].includes(message.status) ? message.status : state.status;
        const next = {
          ...current,
          status,
          position: Number.isFinite(position) ? position : state.position,
          positionAt: this.now(),
          item: state.item && Number(message.duration) > 0 && !state.item.isLive ? { ...state.item, duration: Number(message.duration) } : state.item,
        };
        await this.setState(next, "report");
        const changed = status !== state.status;
        if (next.item && (changed || this.now() - this.lastProgressWrite > PROGRESS_WRITE_INTERVAL_MS)) {
          this.lastProgressWrite = this.now();
          await this.saveProgress(next, next.position);
          void this.node.post(`/internal/v1/sessions/${encodeURIComponent(next.sessionId)}/progress`, {
            position: next.position, duration: next.item.duration, status,
          }).catch((error) => {
            if (error?.code !== "node_offline") this.log("source_progress_failed", { code: error?.code || error?.name || "error" });
          });
        }
        return;
      }
      case "ended":
        if (state.deviceId !== deviceId || message.sessionId !== state.sessionId) return;
        // Sent again after a welcome read while the first one's next item
        // was still being prepared: that one goes on.
        if (this.ending === message.sessionId) return;
        this.ending = message.sessionId;
        try {
          // Finished: the next play of this item starts over.
          if (state.item?.duration) await this.saveProgress(state, state.item.duration);
          await this.next();
        } catch (error) {
          if (error.code !== "not_found") throw error;
          void this.stopNodeSession(state.sessionId);
          await this.setState({ ...emptyPlaybackState(), deviceId }, "ended");
        } finally {
          if (this.ending === message.sessionId) this.ending = null;
        }
        return;
      case "error":
        this.log("device_error", {
          deviceId,
          sessionId: typeof message.sessionId === "string" ? message.sessionId : null,
          code: String(message.code ?? "").slice(0, 64),
          // A player's error text can quote a /m/{token} URL or a ticket.
          message: redactText(String(message.message ?? "")).slice(0, 300),
          current: state.deviceId === deviceId && message.sessionId === state.sessionId,
        });
        if (state.deviceId !== deviceId || message.sessionId !== state.sessionId) return;
        await this.noteStreamEvent(deviceId, { reason: "error", code: String(message.code ?? "").slice(0, 64) || null }).catch(() => {});
        await this.saveProgress(state);
        await this.setState({ ...state, status: "idle", position: currentPosition(state, this.now()), positionAt: this.now() }, "device_error");
        return;
      case "ack": {
        await touchDevice(this.db, this.userId, deviceId);
        // The screen has the danmaku change: no welcome sends it again.
        const key = `${DANMAKU_KEY}${deviceId}`;
        if (typeof message.id === "string" && (await this.storage.get(key))?.id === message.id) await this.storage.delete(key);
        return;
      }
      // The device's probes chose another path, or a stream failed on its
      // path: the next stream takes the path it names, "none" when it found
      // none or names none Yolo knows.
      // `hairpin` ("ok" or "failed") is the remote probe of a device at the
      // home's own address: whether the router loops back to it.
      case "network": {
        const path = mediaPath(message.path) ?? "none";
        const probes = {};
        for (const name of ["lan", "wan"]) {
          if (typeof message.probes?.[name] === "string") probes[name] = message.probes[name].slice(0, 32);
        }
        const hairpin = message.hairpin === "ok" || message.hairpin === "failed" ? message.hairpin : null;
        await this.storage.put(`${NETWORK_KEY}${deviceId}`, { path, probes, hairpin, at: this.now() });
        this.log("network", { deviceId, path, probes, hairpin, reason: typeof message.reason === "string" ? message.reason.slice(0, 64) : null });
        return;
      }
      default:
        throw new YoloError("invalid_request", `Unknown message type ${message.type}`);
    }
  }

  // The active device's last connection closed: it cannot play on, so keep
  // its place as paused rather than extrapolating a position forever.
  async deviceDisconnected(deviceId) {
    const state = await this.state();
    if (state.deviceId !== deviceId || !state.item || !["playing", "buffering", "loading"].includes(state.status)) return;
    const position = currentPosition(state, this.now());
    await this.saveProgress(state, position);
    // interruptedAt says it was playing when the connection went: the device
    // plays on when it comes back, however long it slept (owner decision
    // 2026-10-12). A paused item gets no mark and stays paused.
    await this.setState({ ...state, status: "paused", position, positionAt: this.now(), interruptedAt: this.now() }, "disconnect");
  }

  // A revoked device: drop its connections and, if it was playing, stop.
  async forgetDevice(deviceId) {
    this.transport.close?.(deviceId, 4003, "revoked");
    await Promise.all([this.storage.delete(`${COMMANDS_KEY}${deviceId}`), this.storage.delete(`${DANMAKU_KEY}${deviceId}`)]);
    const state = await this.state();
    if (state.deviceId !== deviceId) return { ok: true };
    if (state.sessionId) void this.stopNodeSession(state.sessionId);
    await this.saveProgress(state);
    await this.setState(emptyPlaybackState(), "device_removed");
    return { ok: true };
  }

  // Broadcasts are best effort and never fail the command that caused them.
  broadcastQueue() {
    return listQueue(this.db, this.userId)
      .then((queue) => this.transport.broadcast({ v: 1, type: "queue", queue }))
      .catch(() => {});
  }

  broadcastPlaylists() {
    return listPlaylists(this.db, this.userId)
      .then((playlists) => this.transport.broadcast({ v: 1, type: "playlists", playlists }))
      .catch(() => {});
  }

  // The media paths changed (edge/wan.js): each connected screen gets them
  // as its welcome would, and probes them again.
  async broadcastMedia() {
    const media = await this.media().catch(() => null);
    if (!media) return;
    this.transport.broadcast((entry) => ({ v: 1, type: "media", media: deviceMedia(media, entry.address ?? null) }));
  }

  broadcastDevices() {
    return this.listDevices()
      .then(({ devices }) => this.transport.broadcast({ v: 1, type: "devices", devices }))
      .catch(() => {});
  }

  async getDevice(id) {
    return getDevice(this.db, this.userId, id);
  }
}
