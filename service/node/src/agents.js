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

// { text, device?: { id, name }, language? } as the control plane sends it.
export function normalizeAgentRequest(input) {
  const text = trimmed(input?.text, MAX_AGENT_TEXT + 1);
  if (!text) throw new YoloError("invalid_request", "text is required");
  if (text.length > MAX_AGENT_TEXT) throw new YoloError("invalid_request", `text is longer than ${MAX_AGENT_TEXT} characters`);
  const device = input?.device && typeof input.device === "object" && typeof input.device.id === "string" && input.device.id
    ? { id: input.device.id, name: trimmed(input.device.name, 100) || input.device.id }
    : null;
  const language = trimmed(input?.language, 35) || null;
  return { text, device, language };
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
    // { type: "text", text } while it runs. Resolves { text }, the answer.
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
        return { text: typeof result?.text === "string" ? result.text : "" };
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
