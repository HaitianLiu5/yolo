import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { YoloError } from "@useyolo/plugin-api";
import { childEnv, cliArgs, findCommand, readLine, requestInput, SERVER_NAME, serverConfig } from "./cli.js";

// Official agent plugin (Agent Note 2026-10-18-agent-from-the-screen): a
// screen's request goes to the Codex CLI the owner already runs and signed in
// to on this machine, as the Claude Code plugin does with Claude Code. It
// works through its own MCP connection to Yolo, so Yolo holds no model
// credential and the owner pays nothing beyond their own plan. Each request
// runs `codex exec`; a request in one of Yolo's conversations carries the
// session to continue (null starts one), and one without, from an older
// control plane, continues the same screen's last session within
// `memoryMinutes`.
//
// Options (yolo.config.json), each falling back to the environment:
//   command        CODEX_COMMAND, default "codex" on PATH or where its
//                  installers put it
//   server         CODEX_YOLO_SERVER, the name Yolo's MCP server has in
//                  Codex, default "yolo"
//   model          CODEX_MODEL, default Codex's own
//   cwd            the directory it runs in, default this plugin's cache directory
//   timeoutSeconds default 180
//   memoryMinutes  default 10

export const AGENT_ID = "codex";
const DEFAULT_TIMEOUT_SECONDS = 180;
const DEFAULT_MEMORY_MINUTES = 10;
// What the CLI says when it no longer has a session to resume.
const MISSING_SESSION = /no (saved )?(session|thread|conversation|rollout)|(session|thread|conversation|rollout)[^.]{0,40}not found/i;
// How long a child that ignores SIGTERM has before SIGKILL.
const KILL_AFTER_MS = 5_000;

const GROUPS = process.platform !== "win32";

