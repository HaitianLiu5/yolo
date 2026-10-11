import { isHttpUrl, YoloError } from "@useyolo/core";

// Bridge to the existing Drive-In server (server/, default :9090). Until the
// media pipeline moves into this node, playback still happens there: the node
// exposes that server's single player as the renderer "legacy", and the
// control plane drives it with the same session calls it will use later.
// Track preferences on this path are applied by the Drive-In server itself.
//
// This file is temporary (it goes with server/ once the car runs the Tesla
// client, decision 12), so it is the one place in service/ allowed to know
// the two official source plugins: the Drive-In server plays Plex library
// items through its own Plex routes, and anything else by the page URL it
// runs yt-dlp on. Drive-In's saved data is exported by
// scripts/drive-in-export, outside service/.

const RENDERER_ID = "legacy";
// The source id of the official Plex plugin (plugins/source-plex).
const PLEX_SOURCE = "plex";

// How the Drive-In server identifies what it plays: "plex://<ratingKey>" for
// Plex items, otherwise the page URL. Null for a source it cannot play.
function legacyUrl(source) {
  if (source?.plugin === PLEX_SOURCE) return `plex://${source.id}`;
  return typeof source?.url === "string" && isHttpUrl(source.url) ? source.url : null;
}

const STATUS = { idle: "idle", resolving: "loading", playing: "playing", paused: "paused" };

export function createLegacyBridge({ baseUrl, fetchImpl = fetch, timeoutMs = 45_000 }) {
  // sessionId → source, for sessions this node started on the legacy player.
  const sessions = new Map();

  async function call(method, path, body) {
    let response;
    try {
      response = await fetchImpl(new URL(path, baseUrl), {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new YoloError("device_offline", "The Drive-In server is not running on the node", { cause: error });
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    const message = typeof data.error === "string" ? data.error : `Drive-In answered ${response.status}`;
    if (response.status === 503 && /player/i.test(message)) throw new YoloError("device_offline", message);
    if (response.status === 400) throw new YoloError("invalid_request", message);
    if (response.status === 409) throw new YoloError("superseded", message);
    throw new YoloError("resolve_failed", message);
  }

  async function status() {
    return call("GET", "/api/status");
  }

  // A null startTime lets the Drive-In server resume on its own (Plex's
  // viewOffset, or its history for URLs).
  function startPlayback(source, { startTime = null, reason = "play", subtitleStreamID, audioStreamID } = {}) {
    if (source.plugin === PLEX_SOURCE) {
      return call("POST", "/api/plex/play", {
        ratingKey: source.id,
        ...(startTime != null ? { offset: Math.round(Math.max(0, startTime) * 1000) } : {}),
        reason,
        ...(subtitleStreamID !== undefined ? { subtitleStreamID } : {}),
        ...(audioStreamID !== undefined ? { audioStreamID } : {}),
      });
    }
    const url = legacyUrl(source);
    if (!url) throw new YoloError("resolve_failed", `The Drive-In player cannot play ${source.plugin} items`);
    return call("POST", "/api/play", { url, ...(startTime != null ? { startTime: Math.max(0, startTime) } : {}), reason });
  }

  function requireSession(sessionId) {
    const source = sessions.get(sessionId);
    if (!source) throw new YoloError("not_found", `Session ${sessionId} is not active on this node`);
    return source;
  }

  // The Drive-In server keeps the last session's status ("playing") after the
  // player disconnects, so only a connected player's status is current. The
  // title and position stay as the point to resume from.
  function liveStatus(current) {
    return current.playerConnected ? STATUS[current.status] || "idle" : "idle";
  }

  async function position() {
    const current = await status();
    return Number(current.player?.currentTime) || 0;
  }

  return {
    rendererId: RENDERER_ID,
    has: (sessionId) => sessions.has(sessionId),

    async health() {
      try {
        const current = await status();
        return { online: true, playerConnected: Boolean(current.playerConnected), status: liveStatus(current) };
      } catch {
        return { online: false, playerConnected: false };
      }
    },

    async renderers() {
      let current;
      try {
        current = await status();
      } catch {
        return [];
      }
      const playing = current.url || null;
      const sessionId = [...sessions.entries()].reverse().find(([, source]) => playing && legacyUrl(source) === playing)?.[0] ?? null;
      return [{
        id: RENDERER_ID,
        name: "Drive-In",
        kind: "car",
        online: Boolean(current.playerConnected),
        capabilities: { renderer: "external" },
        playback: {
          sessionId,
          status: liveStatus(current),
          title: current.title || null,
          position: Number(current.player?.currentTime) || 0,
          duration: Number(current.player?.duration) || null,
        },
      }];
    },

    async prepare({ sessionId, source, startTime, reason }) {
      const result = await startPlayback(source, { startTime, reason: reason === "transfer" ? "play" : reason });
      sessions.set(sessionId, source);
      // Keep the map small; only the latest few sessions matter.
      while (sessions.size > 16) sessions.delete(sessions.keys().next().value);
      return {
        sessionId,
        delivery: { type: "external", renderer: RENDERER_ID },
        profile: null,
        title: result.title || null,
        duration: null,
        isLive: Boolean(result.isLive),
        thumbnail: null,
        startTime: startTime ?? 0,
        tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
      };
    },

    async control(sessionId, { action, position: target }) {
      const source = requireSession(sessionId);
      if (action === "seek") {
        await startPlayback(source, { startTime: Number(target) || 0, reason: "seek" });
        return { ok: true };
      }
      if (!["pause", "resume", "stop"].includes(action)) throw new YoloError("invalid_request", `Unknown action ${action}`);
      await call("POST", "/api/control", { action });
      if (action === "stop") sessions.delete(sessionId);
      return { ok: true };
    },

    async stop(sessionId) {
      if (!sessions.has(sessionId)) return { ok: true };
      const source = sessions.get(sessionId);
      sessions.delete(sessionId);
      // Only stop the player if it is still showing this session's source.
      const playing = (await status().catch(() => ({}))).url;
      if (playing && playing === legacyUrl(source)) await call("POST", "/api/control", { action: "stop" });
      return { ok: true };
    },

    // Track ids: URL subtitles are `s_<lang>`, Plex tracks are `plex:<streamId>`.
    async setTracks(sessionId, { subtitles, audio }) {
      const source = requireSession(sessionId);
      if (source.plugin !== PLEX_SOURCE) {
        if (audio) throw new YoloError("invalid_request", "This video has no selectable audio tracks");
        const langs = (subtitles || []).map((id) => String(id).replace(/^s_/, ""));
        await call("POST", "/api/subtitles/select", { langs, sourceUrl: legacyUrl(source) });
        return { reload: null };
      }
      const streamId = (id) => (id ? String(id).replace(/^plex:/, "") : null);
      // Plex burns image subtitles into the transcode, so restart at the
      // current position with the new streams.
      await startPlayback(source, {
        startTime: await position(),
        reason: "seek",
        subtitleStreamID: subtitles === undefined ? undefined : streamId(subtitles[0]),
        audioStreamID: audio === undefined ? undefined : streamId(audio),
      });
      return { reload: null };
    },
  };
}
