import { readFileSync } from "node:fs";
import { Hono } from "hono";
import {
  acceptsProtocol,
  errorBody,
  LOAD_REASONS,
  mediaPath,
  NODE_PROTOCOL,
  normalizeCapabilities,
  normalizeSource,
  PROTOCOL_HEADER,
  requestProtocol,
  selectTracks,
  toYoloError,
  verifyNodeRequest,
  YoloError,
} from "@useyolo/core";
import { createAgentRegistry, normalizeAgentRequest } from "./agents.js";
import { createFrames } from "./media/frames.js";
import { createCommentStore } from "./comments.js";
import { playable } from "./media/playable.js";
import { createOwnerCodes } from "./owner-code.js";
import { createThumbnails } from "./thumbnails.js";
import { createTranscripts, searchCues, sliceCues } from "./transcripts.js";
import { createWarmer, WARM_MAX_SOURCES } from "./warm.js";

// The node's internal API (Agent Note 2026-10-07-node-internal-api). Only the
// control plane calls it, through Workers VPC; every request must also carry a
// valid NODE_SECRET signature (defense in depth). Media (/m/{token}/…) is the
// exception: the control plane passes it through, and the media token in the
// path is the credential (media/pipeline.js).

// Yolo's one version: the repository's package.json, which every package
// matches (Agent Note 2026-10-13-versions-and-releases).
export const NODE_VERSION = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;

const ids = (list) => (Array.isArray(list) ? list.map(String) : []);

// The prepare context's chooseTracks
// (Agent Note 2026-10-11-node-media-pipeline): an explicit choice wins;
// otherwise the user's saved preferences for this source, then the latest
// choice on any source (the `default` row), matched by language.
export function trackChooser({ preferences = {}, subtitles, audio } = {}) {
  const saved = preferences?.saved ?? null;
  const fallback = preferences?.fallback ?? null;
  return (available = {}) => {
    const subtitleTracks = available.subtitles || [];
    const audioTracks = available.audio || [];
    const has = (tracks, id) => tracks.some((track) => String(track.id) === String(id));
    const chosenSubtitles = Array.isArray(subtitles)
      ? ids(subtitles).filter((id) => has(subtitleTracks, id))
      : (selectTracks({ saved: saved?.subtitles ?? null, fallback: fallback?.subtitles ?? null, available: subtitleTracks }) || []).map((track) => String(track.id));
    let chosenAudio = null;
    if (audio != null) {
      chosenAudio = has(audioTracks, audio) ? String(audio) : null;
    } else if (audio === undefined) {
      const preference = saved ? saved.audio : fallback?.audio;
      const match = preference ? selectTracks({ saved: saved ? [preference] : null, fallback: saved ? null : [preference], available: audioTracks }) : null;
      chosenAudio = match?.[0] ? String(match[0].id) : null;
    }
    return { subtitles: chosenSubtitles, audio: chosenAudio };
  };
}

function baseApp(secret) {
  if (!secret) throw new Error("NODE_SECRET is required");
  const app = new Hono();
  app.onError((error, c) => {
    const yolo = toYoloError(error);
    if (yolo.code === "internal") console.error("node request failed", error);
    return c.json(errorBody(yolo), yolo.status);
  });
  app.notFound((c) => c.json(errorBody(new YoloError("not_found", "No such endpoint")), 404));
  return app;
}

const requireSignature = (secret) => async (c, next) => {
  const url = new URL(c.req.url);
  const body = ["GET", "HEAD"].includes(c.req.method) ? "" : await c.req.raw.clone().text();
  const ok = await verifyNodeRequest(secret, {
    method: c.req.method,
    path: url.pathname + url.search,
    body,
    headers: c.req.raw.headers,
  });
  if (!ok) return c.json(errorBody(new YoloError("unauthorized", "Bad or missing request signature")), 401);
  await next();
};

