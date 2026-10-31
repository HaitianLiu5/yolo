import { readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { YoloError } from "@useyolo/plugin-api";
import { childEnv, findCommand, runCommand } from "./command.js";

// The `codex` source (Agent Note 2026-10-25-models-for-plugins): Codex's
// sign-in, borrowed read-only. It reads auth.json in Codex's home and sends
// each request with its access token to the Responses endpoint Codex itself
// uses; that token does not work on OpenAI's public API. It never writes
// the file and never refreshes the token, since a refresh rotates the
// refresh token and a second refresher would sign Codex out. When the token
// has expired or is refused, it runs Codex once so Codex renews its own
// sign-in, then reads the file again.

export const ENDPOINT = "https://chatgpt.com/backend-api/codex";
// The models list wants a client version; any recent one is accepted.
const CLIENT_VERSION = "1.0.0";
const RENEW_EVERY_MS = 10 * 60_000;
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_INSTRUCTIONS = "Answer the request.";

export const codexHome = (env) => env.CODEX_HOME || join(env.HOME || homedir(), ".codex");

// When a JWT expires, in milliseconds, or null.
function expiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Codex's ChatGPT sign-in from auth.json: { token, accountId, expires }, or null. */
export function parseCodexAuth(text) {
  let auth;
  try {
    auth = JSON.parse(text);
  } catch {
    return null;
  }
  const token = auth?.tokens?.access_token;
  if (typeof token !== "string" || !token) return null;
  const accountId = typeof auth.tokens.account_id === "string" ? auth.tokens.account_id : null;
  return { token, accountId, expires: expiry(token) };
}

/** The model Codex is set to use, from the top of config.toml, or null. */
export function parseCodexModel(text) {
  for (const line of String(text).split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*model\s*=\s*"([^"]+)"/.exec(line);
    if (match) return match[1];
  }
  return null;
}

// Strict structured output needs every object closed and every property
// required; other schemas go as a hint the node checks the answer against.
function strictable(schema) {
  if (!schema || typeof schema !== "object") return true;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.every(strictable);
  const types = [schema.type].flat();
  if (types.includes("object")) {
    const keys = Object.keys(schema.properties ?? {});
    if (schema.additionalProperties !== false || keys.some((key) => !(schema.required ?? []).includes(key))) return false;
    if (!Object.values(schema.properties ?? {}).every(strictable)) return false;
  }
  if (types.includes("array") && !strictable(schema.items)) return false;
  return true;
}

/** The Responses request for a model request. */
export function responsesBody(request, model, { reasoning = "low" } = {}) {
  return {
    model,
    instructions: request.system || DEFAULT_INSTRUCTIONS,
    input: request.messages.map(({ role, content }) => ({
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text: content }],
    })),
    ...(request.schema ? { text: { format: { type: "json_schema", name: "answer", schema: request.schema, strict: strictable(request.schema) } } } : {}),
    ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
    store: false,
    stream: true,
  };
}

