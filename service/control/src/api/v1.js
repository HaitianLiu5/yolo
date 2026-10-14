import { Hono } from "hono";
import { errorBody, isHttpUrl, MAX_DEVICE_EVENTS_BODY_BYTES, normalizeSourceRef, sourceFromRef, toYoloError, YoloError } from "@useyolo/core";
import { allowDeviceEvents, logDeviceEvents, parseDeviceEvents } from "../device-events.js";

// HTTP API under /v1 (Agent Note 2026-10-07-v1-http-api). OAuthProvider has
// already validated the bearer token; `getContext(c)` supplies { services,
// scopes, userId, deviceId }. deviceId is set for a paired device's credential
// (auth/device.js), which may do what a player needs but not manage devices.

const MAX_THUMBNAIL_URL = 2048;

function sourceParam(value) {
  if (!value) return null;
  if (value.startsWith("{")) {
    try {
      return normalizeSourceRef(JSON.parse(value));
    } catch {
      throw new YoloError("invalid_request", "source must be a Source JSON object, a URL, or an item id");
    }
  }
  return sourceFromRef(value);
}

async function body(c) {
  if (!(c.req.header("content-type") || "").includes("application/json")) return {};
  try {
    const value = await c.req.json();
    return value && typeof value === "object" ? value : {};
  } catch {
    throw new YoloError("invalid_request", "Request body must be JSON");
  }
}

