import { toYoloError, YoloError } from "@useyolo/core";

// The node's agent registry (Agent Note 2026-10-18-agent-from-the-screen).
// An agent plugin registers an agent that answers a screen's request in
// words, such as one the owner already runs on this machine. The first agent
// registered is the one screens ask; one request runs at a time, and a new
// one stops the request still running, since the person changed their mind.

const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const AGENT_METHODS = Object.freeze(["health", "ask"]);
// A request is something a person said or typed on a screen.
export const MAX_AGENT_TEXT = 1000;

export function checkAgentImpl(id, impl) {
  if (!AGENT_ID.test(String(id))) {
    throw new TypeError(`Agent id "${id}" must be lowercase letters, digits and dashes, starting with a letter`);
  }
  if (!impl || typeof impl !== "object") throw new TypeError(`Agent ${id} must be an object of methods`);
  if (typeof impl.ask !== "function") throw new TypeError(`Agent ${id}: ask must be a function`);
  if (impl.health !== undefined && typeof impl.health !== "function") throw new TypeError(`Agent ${id}: health must be a function`);
  if (impl.title !== undefined && typeof impl.title !== "string") throw new TypeError(`Agent ${id}: title must be a string`);
  return Object.keys(impl).filter((key) => !AGENT_METHODS.includes(key) && key !== "title");
}

const trimmed = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// A CLI's session id, as a plugin resolved it.
const MAX_SESSION = 200;

const screen = (value) => (value && typeof value === "object" && typeof value.id === "string" && value.id
  ? { id: value.id, name: trimmed(value.name, 100) || value.id }
  : null);

const seconds = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

// What plays now, as the control plane read it, or null.
function playingNow(value) {
  if (!value || typeof value !== "object") return null;
  const itemId = trimmed(value.itemId, 2000);
  if (!itemId) return null;
  return {
    itemId,
    title: trimmed(value.title, 300) || null,
    position: seconds(value.position) ?? 0,
    duration: seconds(value.duration),
    status: trimmed(value.status, 20) || null,
    device: screen(value.device),
  };
}

// { text, device?: { id, name }, playing?, language?, session? } as the
// control plane sends it. `playing` is what plays now and on which screen
// (a control plane from before it sends none). `session` comes with a
// conversation the control plane keeps: the agent session to continue, or
// null to start one. Without the key (a control plane from before
// conversations) the plugin keeps its own memory.
export function normalizeAgentRequest(input) {
  const text = trimmed(input?.text, MAX_AGENT_TEXT + 1);
  if (!text) throw new YoloError("invalid_request", "text is required");
  if (text.length > MAX_AGENT_TEXT) throw new YoloError("invalid_request", `text is longer than ${MAX_AGENT_TEXT} characters`);
  const device = screen(input?.device);
  const language = trimmed(input?.language, 35) || null;
  const request = { text, device, playing: playingNow(input?.playing), language };
  if (input && Object.hasOwn(input, "session")) request.session = trimmed(input.session, MAX_SESSION) || null;
  return request;
}

export function createAgentRegistry() {
  const agents = new Map(); // id → { id, plugin, impl }, in registration order
  let running = null; // the AbortController of the request in progress

  const first = () => agents.values().next().value ?? null;

  return {
    add(id, impl, plugin) {
      if (agents.has(id)) throw new Error(`Agent id "${id}" is already registered`);
      agents.set(id, { id, plugin, impl });
    },
    remove(id) {
      agents.delete(id);
    },
    has: (id) => agents.has(id),
    ids: () => [...agents.keys()],

    // Whether a screen can ask: { available, id?, title?, reason? }.
    async status() {
      const entry = first();
      if (!entry) return { available: false, reason: "No agent plugin is loaded on this media node" };
      let health = { available: true };
      try {
        if (entry.impl.health) health = { available: true, ...(await entry.impl.health()) };
      } catch (error) {
        health = { available: false, reason: toYoloError(error).message };
      }
      return {
        available: health.available !== false,
        id: entry.id,
        title: entry.impl.title ?? entry.id,
        ...(health.reason ? { reason: String(health.reason) } : {}),
      };
    },

    // Runs one request; `emit` receives { type: "tool", name } and
    // { type: "text", text } while it runs. Resolves { text, agent, session },
    // the answer, the agent that gave it, and its session if it has one.
    async ask(input, { emit = () => {}, signal } = {}) {
      const entry = first();
      if (!entry) throw new YoloError("not_found", "No agent plugin is loaded on this media node");
      const request = normalizeAgentRequest(input);
      const previous = running;
      const controller = new AbortController();
      let finish;
      running = { controller, done: new Promise((resolve) => { finish = resolve; }) };
      previous?.controller.abort(new YoloError("superseded", "A newer request replaced this one"));
      const stop = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", stop, { once: true });
      try {
        // The replaced request's agent stops before this one starts, so two
        // never play or queue at once.
        if (previous) await previous.done;
        if (controller.signal.aborted) throw toYoloError(controller.signal.reason);
        const result = await entry.impl.ask(request, { signal: controller.signal, emit });
        if (controller.signal.aborted) throw toYoloError(controller.signal.reason);
        return {
          text: typeof result?.text === "string" ? result.text : "",
          agent: entry.id,
          session: typeof result?.session === "string" && result.session ? result.session.slice(0, MAX_SESSION) : null,
        };
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason instanceof YoloError) throw controller.signal.reason;
        throw error;
      } finally {
        finish();
        signal?.removeEventListener("abort", stop);
        if (running?.controller === controller) running = null;
      }
    },
  };
}