/** The finished response in a Responses event stream: { text, model, usage }. */
export function readResponseStream(body) {
  let completed = null;
  for (const line of String(body).split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (event.type === "response.completed") completed = event.response;
    if (event.type === "response.failed" || event.type === "error") {
      const reason = event.response?.error?.message || event.message || event.error?.message || "the request failed";
      throw new YoloError("resolve_failed", `Codex's model service: ${reason}`);
    }
  }
  if (!completed) throw new YoloError("resolve_failed", "Codex's model service ended without an answer");
  const text = (completed.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");
  return { text, model: completed.model ?? null, usage: { input: completed.usage?.input_tokens ?? null, output: completed.usage?.output_tokens ?? null } };
}

export function createCodexSource({ env = process.env, options = {}, fetch = globalThis.fetch, run = runCommand, now = Date.now } = {}) {
  const home = codexHome(env);
  const file = join(home, "auth.json");
  let read = { mtime: null, auth: null };
  let renewed = 0;

  // The sign-in as the file holds it now, read again only when it changed.
  function auth() {
    let mtime;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      read = { mtime: null, auth: null };
      return null;
    }
    if (mtime !== read.mtime) {
      try {
        read = { mtime, auth: parseCodexAuth(readFileSync(file, "utf8")) };
      } catch {
        read = { mtime: null, auth: null };
      }
    }
    return read.auth;
  }

  const command = () => findCommand(options.command ?? env.CODEX_COMMAND ?? "codex", { env });
  const expired = (signIn) => signIn.expires !== null && signIn.expires - now() < EXPIRY_MARGIN_MS;

  // Codex renews its own sign-in when it runs; at most once in ten minutes.
  async function renew(signal) {
    const binary = command();
    if (!binary) throw new YoloError("resolve_failed", "Codex's sign-in has expired and the codex command is not on this machine to renew it");
    if (now() - renewed < RENEW_EVERY_MS) throw new YoloError("resolve_failed", "Codex's sign-in has expired: run codex login on the media node's machine");
    renewed = now();
    const { code } = await run(binary, ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "Reply with OK."], { env: childEnv(env), cwd: tmpdir(), signal });
    const signIn = auth();
    if (code !== 0 || !signIn || expired(signIn)) throw new YoloError("resolve_failed", "Codex's sign-in has expired: run codex login on the media node's machine");
    return signIn;
  }

  const headers = (signIn) => ({
    authorization: `Bearer ${signIn.token}`,
    ...(signIn.accountId ? { "chatgpt-account-id": signIn.accountId } : {}),
    "user-agent": "yolo",
  });

  async function model(purpose) {
    const models = options.models ?? {};
    const named = models[purpose] ?? models.default;
    if (named) return named;
    try {
      const configured = parseCodexModel(readFileSync(join(home, "config.toml"), "utf8"));
      if (configured) return configured;
    } catch {}
    const listed = await list();
    if (!listed.length) throw new YoloError("resolve_failed", "Codex's model service lists no models");
    return listed[0].id;
  }

  async function list(signal) {
    let signIn = auth();
    if (!signIn) return [];
    if (expired(signIn)) signIn = await renew(signal);
    const response = await fetch(`${ENDPOINT}/models?client_version=${CLIENT_VERSION}`, { headers: headers(signIn), signal });
    if (!response.ok) throw new YoloError("resolve_failed", `Codex's model service answered ${response.status} for its models`);
    const { models = [] } = await response.json();
    return models
      .filter((entry) => entry.visibility !== "hide")
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((entry) => ({ id: entry.slug, name: entry.display_name ?? entry.slug, source: "codex" }));
  }

  return {
    id: "codex",

    status() {
      const signIn = auth();
      if (!signIn) return { id: "codex", available: false, reason: `Codex is not signed in with ChatGPT on this machine (${file})` };
      if (expired(signIn) && !command()) return { id: "codex", available: false, reason: "Codex's sign-in has expired: run codex login" };
      return { id: "codex", available: true };
    },

    models: list,

    async complete(request) {
      const { signal } = request;
      let signIn = auth();
      if (!signIn) throw new YoloError("not_found", "Codex is not signed in with ChatGPT on this machine");
      if (expired(signIn)) signIn = await renew(signal);
      const chosen = await model(request.purpose);
      const body = JSON.stringify(responsesBody(request, chosen, { reasoning: options.reasoning ?? "low" }));
      const send = (current) => fetch(`${ENDPOINT}/responses`, {
        method: "POST",
        headers: { ...headers(current), "content-type": "application/json", accept: "text/event-stream" },
        body,
        signal,
      });
      let response = await send(signIn);
      if (response.status === 401) response = await send(await renew(signal));
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        throw new YoloError(response.status === 429 ? "rate_limited" : "resolve_failed", `Codex's model service answered ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const answer = readResponseStream(await response.text());
      return { ...answer, model: answer.model ?? chosen, source: "codex" };
    },
  };
}
