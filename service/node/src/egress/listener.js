import { createServer, request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { silentLogger } from "../log.js";

// The HTTP proxy on 127.0.0.1 that the node's child processes use
// (Agent Note 2026-10-13-node-egress-proxy): a plugin's extractor and
// ffmpeg's -http_proxy point here, and `open(host, port)` (egress.js)
// connects each request direct or through a proxy by the owner's rules. HTTPS
// arrives as CONNECT and is tunnelled as is; a plain-HTTP request is sent
// over a connection `open` made. It accepts only loopback peers and never
// needs a credential on a command line.

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function parseAuthority(authority) {
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(String(authority ?? ""));
  if (!match) return null;
  const port = Number(match[2]);
  return port > 0 && port < 65536 ? { host: match[1], port } : null;
}

export function createEgressListener({ open, logger = silentLogger, host = "127.0.0.1" }) {
  const sockets = new Set();
  let address = null;

  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };

  const server = createServer(async (request, response) => {
    if (!LOOPBACK.has(request.socket.remoteAddress)) return void request.socket.destroy();
    let target;
    try {
      target = new URL(request.url);
      if (target.protocol !== "http:") throw new Error("not http");
    } catch {
      response.writeHead(400, { connection: "close" }).end("Send an absolute http:// URL or CONNECT\n");
      return;
    }
    const port = Number(target.port) || 80;
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    let opened;
    try {
      opened = await open(hostname, port);
    } catch (error) {
      response.writeHead(502, { connection: "close" }).end(`${error.message}\n`);
      return;
    }
    const socket = track(opened.socket);
    const headers = { ...request.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = httpRequest({
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...headers, host: target.host, connection: "close" },
      createConnection: () => socket,
    }, (answer) => {
      response.writeHead(answer.statusCode, answer.rawHeaders);
      answer.pipe(response);
    });
    // `open` hands the connection over paused; the client reads it from here.
    upstream.once("socket", () => socket.resume());
    upstream.once("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { connection: "close" }).end(`${error.message}\n`);
      else response.destroy();
    });
    request.pipe(upstream);
  });

  server.on("connect", async (request, client, head) => {
    track(client);
    if (!LOOPBACK.has(client.remoteAddress)) return void client.destroy();
    const target = parseAuthority(request.url);
    if (!target || (isIP(target.host) === 0 && !/^[A-Za-z0-9.-]+$/.test(target.host))) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    client.once("error", () => client.destroy());
    let opened;
    try {
      opened = await open(target.host, target.port);
    } catch (error) {
      if (!client.destroyed) client.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${error.message}\n`);
      return;
    }
    const upstream = track(opened.socket);
    if (client.destroyed) return void upstream.destroy();
    logger.debug({ host: target.host, route: opened.route }, "Egress tunnel");
    upstream.once("error", () => client.destroy());
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    upstream.resume();
  });

  server.on("clientError", (error, socket) => socket.destroy());

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, () => {
          server.off("error", reject);
          const { port } = server.address();
          address = `http://${host}:${port}`;
          logger.info({ address }, "Egress proxy for child processes listening");
          resolve(address);
        });
      });
    },
    url: () => address,
    close() {
      address = null;
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