// After the signature: the control plane's protocol must be this node's or
// the one before (NODE_PROTOCOL in @useyolo/core). A mismatch names both
// sides, so the owner knows which one to upgrade.
const requireProtocol = async (c, next) => {
  const protocol = requestProtocol(c.req.header(PROTOCOL_HEADER));
  if (protocol === null || !acceptsProtocol(protocol)) {
    const behind = protocol !== null && protocol < NODE_PROTOCOL;
    const message = `This media node runs Yolo ${NODE_VERSION} (internal protocol ${NODE_PROTOCOL}, accepting ${NODE_PROTOCOL - 1} and ${NODE_PROTOCOL}); the control plane speaks protocol ${protocol ?? "?"}. `
      + (behind ? "Deploy the control plane from the same release (npm run yolo -- upgrade)." : "Upgrade the media node to the control plane's release (npm run yolo -- upgrade).");
    return c.json(errorBody(new YoloError("node_offline", message, { retryable: false })), 503);
  }
  await next();
};

// A Source passed as JSON in the query string (`?source=`).
function sourceQuery(c) {
  try {
    return normalizeSource(JSON.parse(c.req.query("source") || "null"));
  } catch (error) {
    throw error instanceof YoloError ? error : new YoloError("invalid_request", "source must be a Source JSON object");
  }
}

// A transcript page is at most this many characters, so one answer stays a
// few thousand tokens.
const TRANSCRIPT_MAX_CHARS = 20_000;
const TRANSCRIPT_DEFAULT_CHARS = 6_000;

const json = async (c) => {
  try {
    return await c.req.json();
  } catch {
    throw new YoloError("invalid_request", "Request body must be JSON");
  }
};

// `plugins` is the plugin host from loadPlugins(): its source registry
// answers every source and library call, and its status goes into /health.
// `media` is the delivery pipeline (media/pipeline.js).
// The lowest cap a device may ask for; below it nothing is watchable.
const MIN_VIDEO_KBPS = 200;

// The bitrate a stream may use: the node's ceiling for its media path
// (LAN_MAX_VIDEO_KBPS on the LAN path, WAN_MAX_VIDEO_KBPS on remote direct
// play, STREAM_MAX_VIDEO_BITRATE_KBPS on the relay through Cloudflare),
// lowered by the device's adaptive-quality cap when the Hub passes one
// (Agent Note 2026-10-11-adaptive-quality).
export function effectiveLimits(requested, ceilingKbps) {
  const cap = Number(requested?.maxVideoKbps);
  const maxVideoKbps = Number.isFinite(cap) && cap > 0
    ? Math.max(MIN_VIDEO_KBPS, Math.min(ceilingKbps, Math.floor(cap)))
    : ceilingKbps;
  return { maxVideoKbps, ceilingKbps, capped: maxVideoKbps < ceilingKbps };
}

