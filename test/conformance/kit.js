import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { CLIENT_PROTOCOLS, HEARTBEAT_PING, HEARTBEAT_PONG } from "@useyolo/core";

// The client protocol's conformance kit (Agent Note
// 2026-10-19-client-protocol): a scripted control plane that plays
// scenarios against a real client over the real protocol. It answers what a
// screen calls (/.well-known/yolo, the device grant, the realtime ticket and
// channel, /v1/playback/play) as Yolo does, answers the exact heartbeat as
// the Hub's auto-response does, serves a short clip from a second origin as
// the node's LAN listener does, and can do what a test needs and the real
// Hub never would on cue: drop a command as a dead connection takes it,
// close with a rate limit, revoke the device. Through the client's debug
// socket (`/debug`) it asks what the screen shows.
//
// The client is launched with the kit's address by the command in
// YOLO_CONFORMANCE_LAUNCH, `{url}` replaced, and each scenario starts it
// afresh. The command must end the client's previous process first: for the
// Apple TV app in the Simulator,
//   xcrun simctl terminate <udid> <bundle id>; sleep 1; xcrun simctl launch <udid> <bundle id> -YoloConformanceURL {url}
// (`simctl launch --terminate-running-process` can race: the new process
// starts and is killed while the old one, still bound to the last kit, lives
// on.)

const exec = promisify(execFile);
const ffmpeg = (args) => exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

export const LAUNCH = process.env.YOLO_CONFORMANCE_LAUNCH || "";
export const DEVICE_ID = "dev_conformance";
const TOKEN = "ydt_conformance";

/** Short clips the kit plays: `long` (30 s) and `short` (4 s, to reach its end). */
export async function makeClips() {
  const dir = await mkdtemp(join(tmpdir(), "yolo-conformance-"));
  const clip = (name, seconds) => ffmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-movflags", "+faststart",
    join(dir, `${name}.mp4`),
  ]);
  await Promise.all([clip("long", 30), clip("short", 4)]);
  const clips = { long: { body: await readFile(join(dir, "long.mp4")), duration: 30 }, short: { body: await readFile(join(dir, "short.mp4")), duration: 4 } };
  await rm(dir, { recursive: true, force: true });
  return clips;
}

/** Sends `body` in chunks at `bytesPerSecond` (a number, or read again for each chunk), so a client cannot buffer it all at once. */
function sendThrottled(res, body, rate) {
  const bytesPerSecond = () => (typeof rate === "function" ? rate() : rate);
  const chunk = 32_768;
  let offset = 0;
  const next = () => {
    if (res.destroyed) return;
    if (offset >= body.length) return res.end();
    const part = body.subarray(offset, offset + chunk);
    offset += part.length;
    res.write(part);
    setTimeout(next, (part.length / bytesPerSecond()) * 1000);
  };
  next();
}