function signalAll(child, signal) {
  try {
    if (GROUPS && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

const number = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

export function createCodexAgent({
  command = "codex",
  server = "yolo",
  model = null,
  cwd = null,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  memoryMinutes = DEFAULT_MEMORY_MINUTES,
  env = process.env,
  log = console,
  now = () => Date.now(),
} = {}) {
  let resolved;
  const binary = () => (resolved ??= findCommand(command, { env }));
  // { session, at } of each screen's last request that finished.
  const memories = new Map();
  const notConnected = (why) => new YoloError("resolve_failed", `Codex on the media node's machine ${why}; connect Yolo to it with the yolo-connect-agent skill`);
  const missingServer = () => (SERVER_NAME.test(server)
    ? notConnected(`has no MCP server named "${server}" with a url`)
    : new YoloError("invalid_request", `"${server}" is not a name Codex can give an MCP server`));
  const unusable = (mcp) => (mcp && !mcp.enabled ? notConnected(`has its "${server}" MCP server turned off`) : null);

  function once(request, { signal, emit, resume }) {
    return new Promise((resolve, reject) => {
      const path = binary();
      if (!path) {
        reject(new YoloError("not_found", `Codex (${command}) is not installed on the media node's machine`));
        return;
      }
      const mcp = serverConfig(server, { env });
      if (!mcp) {
        reject(missingServer());
        return;
      }
      const off = unusable(mcp);
      if (off) {
        reject(off);
        return;
      }
      const child = spawn(path, cliArgs({ server, mcp, device: request.device, language: request.language, model, resume }), {
        cwd: cwd ?? undefined,
        env: childEnv(env),
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so stopping it also stops whatever a
        // wrapper script started.
        detached: GROUPS,
      });
      const seen = new Set();
      let session = resume;
      let acted = false;
      let message = "";
      let lastError = "";
      let result = null;
      let failure = null;
      let buffer = "";
      let stderr = "";
      let killTimer = null;
      const stop = (error) => {
        failure ??= error;
        signalAll(child, "SIGTERM");
        // A child that outlives SIGTERM, or a wrapper whose own child keeps
        // the pipes open, would hold the request open past its timeout.
        killTimer ??= setTimeout(() => {
          signalAll(child, "SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
        }, KILL_AFTER_MS);
      };
      const timer = setTimeout(() => stop(new YoloError("internal", `Codex did not finish within ${timeoutSeconds}s`, { retryable: true })), timeoutSeconds * 1000);
      const abort = () => stop(signal.reason ?? new YoloError("superseded", "The request was cancelled"));
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort, { once: true });

      const handle = (line) => {
        if (!line.trim()) return;
        const read = readLine(line, { server, seen });
        if (read.session) session = read.session;
        if (read.error) lastError = read.error;
        if (read.mcp) {
          stop(notConnected(read.mcp === "needs-auth" ? `needs \`codex mcp login ${server}\`` : `cannot reach its "${server}" MCP server (${read.error})`));
          return;
        }
        for (const event of read.events) {
          if (event.type === "tool") acted = true;
          emit(event);
        }
        if (read.message) message = read.message;
        if (read.result) result = read.result;
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          handle(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      child.on("error", (error) => {
        failure ??= new YoloError("internal", `Codex could not start: ${error.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        if (buffer) handle(buffer);
        if (failure) return reject(failure);
        if (result?.ok) return resolve({ text: message, session });
        const detail = result?.text || lastError || stderr.trim().split("\n").at(-1) || `exit code ${code}`;
        reject(new YoloError("internal", `Codex failed: ${detail}`, { retryable: true, details: { session, resumed: Boolean(resume), acted, missing: Boolean(resume) && MISSING_SESSION.test(detail) } }));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(requestInput(request, { resumed: Boolean(resume) }));
    });
  }

  return {
    title: "Codex",

    // Screens show the Ask button only while this says the agent can answer.
    health() {
      if (!binary()) return { available: false, reason: `Codex (${command}) is not installed on the media node's machine` };
      const mcp = serverConfig(server, { env });
      if (!mcp) return { available: false, reason: missingServer().message };
      const off = unusable(mcp);
      if (off) return { available: false, reason: off.message };
      return { available: true };
    },

    async ask(request, { signal, emit = () => {} } = {}) {
      if (cwd) await mkdir(cwd, { recursive: true });
      const inConversation = request.session !== undefined;
      const key = request.device?.id ?? "";
      for (const [screen, memory] of memories) if (now() - memory.at >= memoryMinutes * 60_000) memories.delete(screen);
      const resume = inConversation ? request.session : memories.get(key)?.session ?? null;
      let answer;
      try {
        answer = await once(request, { signal, emit, resume });
      } catch (error) {
        // A session the CLI no longer has fails before any tool runs: start
        // a new one. Any other failure keeps the session, since a failure
        // after a tool ran may have played or queued something already.
        if (!resume || !error?.details?.missing || error.details.acted || signal?.aborted) throw error;
        log.warn?.(`could not continue the last conversation, starting a new one: ${error.message}`);
        if (!inConversation) memories.delete(key);
        answer = await once(request, { signal, emit, resume: null });
      }
      if (inConversation) return { text: answer.text, session: answer.session ?? null };
      if (answer.session) memories.set(key, { session: answer.session, at: now() });
      else memories.delete(key);
      return { text: answer.text, session: answer.session ?? null };
    },
  };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function codexPlugin(yolo) {
  const { options, env } = yolo;
  yolo.registerAgent(AGENT_ID, createCodexAgent({
    command: options.command ?? env.CODEX_COMMAND ?? "codex",
    server: options.server ?? env.CODEX_YOLO_SERVER ?? "yolo",
    model: options.model ?? env.CODEX_MODEL ?? null,
    cwd: options.cwd ?? yolo.cacheDir,
    timeoutSeconds: number(options.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
    memoryMinutes: number(options.memoryMinutes, DEFAULT_MEMORY_MINUTES),
    env,
    log: yolo.log,
  }));
}