// `lan` and `wan` are the media listeners (lan.js, wan.js), or null on a
// node without them.
// `comments` is the node's comment store (comments.js), which the media
// pipeline shares.
export function createNodeApp({
  secret, plugins, media, lan = null, wan = null, ownerCodes = createOwnerCodes(), startedAt = Date.now(), frames = null,
  comments = createCommentStore({ sources: plugins.sources }),
}) {
  const app = baseApp(secret);
  app.use("/internal/*", requireSignature(secret));
  app.use("/internal/*", requireProtocol);
  const sources = plugins.sources;
  const transcripts = createTranscripts({ sources, media });
  const ceilingKbps = media?.maxVideoKbps ?? 4800;
  const pictures = frames ?? createFrames({ sources, media, maxVideoKbps: ceilingKbps });
  const v1 = new Hono();
  const warmer = createWarmer({ sources });

  // What a play asks of a source: the device's capabilities, and the limits
  // of the media path it gets. `path` asks for a media path (Agent Note
  // 2026-10-13-media-off-the-worker): "lan" or "wan" applies only while that
  // listener serves, and the stream then says the listener's origin;
  // anything else is the relay. A source plugin sees `network` "lan" on the
  // LAN path and "tunnel" on every other.
  function playRequest({ capabilities, viewport = null, reason = "play", tracks = {}, limits = null, path: asked = "relay" }) {
    const listeners = { lan, wan };
    const path = (asked === "lan" || asked === "wan") && listeners[asked]?.ready() ? asked : "relay";
    const ceilings = { lan: lan?.maxVideoKbps, wan: wan?.maxVideoKbps, relay: ceilingKbps };
    const applied = effectiveLimits(limits, ceilings[path] ?? ceilingKbps);
    return { capabilities: normalizeCapabilities(capabilities), viewport, reason, tracks, limits: applied, network: path === "lan" ? "lan" : "tunnel", path };
  }

  // Resolve a source with its plugin and serve it in session `sessionId`.
  async function openMedia({ sessionId, mediaToken, source, capabilities, viewport = null, startTime = null, reason = "play", tracks = {}, limits = null, path: asked = "relay" }) {
    if (!media) throw new YoloError("resolve_failed", "This node has no media pipeline");
    const listeners = { lan, wan };
    const request = playRequest({ capabilities, viewport, reason, tracks, limits, path: asked });
    const { path, limits: applied } = request;
    const descriptor = await sources.prepare(source, {
      capabilities: request.capabilities,
      viewport,
      startTime,
      reason,
      limits: { maxVideoKbps: applied.maxVideoKbps },
      network: request.network,
      playable: (description) => playable(description, { capabilities: request.capabilities, limits: applied }),
      chooseTracks: trackChooser(tracks),
    });
    const stream = await media.open({ sessionId, mediaToken, source, descriptor, request });
    // The comments where playback starts, read while the device loads.
    if (stream.comments) comments.prefetch(source, Number(stream.startTime) || 0);
    return { ...stream, network: path, origin: path === "relay" ? null : listeners[path].origin() };
  }

  v1.get("/health", async (c) => {
    return c.json({
      version: NODE_VERSION,
      protocol: NODE_PROTOCOL,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      media: media ? media.status() : null,
      comments: comments.status(),
      sources: await sources.health(),
      plugins: plugins.status(),
      lan: lan ? lan.status() : null,
      wan: wan ? wan.status() : null,
    });
  });

  // --- LAN listener (Agent Note 2026-10-12-lan-direct-play) ---------------
  // The control plane names the listener and allows its page's origin; the
  // answer carries a certificate request for that name. The chain it then
  // obtains is installed without a restart.
  const requireLan = () => {
    if (!lan) throw new YoloError("not_found", "This node has no LAN listener");
    return lan;
  };
  v1.put("/lan", async (c) => c.json(await requireLan().configure(await json(c))));
  v1.put("/lan/certificate", async (c) => c.json(await requireLan().install(await json(c))));

  // --- Remote listener (Agent Note 2026-10-13-media-off-the-worker) --------
  // The same for the remote name, with `enabled`: the owner's remote access
  // switch. Turned off, the listener stops and the router mapping goes.
  // Without a domain, `certificate: "ip"` and `acmeDirectory` instead of a
  // name: the node certifies the home's public address itself and answers
  // its status, with no certificate request (wan.js).
  const requireWan = () => {
    if (!wan) throw new YoloError("not_found", "This node has no remote listener");
    return wan;
  };
  v1.put("/wan", async (c) => c.json(await requireWan().configure(await json(c))));
  v1.put("/wan/certificate", async (c) => c.json(await requireWan().install(await json(c))));

  // A URL becomes a Source when the first source plugin claims it.
  v1.post("/claim", async (c) => c.json({ source: await sources.claim((await json(c)).url) }));

  // { source } or { url }; returns the (claimed) source with its metadata.
  v1.post("/metadata", async (c) => {
    const input = await json(c);
    const source = input.source ? normalizeSource(input.source) : await sources.claim(input.url);
    return c.json({ source, ...(await sources.describe(source)) });
  });

  v1.get("/tracks", async (c) => c.json(await sources.tracks(sourceQuery(c))));

  // --- What agents read about an item (Agent Note 2026-10-07-remote-mcp-server)
  v1.get("/details", async (c) => c.json(await sources.details(sources.require(sourceQuery(c)))));
  v1.get("/chapters", async (c) => c.json(await sources.chapters(sources.require(sourceQuery(c)))));
  // Timed comments between `start` and `end` seconds (Agent Note
  // 2026-10-13-danmaku); devices read them from their media session.
  // `supported: false` when the source has no comments().
  v1.get("/comments", async (c) => {
    const source = sources.require(sourceQuery(c));
    const start = Math.max(0, Number(c.req.query("start")) || 0);
    const end = Number.isFinite(Number(c.req.query("end"))) ? Number(c.req.query("end")) : start + 60;
    if (!sources.hasComments(source)) return c.json({ available: false, supported: false, start, end, complete: true, comments: [] });
    return c.json(await comments.get(source, { start, end }));
  });
  // { source, sessionId?, track?, language?, selected?, from?, to?, maxChars? }
  // → a page of cues as "m:ss text" lines; with `query` (and `limit?`), the
  // cues where it is said. `sessionId` is the session playing this item now,
  // whose subtitle text is read first.
  v1.post("/transcript", async (c) => {
    const input = await json(c);
    const { track, cues } = await transcripts.cues({
      source: input.source,
      sessionId: input.sessionId ?? null,
      track: input.track ?? null,
      language: input.language ?? null,
      selected: Array.isArray(input.selected) ? input.selected : [],
    });
    const last = cues.at(-1)?.end ?? 0;
    if (input.query != null) {
      const matches = searchCues(cues, input.query, { limit: input.limit });
      return c.json({ track, query: String(input.query), matches });
    }
    const maxChars = Math.min(TRANSCRIPT_MAX_CHARS, Math.max(500, Math.floor(Number(input.maxChars) || TRANSCRIPT_DEFAULT_CHARS)));
    const from = Math.max(0, Number(input.from) || 0);
    const to = input.to == null || !Number.isFinite(Number(input.to)) ? null : Math.max(from, Number(input.to));
    const page = sliceCues(cues, { from, to: to ?? Infinity, maxChars });
    return c.json({ track, from, to: page.nextFrom ?? to ?? last, ...page, length: last });
  });

  v1.post("/playlists/expand", async (c) => c.json(await sources.expand((await json(c)).url)));

  // --- Library -------------------------------------------------------------
  v1.get("/library", async (c) => c.json(await sources.libraries()));
  v1.get("/library/search", async (c) => c.json(await sources.search(c.req.query("q"), {
    type: c.req.query("type") || null,
    limit: c.req.query("limit"),
  })));
  v1.get("/library/items/:id/children", async (c) => c.json(await sources.children(c.req.param("id"))));
  v1.get("/library/items/:id/artwork", async (c) => {
    const upstream = await sources.artwork(c.req.param("id"), c.req.query("variant"));
    return new Response(upstream.body, {
      headers: { "content-type": upstream.headers.get("content-type") || "image/jpeg" },
    });
  });
  v1.get("/library/:libraryId/items", async (c) => c.json(await sources.items(c.req.param("libraryId"), {
    offset: c.req.query("offset"),
    limit: c.req.query("limit"),
  })));

  // A thumbnail on another host, fetched here so that no image server sees a
  // screen's address; only public http(s) addresses (thumbnails.js).
  const thumbnails = createThumbnails();
  v1.get("/thumbnail", async (c) => {
    const { type, body } = await thumbnails.get(c.req.query("url"));
    return new Response(body, { headers: { "content-type": type, "cache-control": "private, max-age=86400" } });
  });

  // --- Sessions ------------------------------------------------------------
  // A device gets a stream from the media pipeline. Re-preparing an existing sessionId rebuilds that session (node restarts,
  // track changes that need a new stream).
  v1.post("/prepare", async (c) => {
    const input = await json(c);
    const source = sources.require(input.source);
    const sessionId = String(input.sessionId || "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new YoloError("invalid_request", "sessionId is required");
    const startTime = input.startTime == null ? null : Math.max(0, Number(input.startTime) || 0);
    const reason = LOAD_REASONS.includes(input.reason) ? input.reason : "play";
    return c.json(await openMedia({
      sessionId,
      mediaToken: input.mediaToken,
      source,
      capabilities: input.capabilities,
      viewport: input.viewport ?? null,
      startTime,
      reason,
      tracks: input.tracks ?? {},
      limits: input.limits ?? null,
      path: mediaPath(input.network) ?? "relay",
    }));
  });
  // Resolve ahead (Agent Note 2026-10-07-node-internal-api): the first few
  // items a device's home screen offers go to their source plugins' warm(),
  // in the background and one at a time, with the context a prepare for
  // that device would get, so a tap on one does not wait for the source.
  v1.post("/warm", async (c) => {
    const input = await json(c);
    const request = playRequest({ capabilities: input.capabilities, viewport: input.viewport ?? null, limits: input.limits ?? null, path: mediaPath(input.network) ?? "relay" });
    const listed = (Array.isArray(input.sources) ? input.sources : []).slice(0, WARM_MAX_SOURCES);
    let warming = 0;
    for (const raw of listed) {
      let source;
      try {
        source = normalizeSource(raw);
      } catch {
        continue;
      }
      if (sources.canWarm(source) && warmer.add(source, request)) warming += 1;
    }
    return c.json({ warming });
  });
  v1.post("/sessions/:id/stop", async (c) => c.json(media ? await media.stop(c.req.param("id")) : { ok: true }));
  // Text subtitles switch inside the stream; burned-in subtitles and audio
  // need a new stream, rebuilt in the same session at `position`.
  v1.post("/sessions/:id/tracks", async (c) => {
    const id = c.req.param("id");
    const input = await json(c);
    sources.require(input.source);
    const session = media?.session(id);
    if (!session) throw new YoloError("not_found", `Session ${id} is not active on this node`);
    const current = media.present(id).tracks;
    const wantSubtitles = input.subtitles === undefined ? current.selected.subtitles : ids(input.subtitles);
    const wantAudio = input.audio === undefined ? current.selected.audio : input.audio;
    const burned = (list) => list.some((trackId) => current.subtitles.find((track) => track.id === trackId)?.delivery === "burn");
    const audioChanged = input.audio !== undefined && String(input.audio ?? "") !== String(current.selected.audio ?? "");
    if (!audioChanged && !burned(wantSubtitles) && !burned(current.selected.subtitles)) {
      return c.json({ tracks: media.selectSubtitles(id, wantSubtitles), reload: null });
    }
    const reload = await openMedia({
      sessionId: id,
      mediaToken: session.token,
      source: session.source,
      capabilities: session.request.capabilities,
      viewport: session.request.viewport,
      startTime: Math.max(0, Number(input.position) || 0),
      reason: "tracks",
      tracks: { preferences: session.request.tracks?.preferences, subtitles: wantSubtitles, audio: wantAudio },
      limits: session.request.limits ?? null,
      path: session.request.path ?? "relay",
    });
    return c.json({ tracks: reload.tracks, reload });
  });
  // One picture of an item at a time, for agents
  // (Agent Note 2026-10-13-video-frames): { source, time, width?, sessionId? }
  // → { image (base64 JPEG), mimeType, width, height, time, title, duration,
  // input, plugin }. `sessionId` is the session playing the item now, if any.
  v1.post("/frame", async (c) => {
    const input = await json(c);
    const source = sources.require(input.source);
    const sessionId = typeof input.sessionId === "string" && input.sessionId ? input.sessionId : null;
    return c.json(await pictures.frame({ source, time: input.time, width: input.width, sessionId }));
  });

  // A storyboard: `count` evenly spaced frames of an item in one JPEG grid,
  // each labelled with its time (Agent Note 2026-10-13-video-frames):
  // { source, from?, to?, count?, width?, sessionId?, duration? } →
  // { image, mimeType, width, height, title, duration, from, to, step,
  // count, columns, rows, times, missing, origin, input, plugin }.
  v1.post("/storyboard", async (c) => {
    const input = await json(c);
    const source = sources.require(input.source);
    const sessionId = typeof input.sessionId === "string" && input.sessionId ? input.sessionId : null;
    const duration = Number(input.duration) > 0 ? Number(input.duration) : null;
    return c.json(await pictures.storyboard({ source, from: input.from ?? null, to: input.to ?? null, count: input.count, width: input.width, sessionId, duration }));
  });

  // The Hub forwards progress about every 30 seconds; the source may keep
  // its own watch position (prepare()'s progress hook).
  v1.post("/sessions/:id/progress", async (c) => {
    const id = c.req.param("id");
    if (!media) return c.json({ ok: true });
    return c.json(await media.progress(id, await json(c)));
  });

  // --- Agent (Agent Note 2026-10-18-agent-from-the-screen) ----------------
  // Whether a screen can ask, and the request itself: { text, device?,
  // language? } → NDJSON lines as the agent works, { type: "tool", name } and
  // { type: "text", text }, then { type: "done", text } or { type: "error",
  // error }. The headers go out at once; a closed connection stops the agent.
  const agents = plugins.agents ?? createAgentRegistry();
  v1.get("/agent", async (c) => c.json(await agents.status()));
  v1.post("/agent", async (c) => {
    // A bad request or a missing agent is an error status, not a stream.
    const input = normalizeAgentRequest(await json(c));
    if (!agents.ids().length) throw new YoloError("not_found", "No agent plugin is loaded on this media node");
    const encoder = new TextEncoder();
    const signal = c.req.raw.signal;
    let send;
    const body = new ReadableStream({
      start(controller) {
        let open = true;
        send = (event) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            open = false;
          }
        };
        agents.ask(input, { emit: send, signal })
          .then(({ text }) => send({ type: "done", text }))
          .catch((error) => {
            const { code, message, retryable } = toYoloError(error);
            if (code === "internal") console.error("agent request failed", error);
            send({ type: "error", error: { code, message, retryable } });
          })
          .finally(() => {
            if (!open) return;
            open = false;
            controller.close();
          });
      },
    });
    return new Response(body, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform" },
    });
  });

  // --- Owner pairing code (Agent Note 2026-10-08-passkey-owner-sign-in)
  // The control plane can check and use up a code, never issue one: issuing
  // is only on the local app below.
  v1.post("/owner-code/verify", async (c) => c.json(ownerCodes.verify((await json(c)).code)));
  v1.post("/owner-code/consume", async (c) => c.json(ownerCodes.consume((await json(c)).code)));

  app.route("/internal/v1", v1);

  // Media: the token in the path is the credential.
  app.all("/m/*", (c) => (media ? media.handle(c.req.raw) : c.json(errorBody(new YoloError("not_found", "No media pipeline")), 404)));

  return app;
}

// Owner commands run on the home machine (`npm run owner-code`). This app is
// served only on the local Unix socket (local.js), never on the TCP listener
// that the control plane reaches, so no request from Cloudflare can issue a
// code. Requests must still be signed with NODE_SECRET.
export function createLocalApp({ secret, ownerCodes }) {
  const app = baseApp(secret);
  app.use("*", requireSignature(secret));
  app.post("/local/v1/owner-code", (c) => c.json(ownerCodes.issue()));
  return app;
}
