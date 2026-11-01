import { DurableObject } from "cloudflare:workers";
import {
  CLIENT_PROTOCOLS,
  createRateLimit,
  FIRST_CLIENT_PROTOCOL,
  errorBody,
  fromErrorBody,
  HEARTBEAT_PING,
  helloProtocolAction,
  HEARTBEAT_PONG,
  MEDIA_TOKEN_TTL_SECONDS,
  newId,
  signMediaToken,
  YoloError,
} from "@useyolo/core";
import { mediaWelcome } from "../edge/paths.js";
import { createNodeClient } from "../node-client.js";
import { TICKET_HEADER } from "../realtime.js";
import { HubCore } from "./hub-core.js";

// One Hub Durable Object per user
// (Agent Note 2026-10-07-hub-and-realtime-channel). It keeps PlaybackState in
// its own storage and holds the realtime WebSockets with the hibernation API.
//
// Nothing here wakes the Hub on a timer: devices send the heartbeat and the
// runtime answers it while the Hub sleeps. The limits below stop a buggy
// client (a reconnect loop, or a reply to every broadcast) from keeping the
// Hub awake and billing requests without end.

const MAX_SOCKETS = 16;
const CONNECT_LIMIT = { max: 20, windowMs: 60_000 };
// A playing device reports every 5 seconds plus state changes and acks.
const MESSAGE_LIMIT = { max: 30, windowMs: 10_000 };
const RATE_LIMITED_CLOSE = 1008;

