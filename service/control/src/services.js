import {
  CANVAS_LIMITS, CONTROL_ACTIONS, danmakuSettingsPatch, formatTimestamp, isClaimed, isFinished, isHttpUrl, isSourceKey, OWNER_PROFILE, parseTimestamp, skipTarget, sourceFromRef,
  sourceKey, toYoloError, YoloError,
} from "@useyolo/core";
import * as queueStore from "./store/queue.js";
import * as playlistStore from "./store/playlists.js";
import * as historyStore from "./store/history.js";
import * as conversationStore from "./store/agent-conversations.js";
import * as shareStore from "./store/share-links.js";
import { clearItemMatch, getItemMatch, setItemMatch } from "./store/item-matches.js";
import * as profileStore from "./store/profiles.js";
import { deleteDevice, getDevice, listDevices, renameDevice, setDeviceProfile } from "./store/devices.js";
import { readMediaSettings } from "./store/media-settings.js";
import { readVoiceLanguages } from "./store/voice-settings.js";
import { recordNodeSeen } from "./store/users.js";
import { claimSource } from "./sources.js";

// One service layer behind both the MCP tools and the /v1 HTTP API, so the
// two surfaces cannot drift. `hub` is HubCore in tests and an RPC proxy to the
// Hub Durable Object in the Worker; `node` wraps nodeFetch().

const METADATA_TIMEOUT_MS = 20_000;
// A screen rebuilding its own stream never asks whether to replace it.
const REBUILDS = new Set(["recovery", "seek", "quality", "tracks"]);
// Queueing an item with the ones after it in its run: a source may list a
// long playlist for several seconds, and an agent asks for a season at most.
const SEQUENCE_TIMEOUT_MS = 20_000;
// A screen's home row waits this long for what follows a finished episode.
const CONTINUE_TIMEOUT_MS = 5_000;
const QUEUE_RUN_MAX = 30;
const HEALTH_TIMEOUT_MS = 3_000;
// The agent's answer starts at once; its stream then runs for as long as the
// agent works (Agent Note 2026-10-18-agent-from-the-screen).
const AGENT_TIMEOUT_MS = 15_000;
const MAX_AGENT_TEXT = 1000;
// The node's transcriber gets 30 seconds of its own; the upload comes first.
const VOICE_TIMEOUT_MS = 40_000;
// A transcript may need the source's metadata and a subtitle download first.
const TRANSCRIPT_TIMEOUT_MS = 45_000;
// Without a range, a transcript covers this much either side of the position.
const TRANSCRIPT_AROUND_SECONDS = 60;

const round = (value) => Math.round(Number(value) || 0);
// Bytes as base64, in chunks: the node's internal API carries JSON.
function base64(bytes) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}
// A track as an agent needs it: its id for set_tracks or a transcript, its
// language and name, and whether it is a picture or an automatic caption.
const briefTrack = (track) => ({
  id: String(track.id),
  language: track.language || "",
  name: track.name || "",
  ...(track.format === "image" ? { image: true } : {}),
  ...(track.auto ? { auto: true } : {}),
});

// The node gives up on a frame after 15 seconds and on a storyboard after 30
// (media/frames.js); these leave its answer time to arrive.
const FRAME_TIMEOUT_MS = 18_000;
const STORYBOARD_TIMEOUT_MS = 36_000;
export const FRAME_WIDTH = 1280;

const olderNode = (error, what) => (error?.code === "not_found" && error.message === "No such endpoint"
  ? new YoloError("not_found", `The media node runs a release without ${what}; upgrade it (npm run yolo -- upgrade)`)
  : error);

// The node reads an item's comments from its source the first time, which
// for some sources starts a subprocess.
const COMMENTS_TIMEOUT_MS = 30_000;
const DEFAULT_COMMENT_WINDOW = 30;
const MAX_COMMENT_WINDOW = 120;
const DEFAULT_COMMENT_LIMIT = 60;
const MAX_COMMENT_LIMIT = 200;

// "What are people saying here": the comments of a range, compact. The same
// text said several times is one entry with `n`, at its first time; past
// `limit`, the most repeated and those nearest `at` stay.
function summarizeComments(comments, { at, limit }) {
  const byText = new Map();
  for (const comment of comments) {
    const key = comment.text.toLowerCase();
    const known = byText.get(key);
    if (known) known.n += 1;
    else byText.set(key, { t: comment.t, text: comment.text, n: 1 });
  }
  const distinct = [...byText.values()];
  const kept = distinct.length <= limit ? distinct
    : [...distinct].sort((left, right) => right.n - left.n || Math.abs(left.t - at) - Math.abs(right.t - at)).slice(0, limit);
  return {
    total: comments.length,
    distinct: distinct.length,
    comments: kept.sort((left, right) => left.t - right.t).map(({ t, text, n }) => (n > 1 ? { t, text, n } : { t, text })),
  };
}

// An agent's id as the node's plugins register it.
const agentId = (id) => typeof id === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(id);

const agentWords = (text) => {
  const words = typeof text === "string" ? text.trim() : "";
  if (!words) throw new YoloError("invalid_request", "text is required");
  if (words.length > MAX_AGENT_TEXT) throw new YoloError("invalid_request", `text is longer than ${MAX_AGENT_TEXT} characters`);
  return words;
};

const ndjson = (text) => new Response(text).body;

// The node's answer stream passed through unchanged after `first`, read on
// the way for what the conversation keeps: the tools called, then the end.
// The end is recorded before the stream closes, or when the screen stops it.
function recordedAnswer(body, { first, record, waitUntil }) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const steps = [];
  let buffer = "";
  let end = null;
  let recorded = false;
  const finish = (fallback) => {
    if (recorded) return Promise.resolve();
    recorded = true;
    return record({ steps, ...(end ?? fallback) });
  };
  const take = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event?.type === "tool" && typeof event.name === "string") steps.push(event.name);
    else if (event?.type === "done") {
      end = {
        status: "done",
        text: typeof event.text === "string" ? event.text : "",
        agentId: typeof event.agent === "string" ? event.agent : null,
        session: typeof event.session === "string" ? event.session : null,
      };
    } else if (event?.type === "error") end = { status: "error", text: String(event.error?.message ?? "") };
  };
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(first));
    },
    async pull(controller) {
      let read;
      try {
        read = await reader.read();
      } catch (error) {
        // The node or its tunnel went away mid-answer: keep that, and end
        // the screen's stream with it.
        const failed = { status: "error", text: `The media node stopped answering: ${toYoloError(error).message}` };
        const ended = end;
        await finish(failed);
        // A newline first ends any line cut short, even inside a character
        // the decoder still holds, so the error is a line of its own; a
        // blank line is skipped by readers.
        if (!ended) controller.enqueue(encoder.encode(`\n${JSON.stringify({ type: "error", error: { code: "node_offline", message: failed.text, retryable: true } })}\n`));
        controller.close();
        return;
      }
      const { value, done } = read;
      if (done) {
        if (buffer.trim()) take(buffer);
        await finish({ status: "error", text: "The agent stopped without an answer" });
        controller.close();
        return;
      }
      controller.enqueue(value);
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        take(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    },
    cancel(reason) {
      waitUntil(finish({ status: "stopped", text: "" }));
      return reader.cancel(reason);
    },
  });
}

