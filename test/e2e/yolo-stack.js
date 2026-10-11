import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The new stack for end-to-end tests: the media node (service/node) on a free
// loopback port, and the control plane under `wrangler dev --local` on
// another, reaching the node with NODE_TRANSPORT=tunnel. The Tesla client is
// the control plane's static assets, so the browser loads it from the Worker
// origin with its COOP/COEP headers, and media flows through /m/*.
//
// Nothing here talks to Cloudflare: the Worker runs from a generated config
// without the custom-domain route and the Workers VPC binding, D1 and KV are
// local under a temporary directory, and no port is fixed.

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const control = join(root, "service/control");
const wranglerBin = join(root, "node_modules/wrangler/bin/wrangler.js");
export const OWNER = "usr_e2eowner";

export function freePort() {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function withTimeout(promise, label, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function run(command, args, { cwd, env, label }) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? done(output) : reject(new Error(`${label} failed (${code}):\n${output.slice(-4000)}`))));
  });
}

async function stopChild(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await withTimeout(new Promise((done) => child.once("exit", done)), `${label} shutdown`, 8_000);
  } catch {
    child.kill("SIGKILL");
  }
}

// The client must be built: the Worker serves clients/tesla/dist.
export async function ensureClientBuilt() {
  if (existsSync(join(root, "clients/tesla/dist/index.html"))) return;
  await run(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "build"], { cwd: join(root, "clients/tesla"), env: process.env, label: "client build" });
}