function sendFile(req, res, body, { bytesPerSecond = 0 } = {}) {
  res.setHeader("content-type", "video/mp4");
  res.setHeader("accept-ranges", "bytes");
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  const send = (part) => {
    if (req.method === "HEAD") return res.end();
    if (bytesPerSecond) return sendThrottled(res, part, bytesPerSecond);
    return res.end(part);
  };
  if (!range) {
    res.setHeader("content-length", body.length);
    return send(body);
  }
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
  res.writeHead(206, { "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
  return send(body.subarray(start, end + 1));
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  if ((req.headers["content-type"] || "").includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Starts the kit. `clientProtocols` is what /.well-known/yolo serves.
 * Everything the client sends is in `kit.events`, in order:
 * `{ at, kind: "http" | "message" | "ping" | "socket" | "debug", … }`.
 */
export async function startKit({ clips, clientProtocols = CLIENT_PROTOCOLS } = {}) {
  const events = [];
  const waiters = new Set();
  const record = (event) => {
    events.push({ at: Date.now(), ...event });
    for (const waiter of [...waiters]) waiter.check();
  };

  const kit = {
    events,
    clientProtocols,
    /** How the token endpoint answers: "approve" at the first poll, or "pending". */
    pairing: "approve",
    /** The next ticket requests' status: 200, 429, or 401. */
    ticketStatus: 200,
    /** The Hub's PlaybackState as the kit keeps it. */
    state: { status: "idle", deviceId: null, item: null, position: 0, positionAt: 0, tracks: { subtitles: [], audio: null }, sessionId: null },
    /** The last pause or resume and seek "sent" for the stream, as the Hub keeps them for a welcome. */
    commands: null,
    /** What the next welcome lists as media paths; null for the default (the LAN origin). */
    media: null,
    /** Answers POST /v1/playback/play; by default a stream at the asked position. */
    onPlay: null,
    socket: null,
    debugSocket: null,
    sessions: 0,
    /** How fast the LAN listener sends media, in times real time. */
    mediaRate: 1.5,
    deadMedia: new Set(),
    /** The LAN listener's open media responses, by session, for killMedia(). */
    mediaResponses: new Map(),
  };

  // The node's LAN listener: media under /m/* and the probe, which answers
  // only to the server's origin, as an origin known by its address does.
  const lan = await listen((req, res) => {
    const url = new URL(req.url, "http://kit");
    record({ kind: "http", origin: "lan", method: req.method, path: url.pathname, headers: req.headers });
    if (url.pathname === "/edge/probe") {
      if (req.headers.origin !== kit.url) return json(res, 403, { ok: false });
      res.setHeader("access-control-allow-origin", kit.url);
      return json(res, 200, { ok: true });
    }
    if (/^\/m\/[^/]+\/comments$/.test(url.pathname)) {
      // A comment every half second, as a video with danmaku has.
      const start = Number(url.searchParams.get("start"));
      const end = Number(url.searchParams.get("end"));
      const comments = [];
      for (let t = Math.ceil(start * 2) / 2; t < Math.min(end, 30); t += 0.5) comments.push({ t, text: `Comment at ${t}s`, mode: "scroll", color: "#ffffff", size: 1 });
      res.setHeader("access-control-allow-origin", kit.url);
      return json(res, 200, { available: true, start, end, complete: true, comments });
    }
    if (/^\/m\/[^/]+\/en\.vtt$/.test(url.pathname)) {
      res.writeHead(200, { "content-type": "text/vtt" });
      return res.end("WEBVTT\n\n00:00:00.000 --> 00:01:00.000\nConformance subtitle\n");
    }
    const media = /^\/m\/([^/]+)\/(long|short)\.mp4$/.exec(url.pathname);
    if (media && !kit.deadMedia.has(media[1])) {
      // About 1.5 times real time: the clip plays as it arrives, as a long
      // file does, so a path that dies mid-play takes what is not buffered.
      const clip = clips[media[2]];
      const open = kit.mediaResponses.get(media[1]) ?? new Set();
      open.add(res);
      kit.mediaResponses.set(media[1], open);
      res.on("close", () => open.delete(res));
      return sendFile(req, res, clip.body, { bytesPerSecond: () => (clip.body.length / clip.duration) * kit.mediaRate });
    }
    if (media) {
      req.socket.destroy();
      return undefined;
    }
    return json(res, 404, { error: { code: "not_found", message: "No such route" } });
  });
  kit.lanUrl = lan.url;

  const main = await listen(async (req, res) => {
    const url = new URL(req.url, "http://kit");
    const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : {};
    record({ kind: "http", origin: "server", method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
    const bearer = req.headers.authorization === `Bearer ${TOKEN}`;
    switch (`${req.method} ${url.pathname}`) {
      case "GET /.well-known/yolo":
        return json(res, 200, { name: "Yolo", version: "conformance", ...(kit.clientProtocols ? { clientProtocols: kit.clientProtocols } : {}) });
      case "POST /oauth/device_authorization":
        return json(res, 200, {
          device_code: "dc_conformance", user_code: "BCDF-GHJK", verification_uri: `${kit.url}/device`,
          verification_uri_complete: `${kit.url}/device?code=BCDF-GHJK`, expires_in: 600, interval: 5,
        });
      case "POST /oauth/token":
        if (kit.pairing === "approve") return json(res, 200, { access_token: TOKEN, token_type: "Bearer", device_id: DEVICE_ID });
        return json(res, 400, { error: "authorization_pending" });
      case "POST /v1/realtime/ticket":
        if (!bearer || kit.ticketStatus === 401) return json(res, 401, { error: { code: "unauthorized", message: "Unknown device" } });
        if (kit.ticketStatus === 429) return json(res, 429, { error: { code: "rate_limited", message: "Too many realtime connections; retry later", retryable: true } });
        return json(res, 200, { ticket: "hub.conformance" });
      case "POST /v1/playback/play": {
        if (!bearer) return json(res, 401, { error: { code: "unauthorized", message: "Unknown device" } });
        const answer = kit.onPlay ? await kit.onPlay(body) : kit.play({
          startTime: body.startTime ?? 0, autoplay: body.autoplay !== false, reason: body.reason || "play", network: body.network ?? "relay",
        });
        return json(res, answer?.status ?? 200, answer?.body ?? { state: kit.state });
      }
      case "GET /v1/history":
        return json(res, 200, []);
      case "GET /v1/library":
        return json(res, 200, { libraries: [] });
      default: {
        const media = /^\/m\/([^/]+)\/(long|short)\.mp4$/.exec(url.pathname);
        if (media) return sendFile(req, res, clips[media[2]].body);
        return json(res, 404, { error: { code: "not_found", message: "No such route" } });
      }
    }
  });
  kit.url = main.url;

  // The realtime channel, and the client's debug socket.
  const realtime = new WebSocketServer({ noServer: true });
  const debug = new WebSocketServer({ noServer: true });
  main.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://kit");
    if (url.pathname === "/debug") {
      debug.handleUpgrade(req, socket, head, (ws) => {
        kit.debugSocket = ws;
        record({ kind: "debug", event: "open" });
        ws.on("message", (data) => {
          const answer = JSON.parse(String(data));
          record({ kind: "debug", event: "state", state: answer });
        });
      });
      return;
    }
    if (url.pathname === "/v1/realtime" && url.searchParams.get("ticket") === "hub.conformance") {
      realtime.handleUpgrade(req, socket, head, (ws) => accept(ws));
      return;
    }
    socket.destroy();
  });

  function accept(ws) {
    kit.socket = ws;
    record({ kind: "socket", event: "open" });
    ws.on("close", (code) => record({ kind: "socket", event: "close", code, current: kit.socket === ws }));
    ws.on("message", (data) => {
      const text = String(data);
      // The Hub's runtime answers only this exact string without waking up.
      if (text === HEARTBEAT_PING) {
        record({ kind: "ping", exact: true });
        ws.send(HEARTBEAT_PONG);
        return;
      }
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        record({ kind: "message", invalid: text });
        return;
      }
      if (message?.type === "ping") {
        record({ kind: "ping", exact: false, text });
        return;
      }
      record({ kind: "message", message });
      if (message.type === "hello") welcome(ws, message);
      if (message.type === "report" && message.sessionId === kit.state.sessionId) {
        if (["loading", "playing", "paused", "buffering"].includes(message.status)) kit.state.status = message.status;
        kit.state.position = Number(message.position) || 0;
        kit.state.positionAt = Date.now();
      }
    });
  }

  function welcome(ws, hello) {
    kit.hello = hello;
    if (kit.upgradeOnHello) {
      ws.send(JSON.stringify({ v: 1, type: "welcome", upgrade: true, clientProtocols: [99] }));
      ws.close(1000, "upgrade");
      return;
    }
    const media = kit.media ?? { paths: [{ path: "lan", origin: kit.lanUrl, notAfter: Date.now() + 86_400_000 }], relayMode: "auto" };
    ws.send(JSON.stringify({
      v: 1, type: "welcome", deviceId: DEVICE_ID, state: kit.state, queue: [], playlists: [], media,
      ...(kit.commands && kit.commands.sessionId === kit.state.sessionId ? { commands: kit.commands } : {}),
    }));
  }

  /** Sends a message on the current connection, as the Hub does. */
  kit.send = (message) => {
    kit.socket?.send(JSON.stringify({ v: 1, ...message }));
    kit.remember(message);
  };

  /** Keeps a pause, resume, or seek for the next welcome, as the Hub does. */
  kit.remember = (message) => {
    if (!["pause", "resume", "seek"].includes(message.type) || !message.id || message.sessionId !== kit.state.sessionId) return;
    kit.commands = kit.commands?.sessionId === message.sessionId ? kit.commands : { sessionId: message.sessionId };
    if (message.type === "seek") kit.commands.seek = { id: message.id, position: message.position };
    else kit.commands.playback = { id: message.id, action: message.type };
  };

  /** A command the Hub counted as sent but a dead connection took. */
  kit.lose = (message) => kit.remember(message);

  /** The connection dies without a close handshake: the client sees 1006. */
  kit.kill = () => kit.socket?.terminate();

  kit.close = async (code, reason) => kit.socket?.close(code, reason);

  /** The LAN path dies mid-play for a session: open media connections drop, new ones fail. */
  kit.killMedia = (sessionId) => {
    kit.deadMedia.add(sessionId);
    for (const res of kit.mediaResponses.get(sessionId) ?? []) res.destroy();
  };

  /** Plays the long or short clip on the client, as a `load`, on `network`'s origin. */
  kit.play = ({ clip = "long", startTime = 0, autoplay = true, reason = "play", network = "lan" } = {}) => {
    kit.sessions += 1;
    const sessionId = `ses_${kit.sessions}`;
    const item = { title: `Conformance ${clip}`, duration: clips[clip].duration, isLive: false, source: { plugin: "conformance", id: clip } };
    kit.state = { status: autoplay ? "loading" : "paused", deviceId: DEVICE_ID, item, position: startTime, positionAt: Date.now(), tracks: { subtitles: [], audio: null }, sessionId };
    kit.commands = null;
    kit.send({
      type: "load", reason, startTime, autoplay, item,
      stream: {
        sessionId, delivery: { type: "mp4", url: `/m/${sessionId}/${clip}.mp4` }, origin: network === "lan" ? kit.lanUrl : null, network: network === "lan" ? "lan" : "tunnel",
        title: item.title, duration: item.duration, isLive: false, startTime,
        comments: `/m/${sessionId}/comments`,
        // What adaptive quality reads: the stream's bitrate and the cap used.
        profile: { width: 640, height: 360, fps: 30, videoKbps: Math.round((clips[clip].body.length * 8) / clips[clip].duration / 1000), audioKbps: 128, split: false },
        limits: { maxVideoKbps: null, ceilingKbps: 200_000, capped: false },
        tracks: {
          subtitles: [{ id: "sub_en", kind: "subtitle", language: "en", name: "English", format: "text", delivery: "vtt", url: `/m/${sessionId}/en.vtt` }],
          audio: [
            { id: "audio_en", kind: "audio", language: "en", name: "English", auto: false, format: "text", default: true, delivery: "stream" },
            { id: "audio_ja", kind: "audio", language: "ja", name: "Japanese", auto: false, format: "text", default: false, delivery: "stream" },
          ],
          selected: { subtitles: [], audio: null },
        },
      },
    });
    // The Hub tells every screen, as it does after each load.
    kit.send({ type: "state", state: kit.state });
    return { body: { state: kit.state } };
  };

  /** Resolves with the first event since `since` that `match` accepts. */
  kit.waitFor = (match, { timeout = 30_000, since = 0, label = "event" } = {}) => new Promise((resolve, reject) => {
    const waiter = {
      check() {
        const found = events.find((event) => event.at >= since && match(event));
        if (!found) return;
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(found);
      },
    };
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`Timed out after ${timeout} ms waiting for ${label}`));
    }, timeout);
    waiters.add(waiter);
    waiter.check();
  });

  /** The first message of `type` the client sent since `since`. */
  kit.message = (type, { since = 0, timeout, where = () => true } = {}) => kit.waitFor(
    (event) => event.kind === "message" && event.message.type === type && where(event.message), { since, timeout, label: `a ${type} message` },
  ).then((event) => event.message);

  /** Messages of the client since `since`, heartbeats aside. */
  kit.messages = (since = 0) => events.filter((event) => event.kind === "message" && event.at >= since).map((event) => event.message);

  /** What the screen shows now, from its debug socket. */
  kit.debug = async ({ timeout = 10_000 } = {}) => {
    await kit.waitFor((event) => event.kind === "debug" && event.event === "open", { timeout: 30_000, label: "the client's debug socket" });
    const since = Date.now();
    kit.debugSocket.send(JSON.stringify({ v: 1, type: "debug_state" }));
    const event = await kit.waitFor((entry) => entry.kind === "debug" && entry.event === "state", { since, timeout, label: "debug_state" });
    return event.state;
  };

  /** Polls the debug state until `match` accepts it. */
  kit.until = async (match, { timeout = 20_000, label = "the screen" } = {}) => {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      last = await kit.debug();
      if (match(last)) return last;
      await new Promise((done) => setTimeout(done, 500));
    }
    throw new Error(`Timed out waiting for ${label}; last debug state: ${JSON.stringify(last)}`);
  };

  /** Starts the client afresh against this kit. */
  kit.launch = async () => {
    const command = LAUNCH.replaceAll("{url}", kit.url);
    await new Promise((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "ignore", "pipe"] });
      let errors = "";
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Launching the client failed (${code}): ${errors.trim()}`))));
    });
  };

  /** Launches the client and waits until it is paired, connected, and welcomed. */
  kit.ready = async () => {
    await kit.launch();
    await kit.message("hello", { timeout: 60_000 });
    return kit.until((state) => state.screen === "ready", { label: "the ready screen" });
  };

  kit.stop = async () => {
    for (const waiter of waiters) waiters.delete(waiter);
    realtime.clients.forEach((ws) => ws.terminate());
    debug.clients.forEach((ws) => ws.terminate());
    for (const { server } of [main, lan]) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  };

  return kit;
}