// `log` writes device events (one Workers Logs line each); tests capture it.
export function createV1App({ getContext, issueRealtimeTicket, log = (record) => console.log(record) }) {
  const app = new Hono().basePath("/v1");

  app.onError((error, c) => {
    const yolo = toYoloError(error);
    if (yolo.code === "internal") console.error("v1 request failed", error);
    return c.json(errorBody(yolo), yolo.status);
  });
  app.notFound((c) => c.json(errorBody(new YoloError("not_found", "No such endpoint")), 404));

  app.use("*", async (c, next) => {
    const context = await getContext(c);
    c.set("services", context.services);
    c.set("scopes", context.scopes || []);
    c.set("userId", context.userId);
    c.set("deviceId", context.deviceId ?? null);
    await next();
  });

  const need = (scope) => async (c, next) => {
    if (!c.get("scopes").includes(scope)) throw new YoloError("forbidden", `This token lacks the "${scope}" scope`);
    await next();
  };
  const read = need("read");
  const control = need("control");
  const manage = need("manage");
  const notDevice = async (c, next) => {
    if (c.get("deviceId")) throw new YoloError("forbidden", "A device credential cannot manage devices");
    await next();
  };
  const svc = (c) => c.get("services");

  app.get("/me", read, async (c) => c.json(await svc(c).me()));

  // --- Devices -----------------------------------------------------------
  app.get("/devices", read, async (c) => c.json(await svc(c).devices()));
  // A paired device forgets itself ("Forget this screen"): its record and
  // credential go, as when the owner removes it. Only its own credential can.
  app.delete("/devices/self", manage, async (c) => {
    const deviceId = c.get("deviceId");
    if (!deviceId) throw new YoloError("forbidden", "Only a paired device's credential can remove itself");
    return c.json(await svc(c).deleteDevice(deviceId));
  });
  // The owner's name and type (car, browser, phone, tv, other) for a device.
  app.patch("/devices/:id", manage, notDevice, async (c) => {
    const { name, kind } = await body(c);
    return c.json(await svc(c).renameDevice(c.req.param("id"), { name, kind }));
  });
  // Removing a device revokes its credential and disconnects it.
  app.delete("/devices/:id", manage, notDevice, async (c) => c.json(await svc(c).deleteDevice(c.req.param("id"))));
  // A paired device's telemetry: logged, not stored (device-events.js).
  app.post("/devices/self/events", async (c) => {
    const deviceId = c.get("deviceId");
    if (!deviceId) throw new YoloError("forbidden", "Only a paired device's credential can send device events");
    if (Number(c.req.header("content-length")) > MAX_DEVICE_EVENTS_BODY_BYTES) {
      throw new YoloError("invalid_request", `A batch of device events is limited to ${MAX_DEVICE_EVENTS_BODY_BYTES} bytes`);
    }
    if (!allowDeviceEvents(deviceId)) throw new YoloError("rate_limited", "Too many device event batches; send at most one every 10 seconds");
    const batch = parseDeviceEvents(await c.req.text());
    return c.json(logDeviceEvents({ userId: c.get("userId"), deviceId, batch, log }), 202);
  });

  // --- Playback ----------------------------------------------------------
  app.get("/playback", read, async (c) => c.json(await svc(c).playbackState()));
  app.post("/playback/play", control, async (c) => {
    const input = await body(c);
    return c.json(await svc(c).play({
      source: input.source ? normalizeSourceRef(input.source) : undefined,
      itemId: input.itemId,
      url: input.url,
      queueItemId: input.queueItemId,
      device: input.deviceId ?? null,
      startAt: input.startTime ?? null,
      // A player rebuilding its own stream (recovery, seek, quality) says
      // which session it replaces, and whether it was paused.
      reason: input.reason ?? "play",
      autoplay: input.autoplay !== false,
      replaces: input.sessionId ?? null,
      // The device's adaptive-quality cap: a number of kbps, null for none,
      // absent to let the Hub use what this device last asked for.
      maxVideoKbps: input.maxVideoKbps,
      // "lan" when the device reaches the node's LAN listener now, "tunnel"
      // otherwise; absent to let the Hub use its last `network` report.
      network: input.network,
      // A paired device playing on itself may be a moment ahead of its own
      // socket's hello (the car waking up); the Hub waits for it briefly.
      requester: c.get("deviceId"),
    }));
  });
  for (const action of ["pause", "resume", "stop", "next", "previous"]) {
    app.post(`/playback/${action}`, control, async (c) => c.json(await svc(c).control(action)));
  }
  app.post("/playback/seek", control, async (c) => c.json(await svc(c).seek((await body(c)).position)));
  app.put("/playback/device", control, async (c) => c.json(await svc(c).transfer((await body(c)).deviceId)));
  app.put("/playback/tracks", control, async (c) => {
    const { subtitles, audio } = await body(c);
    return c.json(await svc(c).setTracks({ subtitles, audio }));
  });
  app.get("/tracks", read, async (c) => {
    const source = sourceParam(c.req.query("source"));
    return c.json(await svc(c).listTracks(source ? { source } : {}));
  });

  // One picture of a video (Agent Note 2026-10-13-video-frames): the JPEG,
  // with the time used and the source in headers. `source` is an item id, a
  // URL, or a Source as JSON; without it, the item playing now.
  app.get("/frame", read, async (c) => {
    const width = c.req.query("width");
    const frame = await svc(c).frame({
      source: sourceParam(c.req.query("source")),
      time: c.req.query("time") ?? null,
      ...(width ? { width: Number(width) } : {}),
    });
    const bytes = Uint8Array.from(atob(frame.image), (char) => char.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        "content-type": frame.mimeType,
        "cache-control": "no-store",
        "x-yolo-frame-time": String(frame.time),
        "x-yolo-frame-title": encodeURIComponent(frame.title ?? ""),
        "x-yolo-frame-source": frame.plugin,
        "x-yolo-frame-input": frame.input,
      },
    });
  });

  // A storyboard (Agent Note 2026-10-13-video-frames): one JPEG of `count`
  // evenly spaced frames, with their times, comma-separated seconds, in
  // x-yolo-storyboard-times.
  app.get("/storyboard", read, async (c) => {
    const number = (name) => (c.req.query(name) ? Number(c.req.query(name)) : undefined);
    const board = await svc(c).storyboard({
      source: sourceParam(c.req.query("source")),
      from: c.req.query("from") ?? null,
      to: c.req.query("to") ?? null,
      count: number("count"),
      width: number("width"),
    });
    return new Response(Uint8Array.from(atob(board.image), (char) => char.charCodeAt(0)), {
      headers: {
        "content-type": board.mimeType,
        "cache-control": "no-store",
        "x-yolo-storyboard-times": board.times.join(","),
        "x-yolo-storyboard-origin": board.origin,
        "x-yolo-frame-title": encodeURIComponent(board.title ?? ""),
        "x-yolo-frame-source": board.plugin,
      },
    });
  });

  // --- Queue -------------------------------------------------------------
  app.get("/queue", read, async (c) => c.json(await svc(c).listQueue()));
  app.post("/queue", manage, async (c) => {
    const input = await body(c);
    return c.json(await svc(c).addToQueue({
      source: input.source ? normalizeSourceRef(input.source) : undefined,
      url: input.url,
      itemId: input.itemId,
      position: input.position ?? "end",
    }), 201);
  });
  app.post("/queue/reorder", manage, async (c) => c.json(await svc(c).reorderQueue((await body(c)).ids)));
  app.delete("/queue/:id", manage, async (c) => c.json(await svc(c).removeFromQueue(c.req.param("id"))));
  app.delete("/queue", manage, async (c) => c.json(await svc(c).clearQueue()));

  // --- Playlists ---------------------------------------------------------
  app.get("/playlists", read, async (c) => c.json(await svc(c).listPlaylists()));
  app.post("/playlists", manage, async (c) => c.json(await svc(c).createPlaylist(await body(c)), 201));
  app.post("/playlists/import", manage, async (c) => {
    const { url, name, enqueue } = await body(c);
    return c.json(await svc(c).importPlaylist({ url, name, enqueue: enqueue === true }), 201);
  });
  app.get("/playlists/:id", read, async (c) => c.json(await svc(c).getPlaylist(c.req.param("id"))));
  app.patch("/playlists/:id", manage, async (c) => {
    const { name, description } = await body(c);
    return c.json(await svc(c).updatePlaylist(c.req.param("id"), { name, description }));
  });
  app.delete("/playlists/:id", manage, async (c) => c.json(await svc(c).deletePlaylist(c.req.param("id"))));
  app.post("/playlists/:id/items", manage, async (c) => {
    const input = await body(c);
    return c.json(await svc(c).addToPlaylist(c.req.param("id"), {
      source: input.source ? normalizeSourceRef(input.source) : undefined,
      url: input.url,
      itemId: input.itemId,
    }), 201);
  });
  app.delete("/playlists/:id/items/:itemId", manage, async (c) => (
    c.json(await svc(c).removeFromPlaylist(c.req.param("id"), c.req.param("itemId")))
  ));
  app.post("/playlists/:id/reorder", manage, async (c) => c.json(await svc(c).reorderPlaylist(c.req.param("id"), (await body(c)).ids)));
  app.post("/playlists/:id/enqueue", manage, async (c) => (
    c.json(await svc(c).enqueuePlaylist(c.req.param("id"), { position: (await body(c)).position ?? "end" }))
  ));

  // --- History -----------------------------------------------------------
  app.get("/history", read, async (c) => c.json(await svc(c).history({ limit: c.req.query("limit") })));
  app.delete("/history", manage, async (c) => c.json(await svc(c).deleteHistory({ sourceKey: (await body(c)).sourceKey ?? null })));

  // --- Library (proxied to the node; no provider names in the routes) ----
  app.get("/library", read, async (c) => c.json(await svc(c).browse({})));
  app.get("/library/search", read, async (c) => {
    const q = c.req.query("q");
    if (isHttpUrl(q)) throw new YoloError("invalid_request", "Use the MCP search tool or POST /v1/queue to resolve URLs");
    return c.json(await svc(c).search({ query: q, type: c.req.query("type") || null }));
  });
  app.get("/library/items/:id/children", read, async (c) => c.json(await svc(c).browse({ itemId: c.req.param("id") })));
  app.get("/library/items/:id/artwork", read, async (c) => {
    const upstream = await svc(c).artwork(c.req.param("id"), c.req.query("variant") || "poster");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "image/jpeg",
        "cache-control": "private, max-age=86400",
      },
    });
  });
  // A thumbnail on another host (a web video's), fetched by the node, so a
  // screen loads every image from Yolo's own origin with its credential.
  app.get("/thumbnail", read, async (c) => {
    const url = c.req.query("url");
    if (!isHttpUrl(url) || url.length > MAX_THUMBNAIL_URL) throw new YoloError("invalid_request", "url must be an http(s) URL");
    const upstream = await svc(c).thumbnail(url);
    return new Response(upstream.body, {
      headers: {
        "content-type": upstream.headers.get("content-type") || "image/jpeg",
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
      },
    });
  });
  app.get("/library/:libraryId/items", read, async (c) => c.json(await svc(c).browse({
    libraryId: c.req.param("libraryId"),
    offset: Number(c.req.query("offset")) || 0,
    limit: Number(c.req.query("limit")) || 50,
  })));

  // --- Realtime ----------------------------------------------------------
  // Browsers cannot set Authorization on a WebSocket, so trade the token for
  // a one-time ticket first (Agent Note 2026-10-07-oauth-authorization-server).
  app.post("/realtime/ticket", read, async (c) => c.json(await issueRealtimeTicket(c.env, c.get("userId"), { deviceId: c.get("deviceId") })));

  return app;
}