// wrangler.jsonc minus what would reach Cloudflare, with absolute paths.
async function writeWranglerConfig(dir) {
  const migrations = join(dir, "migrations");
  await mkdir(migrations, { recursive: true });
  for (const file of readdirSync(join(control, "migrations")).filter((name) => name.endsWith(".sql"))) {
    await copyFile(join(control, "migrations", file), join(migrations, file));
  }
  // The owner (normally created with the first passkey).
  await writeFile(join(migrations, "9999_e2e_owner.sql"), `INSERT INTO users (id, user_id, display_name, created_at) VALUES ('${OWNER}', '${OWNER}', 'Owner', 0);\n`);
  const config = {
    name: "yolo-control-e2e",
    main: join(control, "src/index.js"),
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    workers_dev: false,
    build: { command: `"${process.execPath}" "${join(control, "scripts/generate-plugins.js")}"`, cwd: control },
    assets: {
      directory: join(root, "clients/tesla/dist"),
      not_found_handling: "single-page-application",
      run_worker_first: ["/v1/*", "/m/*", "/mcp", "/mcp/*", "/oauth/*", "/.well-known/*", "/login", "/device", "/account", "/auth/*"],
    },
    d1_databases: [{ binding: "DB", database_name: "yolo", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: migrations }],
    kv_namespaces: [{ binding: "OAUTH_KV", id: "e2e-oauth-kv" }],
    durable_objects: { bindings: [{ name: "HUB", class_name: "Hub" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Hub"] }],
  };
  const path = join(dir, "wrangler.e2e.json");
  await writeFile(path, JSON.stringify(config, null, 2));
  return path;
}

const sha256 = (value) => createHash("sha256").update(value).digest("base64url");

export async function startYolo(t, { pluginConfig, nodeEnv = {} } = {}) {
  await ensureClientBuilt();
  // Short: the node's Unix socket path must fit in 104 bytes.
  const dir = await mkdtemp(join(tmpdir(), "yolo-e2e-"));
  const secret = randomBytes(24).toString("base64url");
  const [nodePort, workerPort, inspectorPort] = [await freePort(), await freePort(), await freePort()];
  const origin = `http://127.0.0.1:${workerPort}`;
  const children = [];
  t.after(async () => {
    for (const child of children.reverse()) await stopChild(child.process, child.label);
    await rm(dir, { recursive: true, force: true });
  });

  const configPath = join(dir, "yolo.config.json");
  await writeFile(configPath, JSON.stringify(pluginConfig ?? { plugins: [join(root, "plugins/source-ytdlp")] }));
  const env = {
    ...process.env,
    YOLO_CONFIG: configPath,
    DRIVEIN_ENV_FILE: "",
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
    NO_COLOR: "1",
  };

  // --- The media node ---------------------------------------------------
  const nodeProcess = spawn(process.execPath, [join(root, "service/node/src/main.js")], {
    cwd: root,
    env: {
      ...env,
      NODE_SECRET: secret,
      NODE_HOST: "127.0.0.1",
      NODE_PORT: String(nodePort),
      NODE_LOCAL_SOCKET: join(dir, "n.sock"),
      YOLO_RUNTIME_DIR: join(dir, "node"),
      DRIVEIN_LEGACY_URL: "off",
      LOG_LEVEL: process.env.YOLO_E2E_LOG || "warn",
      ...nodeEnv,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push({ process: nodeProcess, label: "node" });
  const nodeLog = [];
  nodeProcess.stdout.on("data", (chunk) => nodeLog.push(String(chunk)));
  nodeProcess.stderr.on("data", (chunk) => nodeLog.push(String(chunk)));
  await withTimeout(new Promise((done, reject) => {
    nodeProcess.on("message", (message) => {
      if (message?.type === "yolo-node-listening") done();
    });
    nodeProcess.once("exit", (code) => reject(new Error(`The node exited (${code}):\n${nodeLog.join("")}`)));
  }), "the media node", 20_000);

  // --- The control plane ------------------------------------------------
  const wranglerConfig = await writeWranglerConfig(dir);
  const persist = join(dir, "wrangler");
  await run(process.execPath, [wranglerBin, "d1", "migrations", "apply", "yolo", "--local", "--persist-to", persist, "--config", wranglerConfig], {
    cwd: control, env, label: "D1 migrations",
  });
  // An owner session for approving devices on /device (KV holds its hash).
  const sessionId = randomBytes(24).toString("base64url");
  await run(process.execPath, [
    wranglerBin, "kv", "key", "put", "--binding", "OAUTH_KV", "--local", "--persist-to", persist, "--config", wranglerConfig,
    `yolo:session:${sha256(sessionId)}`, JSON.stringify({ userId: OWNER, createdAt: Date.now() }),
  ], { cwd: control, env, label: "KV session" });

  const worker = spawn(process.execPath, [
    wranglerBin, "dev", "--local", "--config", wranglerConfig, "--ip", "127.0.0.1", "--port", String(workerPort),
    "--inspector-port", String(inspectorPort), "--persist-to", persist, "--show-interactive-dev-session=false",
    "--var", `PUBLIC_ORIGIN:${origin}`, "--var", "NODE_TRANSPORT:tunnel",
    "--var", `NODE_PUBLIC_ORIGIN:http://127.0.0.1:${nodePort}`, "--var", `NODE_SECRET:${secret}`,
  ], { cwd: control, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push({ process: worker, label: "wrangler dev" });
  const workerLog = [];
  worker.stdout.on("data", (chunk) => workerLog.push(String(chunk)));
  worker.stderr.on("data", (chunk) => workerLog.push(String(chunk)));
  await withTimeout(new Promise((done, reject) => {
    const check = () => {
      if (workerLog.join("").includes("Ready on")) done();
    };
    worker.stdout.on("data", check);
    worker.stderr.on("data", check);
    worker.once("exit", (code) => reject(new Error(`wrangler dev exited (${code}):\n${workerLog.join("")}`)));
  }), "wrangler dev", 60_000);

  const cookie = `__Host-yolo-session=${sessionId}`;
  return {
    origin,
    secret,
    dir,
    logs: () => ({ node: nodeLog.join("").slice(-6000), worker: workerLog.join("").slice(-6000) }),

    // The owner presses Allow for this user code on /device.
    async approve(userCode, decision = "approve") {
      const response = await fetch(`${origin}/device`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
        body: new URLSearchParams({ code: userCode, decision }).toString(),
      });
      return { status: response.status, text: await response.text() };
    },

    // An agent's access token, through the real OAuth flow: dynamic client
    // registration, the owner's consent, and the code exchange with PKCE.
    async agentToken({ scopes = ["read", "control", "manage"] } = {}) {
      const redirect = "http://127.0.0.1:9/callback";
      const client = await (await fetch(`${origin}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "E2E agent", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
      })).json();
      const verifier = randomBytes(32).toString("base64url");
      const authorize = new URL(`${origin}/oauth/authorize`);
      for (const [name, value] of Object.entries({
        response_type: "code", client_id: client.client_id, redirect_uri: redirect, scope: scopes.join(" "), state: "e2e",
        code_challenge: sha256(verifier), code_challenge_method: "S256", resource: origin,
      })) authorize.searchParams.set(name, value);
      const consent = await fetch(authorize, { headers: { cookie }, redirect: "manual" });
      const html = await consent.text();
      const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
      if (!handle) throw new Error(`No consent form (${consent.status}): ${html.slice(0, 300)}`);
      const consentCookies = (consent.headers.getSetCookie?.() || []).map((value) => value.split(";")[0]);
      const approved = await fetch(`${origin}/oauth/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: [cookie, ...consentCookies].join("; ") },
        body: new URLSearchParams([["handle", handle], ["decision", "approve"], ...scopes.map((scope) => ["scope", scope])]).toString(),
      });
      const location = approved.headers.get("location");
      const code = location && new URL(location).searchParams.get("code");
      if (!code) throw new Error(`Consent did not redirect with a code (${approved.status}): ${await approved.text()}`);
      const token = await (await fetch(`${origin}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: origin }).toString(),
      })).json();
      if (!token.access_token) throw new Error(`No access token: ${JSON.stringify(token)}`);
      return token.access_token;
    },

    // An MCP tool call, as an agent makes it (Streamable HTTP).
    async mcp(token, name, args = {}) {
      const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
      const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        fetch: (url, init) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${token}` } }),
      });
      const client = new Client({ name: "e2e-agent", version: "1.0.0" });
      await client.connect(transport);
      try {
        const result = await client.callTool({ name, arguments: args });
        const value = JSON.parse(result.content[0].text);
        if (result.isError) throw Object.assign(new Error(value.error?.message || "tool failed"), { body: value });
        return value;
      } finally {
        await client.close();
      }
    },

    // /v1 with a device credential (or an agent's token).
    async api(token, path, { method = "GET", body } = {}) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: response.status, body: data };
    },
  };
}

export async function readText(path) {
  return readFile(path, "utf8");
}