// Methods the Worker may call over RPC; see hubClient() below.
const RPC_METHODS = new Set([
  "getState", "sessions", "getQueueScreen", "listDevices", "play", "control", "seek", "transfer",
  "listTracks", "setTracks", "setDanmaku", "broadcastQueue", "broadcastPlaylists", "broadcastDevices", "broadcastMedia", "forgetDevice",
  "issueTicket", "playbackHealth", "mediaUsage", "warm", "upNextList",
  "canvasRead", "canvasPut", "canvasPatch", "canvasRemove", "canvasEvents", "canvasEvent", "offer",
]);
const REVOKED_CLOSE = 4003;
// A hello that failed once the connection was the device's.
const HELLO_FAILED_CLOSE = 1011;
// A client whose protocol the Hub no longer serves, told so by its welcome.
const UPGRADE_CLOSE = 1000;

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG));
    this.allowConnect = createRateLimit(CONNECT_LIMIT);
    // socketId -> rate limit. Lost on hibernation, which needs a quiet Hub.
    this.messageLimits = new Map();
    // deviceId -> callbacks of play requests waiting for that device's hello
    // (HubCore.waitForOwnHello). A waiting request keeps the Hub awake, so
    // these are never lost to hibernation.
    this.helloWaiters = new Map();
  }

  log(event, fields = {}) {
    console.log({ kind: "hub", event, userId: this.userId ?? null, ...fields });
  }

  helloSaid(deviceId) {
    const waiters = this.helloWaiters.get(deviceId);
    if (!waiters) return;
    this.helloWaiters.delete(deviceId);
    for (const done of [...waiters]) done(true);
  }

  async core(userId) {
    if (userId) {
      if (!this.userId) this.userId = (await this.ctx.storage.get("userId")) || null;
      if (this.userId !== userId) {
        this.userId = userId;
        await this.ctx.storage.put("userId", userId);
      }
    } else if (!this.userId) {
      this.userId = await this.ctx.storage.get("userId");
    }
    if (!this.hubCore || this.hubCore.userId !== this.userId) {
      const secret = this.env.NODE_SECRET;
      const hubCore = new HubCore({
        userId: this.userId,
        storage: this.ctx.storage,
        db: this.env.DB,
        node: createNodeClient(this.env),
        transport: this.transport(),
        media: () => mediaWelcome(this.env, this.userId),
        signMediaToken: secret
          ? (sessionId) => signMediaToken(secret, {
            sessionId,
            userId: this.userId,
            exp: Math.floor(Date.now() / 1000) + MEDIA_TOKEN_TTL_SECONDS,
          })
          : null,
      });
      // The single session of the releases before screen sessions becomes
      // the session of the screen that played it (Agent Note
      // 2026-10-31-screen-sessions), before anything reads it.
      if (this.userId) await hubCore.migrateStorage();
      this.hubCore = hubCore;
    }
    return this.hubCore;
  }

  // A device may have one playing connection: the newest one that said
  // hello. Older ones of the same device were told `deactivate` and only
  // get broadcasts.
  transport() {
    const sockets = () => this.ctx.getWebSockets()
      .map((ws) => ({ ws, ...(ws.deserializeAttachment() || {}) }))
      .filter((entry) => entry.deviceId || entry.listener);
    const sendTo = (ws, message) => {
      try {
        ws.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    };
    const connectedDeviceIds = () => new Set(sockets().filter((entry) => entry.deviceId).map((entry) => entry.deviceId));
    return {
      connectedDeviceIds,
      // Resolves true when a socket of `deviceId` says hello, or false after
      // `timeoutMs`. No polling: hello() below resolves the waiters.
      waitForHello: (deviceId, timeoutMs) => new Promise((resolve) => {
        if (connectedDeviceIds().has(deviceId)) {
          resolve(true);
          return;
        }
        const waiters = this.helloWaiters.get(deviceId) ?? new Set();
        this.helloWaiters.set(deviceId, waiters);
        const done = (said) => {
          clearTimeout(timer);
          waiters.delete(done);
          if (!waiters.size && this.helloWaiters.get(deviceId) === waiters) this.helloWaiters.delete(deviceId);
          resolve(said);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        waiters.add(done);
      }),
      send: (deviceId, message) => sockets()
        .filter((entry) => entry.deviceId === deviceId)
        .map((entry) => sendTo(entry.ws, message))
        .some(Boolean),
      // `message` may be a function of the socket's entry, for what differs
      // per screen or per client protocol; null sends that socket nothing.
      broadcast: (message) => {
        for (const entry of sockets()) {
          const shaped = typeof message === "function" ? message(entry) : message;
          if (shaped) sendTo(entry.ws, shaped);
        }
      },
      close: (deviceId, code, reason) => {
        for (const ws of this.ctx.getWebSockets()) {
          const attachment = ws.deserializeAttachment() || {};
          if (attachment.deviceId !== deviceId && attachment.boundDeviceId !== deviceId) continue;
          try {
            ws.close(code, reason);
          } catch {
            // Already closed.
          }
        }
      },
    };
  }

  // Errors cross RPC as plain objects so codes like node_offline survive.
  async call(userId, method, args = []) {
    if (!RPC_METHODS.has(method)) return errorBody(new Error(`Unknown hub method ${method}`));
    try {
      const core = await this.core(userId);
      return { ok: true, value: await core[method](...args) };
    } catch (error) {
      return errorBody(error);
    }
  }

  async fetch(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    // The ticket was issued here (issueTicket over RPC), which also stored
    // this Hub's user id; realtime.js passes only its secret.
    const redeemed = await (await this.core()).redeemTicket(request.headers.get(TICKET_HEADER));
    if (!redeemed) return Response.json(errorBody(new YoloError("unauthorized", "Missing or expired ticket")), { status: 401 });
    const boundDeviceId = redeemed.deviceId;
    const sockets = this.ctx.getWebSockets().length;
    if (sockets >= MAX_SOCKETS || !this.allowConnect()) {
      this.log("decision", {
        decision: "rate_limited", deviceId: boundDeviceId, sockets, why: sockets >= MAX_SOCKETS ? "too many open sockets" : "too many new sockets this minute",
      });
      return Response.json(errorBody(new YoloError("rate_limited", "Too many realtime connections; retry later")), { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const socketId = newId("sock", 8);
    server.serializeAttachment({
      socketId,
      deviceId: null,
      // Set when the ticket came from a paired device's credential.
      boundDeviceId,
      // The address the screen connected from, for the remote path's `home` mark.
      address: request.headers.get("cf-connecting-ip") || null,
    });
    this.log("socket_accept", { socketId, deviceId: boundDeviceId, sockets: sockets + 1 });
    return new Response(null, { status: 101, webSocket: client });
  }

  allowMessage(socketId) {
    if (!this.messageLimits.has(socketId)) this.messageLimits.set(socketId, createRateLimit(MESSAGE_LIMIT));
    return this.messageLimits.get(socketId)();
  }

  async webSocketMessage(ws, data) {
    const attachment = ws.deserializeAttachment() || {};
    if (!this.allowMessage(attachment.socketId)) {
      this.log("decision", {
        decision: "rate_limited", socketId: attachment.socketId, deviceId: attachment.deviceId ?? attachment.boundDeviceId ?? null, why: "too many messages on one socket",
      });
      // Closing, not dropping: every message that reaches the Hub is billed.
      try {
        ws.close(RATE_LIMITED_CLOSE, "rate_limited");
      } catch {
        // Already closed.
      }
      return;
    }
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    if (!message || message.v !== 1 || typeof message.type !== "string") return;
    const core = await this.core();
    try {
      if (message.type === "hello") {
        // A client the Hub no longer serves gets a welcome that says so and
        // no device; a page older than the client protocol cannot read that,
        // so it gets the rate-limit close it backs off from (Agent Note
        // 2026-10-19-client-protocol).
        const action = helloProtocolAction(message.protocol);
        if (action !== "serve") {
          this.log("socket_hello", { socketId: attachment.socketId, protocol: message.protocol ?? null, refused: action });
          try {
            if (action === "upgrade") {
              ws.send(JSON.stringify({ v: 1, type: "welcome", upgrade: true, clientProtocols: CLIENT_PROTOCOLS }));
              ws.close(UPGRADE_CLOSE, "upgrade");
            } else {
              ws.close(RATE_LIMITED_CLOSE, "upgrade");
            }
          } catch {
            // Closed already.
          }
          return;
        }
        let hello;
        let replaced = 0;
        let boundTo = null;
        // This connection becomes the device's before the welcome is read
        // (HubCore.hello): what the Hub sends from then on reaches it, even
        // a moment before its welcome, and the welcome's state names what it
        // sent before.
        const bind = (device) => {
          // Another window of the same device stops playing here.
          for (const other of this.ctx.getWebSockets()) {
            if (other === ws) continue;
            const otherAttachment = other.deserializeAttachment() || {};
            if (otherAttachment.deviceId !== device.id) continue;
            other.serializeAttachment({ ...otherAttachment, deviceId: null, listener: true });
            replaced += 1;
            try {
              other.send(JSON.stringify({ v: 1, type: "deactivate", deviceId: device.id, reason: "replaced" }));
            } catch {
              // Gone already.
            }
          }
          // The protocol it speaks, for the shapes the Hub sends it.
          const protocol = Number.isInteger(message.protocol) ? message.protocol : FIRST_CLIENT_PROTOCOL;
          ws.serializeAttachment({ ...attachment, deviceId: device.id, listener: false, protocol });
          boundTo = device.id;
        };
        // Another window of the device that said hello meanwhile made this
        // connection a listener, and told it `deactivate`.
        const isBound = () => Boolean(boundTo) && (ws.deserializeAttachment() || {}).deviceId === boundTo;
        try {
          hello = await core.hello(message, { boundDeviceId: attachment.boundDeviceId || null, address: attachment.address || null, bind, isBound });
        } catch (error) {
          if (error?.code === "unauthorized") {
            ws.close(REVOKED_CLOSE, "revoked");
          } else if (boundTo) {
            // Bound, and the device's other windows told they were
            // replaced, but never welcomed: closed, the page reconnects with
            // its backoff and says hello again.
            try {
              ws.close(HELLO_FAILED_CLOSE, "hello_failed");
            } catch {
              // Closed already.
            }
          }
          throw error;
        }
        const { device, welcome, after = [] } = hello;
        if (!welcome) {
          this.log("socket_hello", { socketId: attachment.socketId, deviceId: device.id, replaced, superseded: true });
          return;
        }
        ws.send(JSON.stringify(welcome));
        // What the old connection may have taken (unacknowledged danmaku
        // changes), behind the welcome on this one.
        for (const message of after) ws.send(JSON.stringify(message));
        this.log("socket_hello", {
          socketId: attachment.socketId, deviceId: device.id, deviceName: device.name, deviceKind: device.kind, replaced,
          status: welcome.state?.status ?? null, sessionId: welcome.state?.sessionId ?? null,
        });
        // Only now, with the welcome sent, may a waiting play request go on.
        this.helloSaid(device.id);
        void core.broadcastDevices();
        return;
      }
      const { deviceId } = attachment;
      if (!deviceId) return;
      await core.deviceMessage(deviceId, message);
    } catch (error) {
      console.warn("Hub message failed", message.type, error?.message);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const attachment = ws.deserializeAttachment() || {};
    this.messageLimits.delete(attachment.socketId);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    const core = await this.core();
    const stillConnected = attachment.deviceId && this.ctx.getWebSockets()
      .some((other) => other !== ws && other.deserializeAttachment()?.deviceId === attachment.deviceId);
    this.log("socket_close", {
      socketId: attachment.socketId ?? null,
      deviceId: attachment.deviceId ?? attachment.boundDeviceId ?? null,
      saidHello: Boolean(attachment.deviceId),
      listener: Boolean(attachment.listener),
      code,
      reason: String(reason ?? "").slice(0, 120),
      wasClean: Boolean(wasClean),
      stillConnected: Boolean(stillConnected),
    });
    if (attachment.deviceId && !stillConnected) await core.deviceDisconnected(attachment.deviceId).catch(() => {});
    void core.broadcastDevices();
  }
}

// Worker-side proxy with the same async methods as HubCore.
export function hubClient(env, userId) {
  const stub = env.HUB.get(env.HUB.idFromName(userId));
  return new Proxy({}, {
    get(_target, method) {
      if (!RPC_METHODS.has(method)) return undefined;
      return async (...args) => {
        const result = await stub.call(userId, method, args);
        if (result?.ok) return result.value;
        throw fromErrorBody(result, 500);
      };
    },
  });
}