// `allowFrame()` is the per-agent frame limit (rate-limit.js); `log` writes
// that a frame was served, and nothing about which. `agent` names who asks
// ("device:<id>", "client:<id>"), and `origin` is Yolo's public origin, for
// the share links they make. `requester` is the paired screen whose own
// credential asks (/v1), which a request that names no screen is for, and
// whose default profile's history it reads (Agent Note
// 2026-10-31-screen-sessions); null for an agent or the owner's pages.
export function createServices({
  db, userId, hub, node, allowFrame = async () => true, log = (record) => console.log(record), agent = null, origin = null, requester = null,
}) {
  // The profile whose history a request reads: `profile` (an id or a
  // name) when given, else the asking screen's default, else the owner's.
  // As the store's `owner` (rows.js profileScope()).
  async function viewer(profile = null) {
    let id = OWNER_PROFILE;
    if (profile) id = (await profileStore.resolveProfile(db, userId, profile)).id;
    else if (requester) id = (await getDevice(db, userId, requester))?.profile ?? OWNER_PROFILE;
    return id === OWNER_PROFILE ? userId : { userId, profileId: id };
  }
  // Who the request is for, as the Hub takes it.
  const on = (device = null) => ({ device, requester });

  // Claim a URL and fetch title, thumbnail and duration. Best effort: queue
  // and playlist edits must keep working while the node is offline (§8), so a
  // URL then stays unclaimed until it plays.
  async function describe(ref) {
    try {
      const metadata = await node.post("/internal/v1/metadata", isClaimed(ref) ? { source: ref } : { url: ref.url }, {
        timeoutMs: METADATA_TIMEOUT_MS,
      });
      return {
        source: metadata.source ?? ref, title: metadata.title, thumbnail: metadata.thumbnail, duration: metadata.duration, metadata: {},
      };
    } catch (error) {
      if (error?.code !== "node_offline" && error?.code !== "resolve_failed") throw error;
      return { source: ref, metadata: { pendingMetadata: true } };
    }
  }

  // A show's entry as screens continue it: the newest episode, or once it
  // is finished, the next in its run, with that one's own progress. Without
  // the node, or at the run's end, it stays the finished episode.
  async function continueShow({ showKey, ...entry }, owner = userId) {
    const shown = { ...entry, sourceKey: showKey };
    if (!isFinished(entry.position, entry.duration)) return shown;
    let next = null;
    try {
      const { sequence } = await node.get("/internal/v1/sequence", sourceQuery(entry.source), { timeoutMs: CONTINUE_TIMEOUT_MS });
      next = sequence?.items?.[1] ?? null;
    } catch {
      return shown;
    }
    if (!next?.source) return shown;
    const saved = await historyStore.getHistoryEntry(db, owner, sourceKey(next.source));
    const duration = next.duration ?? saved?.duration ?? null;
    return {
      ...shown,
      source: next.source,
      title: next.title ?? saved?.title ?? (next.label ? `${entry.title} · ${next.label}` : entry.title),
      thumbnail: next.thumbnail ?? saved?.thumbnail ?? null,
      duration,
      position: saved && !isFinished(saved.position, duration) ? saved.position : 0,
      playCount: saved?.playCount ?? 0,
      watched: saved?.watched ?? false,
    };
  }

  // Yolo's own progress over what a source's listing says (Agent Note
  // 2026-10-11-yolo-owns-progress-and-resume): an item in history resumes
  // at its position there and is watched when Yolo or its source says so;
  // a show or season counts its episodes watched in Yolo, the larger of
  // that count and the source's. Listed items name the show and season of
  // their entries that have none yet. `parents` stays inside Yolo.
  // The history is the asking screen's default profile's (viewer()).
  async function withHistory(items) {
    const listed = items.filter(Boolean);
    if (!listed.length) return items;
    const owner = await viewer();
    const groups = listed.filter((item) => item.kind === "show" || item.kind === "season" || item.episodes != null);
    const [entries, counts] = await Promise.all([
      historyStore.historyEntries(db, owner, listed.map((item) => item.id)),
      groups.length ? historyStore.watchedCounts(db, owner, groups.map((item) => item.id)) : new Map(),
    ]);
    const unnamed = listed.filter((item) => item.parents?.length && entries.get(item.id)?.showKey === null);
    if (unnamed.length) {
      await historyStore.fillParents(db, owner, unnamed.map((item) => ({ key: item.id, parents: item.parents })))
        .catch((error) => log({ kind: "history", event: "parents_failed", userId, code: error?.code || error?.name || "error" }));
    }
    return items.map((item) => {
      if (!item) return item;
      const { parents: _parents, ...shown } = item;
      const entry = entries.get(item.id);
      if (entry) {
        const duration = item.duration ?? entry.duration;
        const finished = isFinished(entry.position, duration);
        shown.resumeAt = !finished && entry.position > 0 ? round(entry.position) : null;
        shown.watched = Boolean(item.watched) || entry.watched || finished;
      }
      const watched = counts.get(item.id) ?? 0;
      if (watched > 0) {
        const total = Number(item.episodes) > 0 ? Number(item.episodes) : null;
        shown.watchedEpisodes = Math.max(Number(item.watchedEpisodes) || 0, total ? Math.min(total, watched) : watched);
        if (total && shown.watchedEpisodes >= total) shown.watched = true;
      }
      return shown;
    });
  }

  // Realtime broadcasts are best effort; a failed one must not fail the edit.
  const notifyQueue = (deviceId) => Promise.resolve().then(() => hub.broadcastQueue(deviceId)).catch(() => {});
  // The screen whose queue an edit is for: `device`, else the asking
  // screen's, else the default rule's (Agent Note 2026-10-31-screen-sessions).
  const queueScreen = async (device = null) => (await hub.getQueueScreen({ device, requester })).id;
  const notifyPlaylists = () => Promise.resolve().then(() => hub.broadcastPlaylists()).catch(() => {});

  function refToSource({ url, itemId }) {
    if (url && itemId) throw new YoloError("invalid_request", "Pass either url or item_id, not both");
    return sourceFromRef(url ?? itemId);
  }

  async function nodeHealth() {
    try {
      const health = await node.get("/internal/v1/health", undefined, { timeoutMs: HEALTH_TIMEOUT_MS });
      void recordNodeSeen(db, userId, { version: health?.version ?? null }).catch(() => {});
      return { online: true, ...health };
    } catch (error) {
      return { online: false, error: toYoloError(error).message };
    }
  }

  // The item an agent asks about (Agent Note 2026-10-07-remote-mcp-server):
  // `itemId` (a library item id or a URL), else what plays now. `playing` is
  // the playback state when it is that item, for its position, session, and
  // selected tracks.
  // Without `itemId`, what plays on the default rule's screen; with it,
  // the session that plays it, the asking screen's first.
  async function insightTarget(itemId, device = null) {
    if (itemId) {
      const source = await claimSource(node, sourceFromRef(itemId));
      const key = sourceKey(source);
      const { sessions } = await hub.sessions();
      const here = device ?? requester;
      const playing = sessions.find((session) => session.deviceId === here && sourceKey(session.item.source) === key)
        ?? sessions.find((session) => session.inUse && sourceKey(session.item.source) === key) ?? null;
      return { source, playing, item: { id: key, ...(playing ? { title: playing.item.title } : {}) } };
    }
    const state = await hub.getState(on(device));
    if (!state.item) throw new YoloError("invalid_request", "Nothing is playing; pass item_id to ask about an item");
    return { source: state.item.source, playing: state, item: { id: sourceKey(state.item.source), title: state.item.title } };
  }

  const sourceQuery = (source) => ({ source: JSON.stringify(source) });

  function transcriptRequest({ source, playing }, { track, language }) {
    return {
      source,
      sessionId: playing?.sessionId ?? null,
      track: track ?? null,
      language: language ?? null,
      selected: playing?.tracks?.subtitles ?? [],
    };
  }

  // The item a frame or storyboard is of (Agent Note 2026-10-13-video-frames),
  // found as insightTarget() finds it: `state` is the playback state when
  // it is the item playing now, else null. A live stream has no fixed frames.
  async function pictureTarget({ url, itemId, source }) {
    if (url && itemId) throw new YoloError("invalid_request", "Pass either url or item_id, not both");
    const { source: target, playing: state } = await insightTarget(source ?? url ?? itemId ?? null);
    if (state?.item.isLive) {
      throw new YoloError("invalid_request", `"${state.item.title}" is a live stream: frames can be read only from a video with a fixed length`);
    }
    return { state, target, playing: Boolean(state) };
  }

  // What plays now, for an agent asked from a screen
  // (Agent Note 2026-10-18-agent-from-the-screen), so "this" and "here" need
  // no explanation: the item, where in it, its status, and the screen it
  // plays on. Null when nothing plays, or when the state cannot be read.
  // A choice names an item_id or url; Yolo looks it up for the title, cover,
  // and length a screen shows, so nothing the agent wrote about the item but
  // its one line reaches the screen (Agent Note 2026-10-21-agent-canvas).
  async function lookedUpChoices(props = {}) {
    if (!Array.isArray(props?.options)) return props;
    const options = await Promise.all(props.options.slice(0, CANVAS_LIMITS.choices + 1).map(async (option) => {
      if (!option || typeof option !== "object" || option.item) return option;
      const itemId = option.item_id ?? option.itemId ?? null;
      if (!itemId && !option.url) return { label: option.label, note: option.note };
      const found = await describe(refToSource({ url: option.url, itemId }));
      return {
        item: { source: found.source, title: found.title ?? null, thumbnail: found.thumbnail ?? null, duration: found.duration ?? null },
        note: option.note,
      };
    }));
    return { ...props, options };
  }

  const lookedUp = async (object) => (object?.kind === "choices" ? { ...object, props: await lookedUpChoices(object.props) } : object);

  // `deviceId`'s own session, and the other sessions in use, so "this"
  // stays the asking screen's and "what's on the TV" can be answered (Agent
  // Note 2026-10-31-screen-sessions). Without a screen, `playing` is the
  // default rule's, null when it names none.
  const briefPlaying = (state) => ({
    itemId: sourceKey(state.item.source),
    title: state.item.title ?? null,
    position: Math.round((Number(state.position) || 0) * 10) / 10,
    duration: state.item.isLive ? null : Number(state.item.duration) || null,
    status: state.status,
    device: state.device ? { id: state.device.id, name: state.device.name } : null,
    ...(state.profile && state.profile.id !== OWNER_PROFILE ? { profile: state.profile.name } : {}),
  });
  async function playingNow(deviceId = null) {
    try {
      const { sessions } = await hub.sessions();
      const own = deviceId
        ? sessions.find((session) => session.deviceId === deviceId)
        : sessions.filter((session) => session.inUse && session.profile.id === OWNER_PROFILE).length === 1
          ? sessions.find((session) => session.inUse && session.profile.id === OWNER_PROFILE) : null;
      const playing = own && own.status !== "idle" ? briefPlaying(own) : null;
      const others = sessions.filter((session) => session.inUse && session !== own).map(briefPlaying);
      return { playing, others };
    } catch (error) {
      log({ message: "agent context not read", error: toYoloError(error).message });
      return { playing: null, others: [] };
    }
  }

  const services = {
    // `media` is the owner's media path settings: whether the relay may
    // carry media, its mode, and remote access
    // (Agent Note 2026-10-13-media-off-the-worker).
    // Every screen's session, and which one a command without `device`
    // reaches now (`target`), or why none does.
    async status() {
      const [node, { sessions }, settings, target] = await Promise.all([
        nodeHealth(),
        hub.sessions(),
        readMediaSettings(db, userId),
        hub.getState(on()).then(
          (state) => (state.deviceId ? { device: state.deviceId } : { none: "Nothing of the owner's is playing: a play goes to the owner's only online screen, and a pause or seek needs device" }),
          (error) => ({ ambiguous: error.message }),
        ),
      ]);
      const listed = await Promise.all(sessions.map(async (session) => {
        const queue = await queueStore.listQueue(db, userId, session.deviceId);
        return {
          device: session.device,
          sessionId: session.sessionId,
          profile: session.profile,
          status: session.status,
          inUse: session.inUse,
          item: session.item,
          position: Math.round(session.position * 10) / 10,
          tracks: session.tracks,
          ...(session.handedTo ? { handedTo: session.handedTo } : {}),
          ...(session.upNext ? { upNext: session.upNext } : {}),
          queue: { length: queue.length, upNext: queue.slice(0, 3) },
        };
      }));
      return {
        sessions: listed, target, node,
        media: { relay: settings.relay, relayMode: settings.relayMode, remote: settings.remote },
      };
    },

    async me() {
      return { userId, node: await nodeHealth() };
    },

    devices: () => hub.listDevices(),

    // The path of each screen's last stream and the streams per path over
    // 7 days (owner settings), and telling connected screens the media
    // paths again after the owner changed the relay's mode.
    mediaUsage: () => hub.mediaUsage(),
    refreshMedia: () => hub.broadcastMedia(),

    // The owner's name and type for a device, and its default profile (an
    // id or a name; "family" makes Family): `ref` is its id, or its current
    // name (MCP).
    async renameDevice(ref, { name, kind, profile } = {}) {
      const wanted = String(ref ?? "").trim();
      if (!wanted) throw new YoloError("invalid_request", "device is required");
      let id = wanted;
      if (!(await getDevice(db, userId, wanted))) {
        const byName = (await listDevices(db, userId)).filter((device) => device.name.toLowerCase() === wanted.toLowerCase());
        if (byName.length > 1) throw new YoloError("invalid_request", `Several devices are named "${wanted}"; use the device id from list_devices`);
        if (!byName.length) throw new YoloError("not_found", `No device matches "${wanted}". Use list_devices to see devices.`);
        id = byName[0].id;
      }
      let device = name != null || kind != null ? await renameDevice(db, userId, id, { name, kind }) : null;
      if (profile != null && profile !== "") device = await setDeviceProfile(db, userId, id, (await profileStore.resolveProfile(db, userId, profile)).id);
      if (!device) throw new YoloError("invalid_request", "Pass a name, a kind, or a profile");
      void Promise.resolve().then(() => hub.broadcastDevices()).catch(() => {});
      return device;
    },

    // --- Profiles (Agent Note 2026-10-31-screen-sessions) -------------------

    profiles: async () => ({ profiles: await profileStore.listProfiles(db, userId) }),
    async createProfile({ name } = {}) {
      const profile = await profileStore.createProfile(db, userId, { name });
      void Promise.resolve().then(() => hub.broadcastDevices()).catch(() => {});
      return profile;
    },
    async renameProfile(id, { name } = {}) {
      const profile = await profileStore.renameProfile(db, userId, String(id ?? ""), { name });
      void Promise.resolve().then(() => hub.broadcastDevices()).catch(() => {});
      return profile;
    },
    async deleteProfile(id) {
      const profile = await profileStore.deleteProfile(db, userId, String(id ?? ""));
      void Promise.resolve().then(() => hub.broadcastDevices()).catch(() => {});
      return { deleted: profile };
    },

    // Removing a device deletes its paired credential (revocation) and
    // closes its connections; pairing it again needs the owner's approval.
    async deleteDevice(id) {
      await deleteDevice(db, userId, id);
      await Promise.resolve().then(() => hub.forgetDevice(id)).catch(() => {});
      void Promise.resolve().then(() => hub.broadcastDevices()).catch(() => {});
      return { deleted: id, revoked: true };
    },

    playbackState: ({ device = null } = {}) => hub.getState(on(device)),
    sessions: () => hub.sessions(),

    // --- Library ----------------------------------------------------------

    async search({ query, type = null, limit = 20 }) {
      const text = String(query ?? "").trim();
      if (!text) throw new YoloError("invalid_request", "query is required");
      if (isHttpUrl(text)) {
        // `kind: "url"` says the result came from looking up a URL; the
        // claiming plugin is in `source.plugin`.
        const metadata = await node.post("/internal/v1/metadata", { url: text }, { timeoutMs: METADATA_TIMEOUT_MS });
        return { results: [{ id: text, kind: "url", ...metadata }] };
      }
      const found = await node.get("/internal/v1/library/search", { q: text, type, limit });
      return { ...found, results: await withHistory(found.results ?? []) };
    },

    async browse({ libraryId = null, itemId = null, offset = 0, limit = 50 } = {}) {
      if (itemId) {
        const { parent = null, ...children } = await node.get(`/internal/v1/library/items/${encodeURIComponent(itemId)}/children`);
        const [shown, ...items] = await withHistory([parent, ...(children.items ?? [])]);
        return { ...children, ...(shown ? { parent: shown } : {}), items };
      }
      if (libraryId) {
        const page = await node.get(`/internal/v1/library/${encodeURIComponent(libraryId)}/items`, { offset, limit });
        return { ...page, items: await withHistory(page.items ?? []) };
      }
      return node.get("/internal/v1/library");
    },

    artwork: (itemId, variant) => node.request(`/internal/v1/library/items/${encodeURIComponent(itemId)}/artwork`, {
      query: { variant }, raw: true,
    }),

    // A thumbnail on another host, fetched by the node for a screen.
    thumbnail: (url) => node.request("/internal/v1/thumbnail", { query: { url }, raw: true }),

    // --- Playback ---------------------------------------------------------

    // Without startAt the Hub resumes: Yolo's history first, then the
    // source's own watch position, then the start. `requester` is the paired
    // device whose credential asks (/v1 only; agents have none); `network`
    // is how that device reaches the node now ("lan", "wan", or "relay").
    // Without `device`, the asking screen when it plays, else the default
    // rule's (Agent Note 2026-10-31-screen-sessions). A named screen that
    // someone else is using is refused with screen_busy unless `replace`.
    async play({
      url, itemId, queueItemId, source, device = null, startAt = null, reason = "play", autoplay = true, replaces = null,
      maxVideoKbps = undefined, network = undefined, replace = false,
    }) {
      const refs = [url, itemId, queueItemId, source].filter((value) => value != null && value !== "");
      if (refs.length !== 1) throw new YoloError("invalid_request", "Pass exactly one of url, item_id, or queue_item_id");
      if (queueItemId) {
        // A queue item plays on the screen whose queue it is in.
        const screen = await queueScreen(device);
        const item = await queueStore.shiftQueue(db, userId, screen, queueItemId);
        if (!item) throw new YoloError("not_found", `Queue item ${queueItemId} not found`);
        notifyQueue(screen);
        try {
          // A queue item keeps the run that plays when the queue runs out.
          return await hub.play({ source: item.source, device: screen, startTime: startAt, item, requester, network, run: "keep", replace: Boolean(replace) });
        } catch (error) {
          await queueStore.addQueueItems(db, userId, screen, [item], { position: "next" });
          notifyQueue(screen);
          throw error;
        }
      }
      const resolved = await claimSource(node, source ?? refToSource({ url, itemId }));
      return hub.play({
        source: resolved, device, startTime: startAt, reason, autoplay, replaces, requester, maxVideoKbps, network,
        ...(REBUILDS.has(reason) ? {} : { replace: Boolean(replace) }),
      });
    },

    // A device's home screen names its first items; the Hub may have the
    // node resolve them ahead for that device. Best effort: never an error.
    warm: ({ sources = [], network } = {}) => hub.warm({ sources, requester, network }),
    // What `next` would play after `after`, a source key (Agent Note
    // 2026-10-23-up-next): what plays now without it, on `device`'s session.
    upNext({ after = null, device = null } = {}) {
      if (after != null && !isSourceKey(after)) throw new YoloError("invalid_request", "after must be a source key: the plugin, a colon, and the item id");
      return hub.upNextList({ after, ...on(device) });
    },

    // Each for `device`'s session, else the default rule's.
    async control(action, { device = null } = {}) {
      if (!CONTROL_ACTIONS.includes(action)) {
        throw new YoloError("invalid_request", `action must be one of ${CONTROL_ACTIONS.join(", ")}`);
      }
      return hub.control(action, on(device));
    },

    seek: (position, { device = null } = {}) => hub.seek(position, on(device)),
    // "Continue here" and "Move to": `from`'s session continues on `device`.
    transfer: ({ device, from = null, replace = false } = {}) => hub.transfer({ device, from, replace: Boolean(replace), requester }),
    async listTracks({ source, url, itemId, device = null } = {}) {
      const ref = source ?? (url || itemId ? refToSource({ url, itemId }) : null);
      return hub.listTracks(ref ? await claimSource(node, ref) : null, on(device));
    },
    setTracks: ({ subtitles, audio, device = null }) => hub.setTracks({ subtitles, audio, ...on(device) }),

    // --- Understanding an item (Agent Note 2026-10-07-remote-mcp-server) ----

    // Details from the source in Yolo's one shape, merged with the work a
    // metadata plugin matched it to (the owner's own match first; Agent Note
    // 2026-10-25-metadata-plugins), its tracks, the user's progress from
    // Yolo's history (else the source's own record), and the cover Yolo
    // knows from what plays or from history.
    async item({ itemId } = {}) {
      const target = await insightTarget(itemId);
      const key = target.item.id;
      const match = await getItemMatch(db, userId, key);
      const [details, tracks, entry] = await Promise.all([
        node.get("/internal/v1/details", { ...sourceQuery(target.source), ...(match ? { match: JSON.stringify(match) } : {}) }, { timeoutMs: METADATA_TIMEOUT_MS }),
        node.get("/internal/v1/tracks", sourceQuery(target.source), { timeoutMs: METADATA_TIMEOUT_MS }).catch(() => null),
        historyStore.getHistoryEntry(db, target.playing?.profile && target.playing.profile.id !== OWNER_PROFILE
          ? { userId, profileId: target.playing.profile.id } : await viewer(), key),
      ]);
      const { progress: sourceProgress, ...fields } = details ?? {};
      const duration = fields.duration ?? target.playing?.item?.duration ?? entry?.duration ?? null;
      const position = target.playing ? target.playing.position : entry?.position ?? null;
      let progress = null;
      if (position != null) {
        progress = {
          position: round(position),
          ...(duration ? { percent: Math.min(100, round((100 * position) / duration)), watched: Boolean(entry?.watched) || isFinished(position, duration) } : {}),
          ...(entry ? { lastPlayed: new Date(entry.updatedAt).toISOString() } : {}),
          ...(target.playing ? { playingNow: true } : {}),
        };
      } else if (sourceProgress) {
        progress = { ...sourceProgress, from: "source" };
      }
      const thumbnail = target.playing?.item?.thumbnail ?? entry?.thumbnail ?? null;
      return {
        id: key,
        ...fields,
        ...(thumbnail ? { thumbnail } : {}),
        ...(tracks ? {
          tracks: {
            subtitles: (tracks.subtitles ?? []).map(briefTrack),
            audio: (tracks.audio ?? []).map(briefTrack),
            ...(target.playing ? { selected: target.playing.tracks } : {}),
          },
        } : {}),
        ...(progress ? { progress } : {}),
      };
    },

    // The owner's match of an item to a work: a candidate from item() or
    // searchMetadata(), `none` to keep it plain, or `clear` to let Yolo
    // identify it again. Returns the item's details as they now are.
    async matchItem({ itemId, candidate = null, none = false, clear = false } = {}) {
      const target = await insightTarget(itemId);
      const key = target.item.id;
      const choices = [Boolean(candidate), none, clear].filter(Boolean).length;
      if (choices !== 1) throw new YoloError("invalid_request", "Pass exactly one of candidate, none, or clear");
      if (clear) await clearItemMatch(db, userId, key);
      else if (none) await setItemMatch(db, userId, key, { none: true });
      else {
        if (typeof candidate?.plugin !== "string" || typeof candidate.id !== "string") {
          throw new YoloError("invalid_request", "candidate is one of the candidates get_item or search_metadata returned, with its plugin and id");
        }
        const { plugin, ...rest } = candidate;
        await setItemMatch(db, userId, key, { plugin, candidate: rest });
      }
      return this.item({ itemId: key });
    },

    // Works by name in the metadata plugins, to correct a match.
    searchMetadata: ({ query, kind = null, year = null, limit = 10 } = {}) => node.get("/internal/v1/metadata/search", {
      q: String(query ?? ""),
      ...(kind ? { kind } : {}),
      ...(year ? { year } : {}),
      limit,
    }, { timeoutMs: METADATA_TIMEOUT_MS }),

    // A page of what is said, as "m:ss text" lines: around the position when
    // nothing else is asked and the item plays, else from the start.
    async transcript({ itemId, from = null, to = null, language = null, track = null, maxChars = null } = {}) {
      const target = await insightTarget(itemId);
      let start = from;
      let end = to;
      if (start == null && end == null && target.playing) {
        start = Math.max(0, target.playing.position - TRANSCRIPT_AROUND_SECONDS);
        end = target.playing.position + TRANSCRIPT_AROUND_SECONDS;
      }
      const page = await node.post("/internal/v1/transcript", {
        ...transcriptRequest(target, { track, language }), from: start, to: end, maxChars,
      }, { timeoutMs: TRANSCRIPT_TIMEOUT_MS });
      return {
        item: target.item,
        track: page.track,
        ...(target.playing ? { position: round(target.playing.position) } : {}),
        from: page.from,
        to: page.to,
        text: page.count ? page.text : "(no subtitles in this range)",
        ...(page.nextFrom != null ? { nextFrom: page.nextFrom } : {}),
        length: page.length,
      };
    },

    // Moments where `query` is said, with `at` in seconds for seek.
    async searchTranscript({ query, itemId, language = null, track = null, limit = 10 } = {}) {
      const text = String(query ?? "").trim();
      if (!text) throw new YoloError("invalid_request", "query is required");
      const target = await insightTarget(itemId);
      const found = await node.post("/internal/v1/transcript", {
        ...transcriptRequest(target, { track, language }), query: text, limit,
      }, { timeoutMs: TRANSCRIPT_TIMEOUT_MS });
      return {
        item: target.item,
        track: found.track,
        query: text,
        ...(target.playing ? { position: round(target.playing.position) } : {}),
        matches: found.matches,
      };
    },

    async chapters({ itemId } = {}) {
      const target = await insightTarget(itemId);
      const result = await node.get("/internal/v1/chapters", sourceQuery(target.source), { timeoutMs: METADATA_TIMEOUT_MS });
      const chapters = result.chapters ?? [];
      const at = target.playing?.position;
      const current = at == null ? null : [...chapters].reverse().find((entry) => entry.kind === "chapter" && entry.start <= at) ?? null;
      return {
        item: target.item,
        ...(at != null ? { position: round(at) } : {}),
        ...(current ? { current: current.title ?? `from ${current.start} s` } : {}),
        chapters,
        ...(!chapters.length ? { note: result.supported === false ? "This item's source offers no chapters or markers" : "This item has no chapters or markers" } : {}),
      };
    },

    // A seek to past the intro, or to the next or previous chapter, on
    // `device`'s session, else the default rule's.
    async skip(to, { device = null } = {}) {
      const state = await hub.getState(on(device));
      if (!state.item || !state.sessionId) throw new YoloError("nothing_playing", "Nothing is playing");
      const { chapters = [] } = await node.get("/internal/v1/chapters", sourceQuery(state.item.source), { timeoutMs: METADATA_TIMEOUT_MS });
      const { position, chapter } = skipTarget(chapters, state.position, to);
      await hub.seek(position, { device: state.deviceId, requester });
      return { skipped: to, from: round(state.position), position, chapter };
    },

    playbackHealth: ({ device = null } = {}) => hub.playbackHealth(device, { requester }),

    // One picture of a video (Agent Note 2026-10-13-video-frames): of the
    // item playing now unless `url` or `itemId` names another, at `time`
    // (seconds or "hh:mm:ss"), which defaults to the Hub's position of the
    // playing item. The node reads it from the source; no screen is asked.
    async frame({ time = null, url, itemId, source = null, width = FRAME_WIDTH } = {}) {
      if (!(await allowFrame("frame"))) throw new YoloError("rate_limited", "Too many frames for this agent; wait a minute");
      let at = time == null || time === "" ? null : parseTimestamp(time);
      const { state, target, playing } = await pictureTarget({ url, itemId, source });
      if (at == null) {
        if (!playing) throw new YoloError("invalid_request", "time is required for an item that is not playing now");
        at = Number(state.position) || 0;
        // The end itself has no frame; a finished item shows its last second.
        if (state.item.duration > 0) at = Math.max(0, Math.min(at, state.item.duration - 1));
      }
      if (playing && state.item.duration > 0 && at > state.item.duration) {
        throw new YoloError("invalid_request", `${formatTimestamp(at)} is past the end of "${state.item.title}", which lasts ${formatTimestamp(state.item.duration)}`);
      }
      const frame = await node.post("/internal/v1/frame", {
        source: target, time: at, width, sessionId: playing ? state.sessionId ?? null : null,
      }, { timeoutMs: FRAME_TIMEOUT_MS }).catch((error) => {
        throw olderNode(error, "frames");
      });
      log({ kind: "frame", event: "served", userId });
      return { ...frame, playing };
    },

    // A contact sheet (Agent Note 2026-10-13-video-frames): `count` evenly
    // spaced frames of an item, by default the one playing now, over
    // `from`..`to` (by default all of it), in one labelled grid. The node
    // takes the source's own storyboard images when its plugin offers them.
    async storyboard({ url, itemId, source = null, from = null, to = null, count, width } = {}) {
      if (!(await allowFrame("storyboard"))) throw new YoloError("rate_limited", "Too many storyboards for this agent; wait a minute");
      const range = {
        from: from == null || from === "" ? null : parseTimestamp(from),
        to: to == null || to === "" ? null : parseTimestamp(to),
      };
      const { state, target, playing } = await pictureTarget({ url, itemId, source });
      const board = await node.post("/internal/v1/storyboard", {
        source: target,
        ...range,
        count,
        width,
        sessionId: playing ? state.sessionId ?? null : null,
        duration: playing ? state.item.duration ?? null : null,
      }, { timeoutMs: STORYBOARD_TIMEOUT_MS }).catch((error) => {
        throw olderNode(error, "storyboards");
      });
      log({ kind: "frame", event: "storyboard_served", userId });
      return { ...board, playing };
    },

    // --- Danmaku (Agent Note 2026-10-13-danmaku) ---------------------------

    // A screen's danmaku settings; `device` as for play.
    async setDanmaku({ device = null, ...settings } = {}) {
      const patch = danmakuSettingsPatch(settings);
      if (!Object.keys(patch).length) throw new YoloError("invalid_request", "Pass at least one setting: enabled, density, opacity, area, or fontSize");
      return hub.setDanmaku(device, patch, { requester });
    },

    // What viewers wrote around `at` seconds of the item playing, or of
    // `itemId`: by default its position. An item whose source has no
    // comments() has none (`supported: false`).
    async comments({ itemId, at = null, window = DEFAULT_COMMENT_WINDOW, limit = DEFAULT_COMMENT_LIMIT } = {}) {
      const target = await insightTarget(itemId);
      const moment = Math.max(0, Number(at ?? target.playing?.position ?? 0) || 0);
      const span = Math.min(MAX_COMMENT_WINDOW, Math.max(1, Number(window) || DEFAULT_COMMENT_WINDOW));
      const from = Math.max(0, moment - span / 2);
      const answer = await node.get("/internal/v1/comments", { ...sourceQuery(target.source), start: from, end: from + span }, { timeoutMs: COMMENTS_TIMEOUT_MS })
        .catch((error) => {
          throw olderNode(error, "timed comments");
        });
      const range = { at: Math.round(moment * 10) / 10, from: Math.round(from * 10) / 10, to: Math.round((from + span) * 10) / 10 };
      if (!answer.available) {
        return { item: target.item, ...range, available: false, note: answer.supported === false ? "This item's source offers no timed comments" : "This item has no timed comments" };
      }
      const summary = summarizeComments(answer.comments, { at: moment, limit: Math.min(MAX_COMMENT_LIMIT, Math.max(1, Number(limit) || DEFAULT_COMMENT_LIMIT)) });
      return { item: target.item, ...range, available: true, ...(answer.complete === false ? { complete: false } : {}), ...summary };
    },

    // --- Queue ------------------------------------------------------------

    // Each for the screen whose queue it is: `device`, else queueScreen().
    async listQueue({ device = null } = {}) {
      return queueStore.listQueue(db, userId, await queueScreen(device));
    },

    // `count` queues the item and the ones after it in its run (a show's
    // episodes, a multi-part video's parts), up to `count` in all and at
    // most QUEUE_RUN_MAX (Agent Note 2026-10-23-up-next); `items` says how
    // many there were.
    async addToQueue({ url, itemId, source, position = "end", count = 1, device = null }) {
      const screen = await queueScreen(device);
      const first = await describe(source ?? refToSource({ url, itemId }));
      const wanted = Math.min(QUEUE_RUN_MAX, Math.max(1, Math.floor(Number(count) || 1)));
      const inputs = [first];
      if (wanted > 1) {
        let sequence = null;
        try {
          ({ sequence } = await node.get("/internal/v1/sequence", sourceQuery(first.source), { timeoutMs: SEQUENCE_TIMEOUT_MS }));
        } catch (error) {
          if (error?.code !== "not_found") throw error;
        }
        // A part's name the source's listing lacks comes from describe().
        const following = await Promise.all((sequence?.items ?? []).slice(1, wanted).map((entry) => (
          entry.title ? { ...entry, metadata: {} } : describe(entry.source)
        )));
        inputs.push(...following);
      }
      const items = await queueStore.addQueueItems(db, userId, screen, inputs, { position });
      notifyQueue(screen);
      return { item: items[0], items, deviceId: screen, queue: await queueStore.listQueue(db, userId, screen) };
    },

    async removeFromQueue(id, { device = null } = {}) {
      const screen = await queueScreen(device);
      const item = await queueStore.removeQueueItem(db, userId, screen, id);
      notifyQueue(screen);
      return { removed: item };
    },

    async clearQueue({ device = null } = {}) {
      const screen = await queueScreen(device);
      const cleared = await queueStore.clearQueue(db, userId, screen);
      notifyQueue(screen);
      return { cleared };
    },

    async reorderQueue(ids, { device = null } = {}) {
      const screen = await queueScreen(device);
      const queue = await queueStore.reorderQueue(db, userId, screen, ids);
      notifyQueue(screen);
      return queue;
    },

    // --- Playlists --------------------------------------------------------

    listPlaylists: () => playlistStore.listPlaylists(db, userId),
    getPlaylist: (id) => playlistStore.getPlaylist(db, userId, id),

    async createPlaylist({ name, description }) {
      const playlist = await playlistStore.createPlaylist(db, userId, { name, description });
      notifyPlaylists();
      return playlist;
    },

    async updatePlaylist(id, changes) {
      const playlist = await playlistStore.updatePlaylist(db, userId, id, changes);
      notifyPlaylists();
      return playlist;
    },

    async deletePlaylist(id) {
      const playlist = await playlistStore.deletePlaylist(db, userId, id);
      notifyPlaylists();
      return { deleted: { id: playlist.id, name: playlist.name, itemCount: playlist.itemCount } };
    },

    async addToPlaylist(id, { url, itemId, source }) {
      const input = await describe(source ?? refToSource({ url, itemId }));
      const result = await playlistStore.addPlaylistItems(db, userId, id, [input]);
      notifyPlaylists();
      return { item: result.added[0], playlist: { id: result.playlist.id, name: result.playlist.name, itemCount: result.playlist.itemCount } };
    },

    async removeFromPlaylist(id, itemId) {
      const item = await playlistStore.removePlaylistItem(db, userId, id, itemId);
      notifyPlaylists();
      return { removed: item };
    },

    async reorderPlaylist(id, ids) {
      const playlist = await playlistStore.reorderPlaylist(db, userId, id, ids);
      notifyPlaylists();
      return playlist;
    },

    async enqueuePlaylist(id, { position = "end", device = null } = {}) {
      const playlist = await playlistStore.getPlaylist(db, userId, id);
      if (!playlist.items.length) throw new YoloError("invalid_request", `Playlist ${playlist.name} is empty`);
      const screen = await queueScreen(device);
      const added = await queueStore.addQueueItems(db, userId, screen, playlist.items, { position });
      notifyQueue(screen);
      return { added: added.length, deviceId: screen, queue: await queueStore.listQueue(db, userId, screen) };
    },

    // A source plugin on the node expands an external playlist URL.
    async importPlaylist({ url, name = null, enqueue = false, device = null }) {
      if (!isHttpUrl(url)) throw new YoloError("invalid_request", "url must be an http(s) playlist URL");
      const expanded = await node.post("/internal/v1/playlists/expand", { url }, { timeoutMs: 60_000 });
      const items = (expanded.items || []).map((entry) => ({
        source: entry.source,
        title: entry.title,
        thumbnail: entry.thumbnail,
        duration: entry.duration,
        metadata: { importedFrom: url },
      }));
      if (!items.length) throw new YoloError("resolve_failed", "The playlist has no playable entries");
      const created = await playlistStore.createPlaylist(db, userId, { name: name || expanded.title || "Imported playlist" });
      const { playlist } = await playlistStore.addPlaylistItems(db, userId, created.id, items);
      notifyPlaylists();
      let queued = 0;
      if (enqueue) {
        const screen = await queueScreen(device);
        queued = (await queueStore.addQueueItems(db, userId, screen, items, { position: "end" })).length;
        notifyQueue(screen);
      }
      return { playlist: { id: playlist.id, name: playlist.name, itemCount: playlist.itemCount }, imported: items.length, queued };
    },

    // --- Agent (Agent Note 2026-10-18-agent-from-the-screen) --------------

    // Whether the owner's screens can ask the agent on the node:
    // { available, id?, title?, reason?, agents? }: the agent a screen that
    // names none asks, and every agent a screen may choose, { id, title,
    // available, reason? }. A node from before agents answers 404, and one
    // from before choosing lists none.
    async agentStatus() {
      try {
        const { available, id, title, reason, speech, agents } = await node.get("/internal/v1/agent", undefined, { timeoutMs: HEALTH_TIMEOUT_MS });
        const choices = Array.isArray(agents)
          ? agents.filter((agent) => agentId(agent?.id)).map((agent) => ({
            id: agent.id,
            title: typeof agent.title === "string" && agent.title ? agent.title : agent.id,
            available: Boolean(agent.available),
            ...(typeof agent.reason === "string" && agent.reason ? { reason: agent.reason } : {}),
          }))
          : null;
        return {
          available: Boolean(available),
          ...(agentId(id) ? { id } : {}),
          ...(title ? { title } : {}),
          ...(reason ? { reason } : {}),
          ...(speech === true ? { speech } : {}),
          ...(choices ? { agents: choices } : {}),
        };
      } catch (error) {
        const yolo = toYoloError(error);
        if (yolo.code === "not_found" && yolo.message === "No such endpoint") return { available: false, reason: "Upgrade the media node to use an agent from a screen" };
        return { available: false, reason: yolo.message };
      }
    },

    // A request in words from a screen (`deviceId`, a paired device's own
    // credential) or an agent's client, with what plays now (playingNow()):
    // the node's NDJSON stream of what the
    // agent does, ending with { type: "done", text } or { type: "error" }.
    // `session`, given in a conversation, is the CLI session the answer
    // continues (null starts one); without it the node keeps its own short
    // memory per screen. `agent` names the agent to ask, as a screen chose
    // it; without it the node asks its first available one.
    // The agent canvas (Agent Note 2026-10-21-agent-canvas). Agents place
    // and change objects; a screen reads its own canvas and says what the
    // person did.
    canvasRead: ({ device = null } = {}) => hub.canvasRead({ device }),
    async canvasPut({ device = null, object } = {}) {
      return hub.canvasPut({ device, object: await lookedUp(object) });
    },
    async canvasPatch({ device = null, id, changes = {} } = {}) {
      const props = changes?.props?.options ? await lookedUpChoices(changes.props) : changes?.props;
      return hub.canvasPatch({ device, id, changes: { ...changes, ...(props ? { props } : {}) } });
    },
    canvasRemove: ({ device = null, id } = {}) => hub.canvasRemove({ device, id }),
    canvasEvents: ({ since = 0, objects = null, waitSeconds = 0 } = {}) => hub.canvasEvents({ since, objects, waitSeconds }),
    async offer({ device = null, title = null, options = [], waitSeconds = 30 } = {}) {
      return hub.offer({ device, object: { kind: "choices", props: await lookedUpChoices({ title, options }) }, waitSeconds });
    },
    async screenCanvas(deviceId) {
      if (!deviceId) throw new YoloError("forbidden", "Only a paired screen has a canvas");
      const [screen] = (await hub.canvasRead({ device: deviceId })).screens;
      return { rev: screen.rev, objects: screen.objects };
    },
    canvasGesture(deviceId, { objectId, gesture, payload = null } = {}) {
      if (!deviceId) throw new YoloError("forbidden", "Only a paired screen sends canvas events");
      return hub.canvasEvent(deviceId, { objectId, gesture, payload });
    },

    async askAgent({ text, deviceId = null, language = null, session, agent = null } = {}) {
      const words = agentWords(text);
      const [device, { playing, others }] = await Promise.all([
        deviceId ? getDevice(db, userId, deviceId) : null,
        playingNow(deviceId),
      ]);
      try {
        return await node.request("/internal/v1/agent", {
          method: "POST",
          body: {
            text: words,
            device: device ? { id: device.id, name: device.name } : null,
            playing,
            ...(others.length ? { others } : {}),
            language: typeof language === "string" && language ? language.slice(0, 35) : null,
            ...(session !== undefined ? { session } : {}),
            ...(agentId(agent) ? { agent } : {}),
          },
          raw: true,
          timeoutMs: AGENT_TIMEOUT_MS,
        });
      } catch (error) {
        // A node from before agents has no such endpoint.
        if (toYoloError(error).code === "not_found" && error.message === "No such endpoint") {
          throw new YoloError("not_found", "Upgrade the media node to use an agent from a screen");
        }
        throw error;
      }
    },

    // Voice input: a screen's recording (`audio`, the bytes of a 16 kHz mono
    // WAV) turned into words by the node's transcriber, { text, language }.
    // The sound passes through and is never kept; the screen asks with the
    // words like typed ones.
    async transcribeVoice({ audio, language = null, deviceId = null, signal } = {}) {
      if (!(audio instanceof Uint8Array) || !audio.length) throw new YoloError("invalid_request", "audio is required");
      try {
        const { text, language: heard } = await node.post("/internal/v1/speech/transcribe", {
          audio: base64(audio),
          languages: await readVoiceLanguages(db, userId),
          language: typeof language === "string" && language ? language.slice(0, 35) : null,
          device: deviceId,
        }, { timeoutMs: VOICE_TIMEOUT_MS, signal });
        return { text: typeof text === "string" ? text : "", language: typeof heard === "string" ? heard : null };
      } catch (error) {
        // A node from before voice input has no such endpoint.
        if (toYoloError(error).code === "not_found" && error.message === "No such endpoint") {
          throw new YoloError("not_found", "Upgrade the media node to ask by voice");
        }
        throw error;
      }
    },

    // Conversations: the owner's questions and the agent's answers, as the
    // screens show them. `conversationId` "new" starts one titled by the
    // question. The stream is the node's, after a first line
    // { type: "conversation", id, title }; its end is recorded as the answer,
    // and a stream the screen stops is recorded as stopped (`waitUntil`
    // keeps that write alive in the Worker).
    agentConversations: ({ limit } = {}) => conversationStore.listConversations(db, userId, { limit }),

    async agentConversation(id) {
      const conversation = await conversationStore.getConversation(db, userId, String(id));
      if (!conversation) throw new YoloError("not_found", "No such conversation");
      const { agentSession: _session, ...shown } = conversation;
      return { ...shown, messages: await conversationStore.listMessages(db, userId, conversation.id) };
    },

    async deleteAgentConversation(id) {
      if (!(await conversationStore.deleteConversation(db, userId, String(id)))) throw new YoloError("not_found", "No such conversation");
      return { deleted: 1 };
    },

    // The conversation goes on with the agent that answered it, unless the
    // screen chose another, which starts its own session.
    async askInConversation({ conversationId, text, deviceId = null, language = null, agent = null, waitUntil = () => {} } = {}) {
      const words = agentWords(text);
      const conversation = conversationId === "new"
        ? await conversationStore.createConversation(db, userId, { title: words, deviceId })
        : await conversationStore.getConversation(db, userId, String(conversationId));
      if (!conversation) throw new YoloError("not_found", "No such conversation");
      const answerId = await conversationStore.addQuestion(db, userId, conversation.id, words);
      const record = async (answer) => {
        try {
          await conversationStore.addAnswer(db, userId, conversation.id, answerId, answer);
        } catch (error) {
          log({ message: "agent answer not recorded", conversation: conversation.id, error: toYoloError(error).message });
        }
      };
      const first = `${JSON.stringify({ type: "conversation", id: conversation.id, title: conversation.title })}\n`;
      let answer;
      try {
        const asked = agentId(agent) ? agent : conversation.agentId ?? null;
        const session = asked && conversation.agentId && asked !== conversation.agentId ? null : conversation.agentSession ?? null;
        answer = await services.askAgent({ text: words, deviceId, language, session, agent: asked });
      } catch (error) {
        const { code, message, retryable } = toYoloError(error);
        await record({ text: message, status: "error" });
        return ndjson(`${first}${JSON.stringify({ type: "error", error: { code, message, retryable } })}\n`);
      }
      return recordedAnswer(answer.body, { first, record, waitUntil });
    },

    // --- Share links (Agent Note 2026-10-20-share-links) --------------------

    // A link that plays one item in a friend's browser for 7 days: the url
    // or item given, else what plays now. Only this answer carries the link;
    // Yolo keeps its hash, so the owner can revoke it but not see it again.
    async share({ url, itemId, source = null } = {}) {
      let ref = source ?? (url || itemId ? refToSource({ url, itemId }) : null);
      // What plays now: the default rule's session, or with a ref, a
      // session that plays it, whose description needs no lookup.
      const playing = ref
        ? (await hub.sessions()).sessions.find((session) => isClaimed(ref) && sourceKey(session.item.source) === sourceKey(ref))?.item ?? null
        : (await hub.getState(on())).item ?? null;
      if (!ref) {
        ref = playing?.source ?? null;
        if (!ref) throw new YoloError("invalid_request", "Nothing is playing; pass url or item_id to share");
      }
      // What plays now is described already: the link needs no lookup on
      // the node, which for a web video runs its source again.
      const known = playing && isClaimed(ref) && sourceKey(ref) === sourceKey(playing.source);
      const described = known
        ? { source: playing.source, title: playing.title, thumbnail: playing.thumbnail, duration: playing.duration, metadata: {} }
        : await describe(await claimSource(node, ref));
      if (described.metadata.pendingMetadata) throw new YoloError("node_offline", "The home media node is offline, so nothing can be shared right now");
      const { source: claimed, title, thumbnail = null, duration = null } = described;
      const link = await shareStore.createShareLink(db, userId, {
        source: claimed, title: title || sourceKey(claimed), thumbnail, duration: Number(duration) || null, createdBy: agent,
      });
      log({ kind: "security", event: "share_link_created", userId, shareId: link.id, by: agent });
      return {
        id: link.id,
        url: `${origin ?? ""}/s/${link.token}`,
        title: title || sourceKey(claimed),
        expiresAt: new Date(link.expiresAt).toISOString(),
      };
    },

    // The owner's links, newest first, without their tokens.
    async shareLinks(now = Date.now()) {
      const links = await shareStore.listShareLinks(db, userId);
      return {
        links: links.map((link) => ({
          id: link.id,
          title: link.title,
          thumbnail: link.thumbnail,
          status: shareStore.shareStatus(link, now),
          createdBy: link.createdBy,
          createdAt: link.createdAt,
          expiresAt: link.expiresAt,
          revokedAt: link.revokedAt,
          plays: link.plays,
          lastPlayedAt: link.lastPlayedAt,
        })),
      };
    },

    // Revoking stops new streams at once and asks the node to stop the
    // link's streams that play now.
    async revokeShareLink(id) {
      const link = await shareStore.revokeShareLink(db, userId, String(id ?? ""));
      if (!link) throw new YoloError("not_found", "No share link has that id");
      log({ kind: "security", event: "share_link_revoked", userId, shareId: link.id });
      const stopped = await node.request(`/internal/v1/shares/${encodeURIComponent(link.id)}`, { method: "DELETE", timeoutMs: 5_000 })
        .then((answer) => answer?.stopped ?? 0, () => null);
      return { id: link.id, revokedAt: link.revokedAt, stopped };
    },

    // --- History ----------------------------------------------------------

    // `byShow` is what screens continue (Agent Note
    // 2026-10-11-yolo-owns-progress-and-resume): a show gives one entry, its
    // newest, under the show's key, and once that episode is finished, the
    // next one in its run in its place. Removing that key removes the show.
    // A profile's (`profile`, an id or a name), by default the asking
    // screen's default profile's, else the owner's.
    async history({ limit, byShow = false, profile = null } = {}) {
      const owner = await viewer(profile);
      const entries = await historyStore.listHistory(db, owner, { limit, byShow });
      return byShow ? Promise.all(entries.map((entry) => (entry.showKey ? continueShow(entry, owner) : entry))) : entries;
    },

    async deleteHistory({ sourceKey: key = null, withShow = false, profile = null } = {}) {
      if (key && !isSourceKey(key)) throw new YoloError("invalid_request", "sourceKey must look like <source>:<id>, as in history");
      return { deleted: await historyStore.deleteHistory(db, await viewer(profile), key, { withShow }) };
    },
  };
  return services;
}
