import {
  canPlay,
  currentPosition,
  emptyPlaybackState,
  isClaimed,
  isFinished,
  LOAD_REASONS,
  NETWORKS,
  newId,
  preferenceFromTrack,
  redactText,
  sourceKey,
  YoloError,
} from "@useyolo/core";
import { getDevice, listDevices, touchDevice, updateDevice, upsertDevice } from "../store/devices.js";
import { getTrackPreferences, saveTrackPreferences } from "../store/preferences.js";
import { getHistoryEntry, listHistory, recordPlay, recordProgress } from "../store/history.js";
import { listQueue, shiftQueue, addQueueItems } from "../store/queue.js";
import { listPlaylists } from "../store/playlists.js";
import { claimSource } from "../sources.js";

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
// A device's adaptive-quality cap applies to what it plays next for this
// long: a new item on the same slow connection starts at the same cap.
const QUALITY_MEMORY_MS = 30 * 60_000;
const MIN_VIDEO_KBPS = 100;
const MAX_VIDEO_KBPS = 50_000;
const PROGRESS_WRITE_INTERVAL_MS = 30_000;
const PREPARE_TIMEOUT_MS = 60_000;
const NODE_CHECK_TIMEOUT_MS = 5_000;
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
  // `lan()` resolves to the node's LAN origin for a welcome, or null
  // (Agent Note 2026-10-12-lan-direct-play).
  constructor({
    userId, storage, db, node, transport, signMediaToken = null, now = () => Date.now(), helloWaitMs = HELLO_WAIT_MS, log = consoleLog,
    lan = async () => null,
  }) {
    this.userId = userId;
    this.lan = lan;
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
  // node_offline, superseded): log why, then return the error to throw.
  refuse(code, message, fields = {}) {
    this.log("decision", { decision: code, reason: message, ...fields });
    return new YoloError(code, message);
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
    const network = await this.deviceNetwork(device, { network: requestedNetwork, requester });

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
    // Which path the stream took: the node serves "lan" only while its LAN
    // listener does, whatever was asked.
    this.log("stream", {
      sessionId: nextSessionId, deviceId: device.id, reason, requester, asked: network, network: descriptor.network ?? "tunnel",
      deliveryType: descriptor.delivery?.type ?? null, maxVideoKbps: descriptor.limits?.maxVideoKbps ?? null,
    });

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
    if (reason === "play" || reason === "transfer") {
      await recordPlay(this.db, this.userId, { ...playbackItem, position });
    }
    this.lastProgressWrite = this.now();
    await this.setState(state, `play:${reason}`);
    return { state, device: { id: device.id, name: device.name } };
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

  // How the device reaches the node's media
  // (Agent Note 2026-10-12-lan-direct-play): what its own request says, which
  // is kept, else its last `network` report. Others' requests never set it.
  async deviceNetwork(device, { network, requester }) {
    const key = `${NETWORK_KEY}${device.id}`;
    if (NETWORKS.includes(network) && requester === device.id) {
      await this.storage.put(key, { lan: network === "lan", at: this.now() });
      return network;
    }
    return (await this.storage.get(key))?.lan ? "lan" : "tunnel";
  }

  async requireSession() {
    const state = await this.state();
    if (!state.sessionId || !state.deviceId) throw new YoloError("invalid_request", "Nothing is playing");
    return state;
  }

  async sendCommand(state, command) {
    const sent = this.transport.send(state.deviceId, { v: 1, id: newId("cmd", 8), ...command, type: command.action });
    if (!sent) {
      throw this.refuse("device_offline", "The active device is offline", {
        deviceId: state.deviceId, action: command.action, why: "no socket of the active device took the command",
      });
    }
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
    await this.sendCommand(state, { action });
    // The owner chose: a later wake follows this, not an earlier interruption.
    // An item left with Back stays in its device's bar through a pause.
    const { interruptedAt: _interrupted, leftAt, ...current } = state;
    return {
      state: await this.setState({
        ...current,
        ...(action === "pause" && leftAt ? { leftAt } : {}),
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
    await this.sendCommand(state, { action: "seek", position });
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
    return { state: await this.setState({ ...state, tracks: selected }, "tracks"), tracks: result.tracks };
  }

  // --- Realtime devices ------------------------------------------------

  // `boundDeviceId` is the device a paired credential belongs to (the device
  // code flow); such a connection cannot speak for another device.
  async hello(message, { boundDeviceId = null } = {}) {
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
    const [state, queue, playlists, lan] = await Promise.all([
      this.getState(), listQueue(this.db, this.userId), listPlaylists(this.db, this.userId), this.lan().catch(() => null),
    ]);
    return { device, welcome: { v: 1, type: "welcome", deviceId: device.id, state, queue, playlists, lan: lan ?? null } };
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
        const { interruptedAt: _interrupted, leftAt: _left, ...current } = state;
        if (message.status === "idle") {
          // The player left the video itself (its Back): the node's stream
          // stops, and the item waits paused on this device at the position
          // reached, marked `leftAt`, for its now-playing bar to play it
          // again (Agent Note 2026-10-11-yolo-owns-progress-and-resume).
          if (!state.sessionId) return;
          void this.stopNodeSession(state.sessionId);
          const at = Number.isFinite(position) ? position : currentPosition(state, this.now());
          await this.saveProgress(state, at);
          await this.setState({ ...current, status: "paused", position: at, positionAt: this.now(), leftAt: this.now() }, "report:idle");
          return;
        }
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
        // Finished: the next play of this item starts over.
        if (state.item?.duration) await this.saveProgress(state, state.item.duration);
        try {
          await this.next();
        } catch (error) {
          if (error.code !== "not_found") throw error;
          void this.stopNodeSession(state.sessionId);
          await this.setState({ ...emptyPlaybackState(), deviceId }, "ended");
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
        await this.saveProgress(state);
        await this.setState({ ...state, status: "idle", position: currentPosition(state, this.now()), positionAt: this.now() }, "device_error");
        return;
      case "ack":
        await touchDevice(this.db, this.userId, deviceId);
        return;
      // The device's probe of the node's LAN origin changed its answer, or
      // a LAN stream failed: the next stream takes that path.
      case "network": {
        const lan = message.lan === true;
        await this.storage.put(`${NETWORK_KEY}${deviceId}`, { lan, at: this.now() });
        this.log("network", { deviceId, lan, reason: typeof message.reason === "string" ? message.reason.slice(0, 64) : null });
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

  broadcastDevices() {
    return this.listDevices()
      .then(({ devices }) => this.transport.broadcast({ v: 1, type: "devices", devices }))
      .catch(() => {});
  }

  async getDevice(id) {
    return getDevice(this.db, this.userId, id);
  }
}
