import { toYoloError, YoloError } from "@useyolo/core";

// The node's agent registry (Agent Note 2026-10-18-agent-from-the-screen).
// An agent plugin registers an agent that answers a screen's request in
// words, such as one the owner already runs on this machine. A screen may
// name the agent it asks; otherwise, or when that one is not loaded, the
// first registered agent that says it can answer does. One request runs at a
// time, and a new one stops the request still running, since the person
// changed their mind.

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
    ...(trimmed(value.profile, 40) ? { profile: trimmed(value.profile, 40) } : {}),
  };
}

// The other screens' sessions in use (Agent Note 2026-10-31-screen-sessions).
const MAX_OTHERS = 8;

// { text, device?: { id, name }, playing?, others?, language?, session?,
// agent? } as the control plane sends it. `playing` is what plays now on the
// asking screen, else on the owner's one screen in use (a control plane
// from before it sends none), and `others` what plays on the other screens
// in use; `agent` names the agent the
// screen chose. `session` comes with a conversation the control plane keeps:
// the agent session to continue, or null to start one. Without the key (a
// control plane from before conversations) the plugin keeps its own memory.
export function normalizeAgentRequest(input) {
  const text = trimmed(input?.text, MAX_AGENT_TEXT + 1);
  if (!text) throw new YoloError("invalid_request", "text is required");
  if (text.length > MAX_AGENT_TEXT) throw new YoloError("invalid_request", `text is longer than ${MAX_AGENT_TEXT} characters`);
  const device = screen(input?.device);
  const language = trimmed(input?.language, 35) || null;
  const request = { text, device, playing: playingNow(input?.playing), language };
  const others = (Array.isArray(input?.others) ? input.others : []).slice(0, MAX_OTHERS).map(playingNow).filter(Boolean);
  if (others.length) request.others = others;
  if (input && Object.hasOwn(input, "session")) request.session = trimmed(input.session, MAX_SESSION) || null;
  if (typeof input?.agent === "string" && AGENT_ID.test(input.agent)) request.agent = input.agent;
  return request;
}

export function createAgentRegistry() {
  const agents = new Map(); // id → { id, plugin, impl }, in registration order
  let running = null; // the AbortController of the request in progress

  // { available, reason? } of one agent, from its health().
  async function healthOf(entry) {
    try {
      const health = entry.impl.health ? { available: true, ...(await entry.impl.health()) } : { available: true };
      return { available: health.available !== false, ...(health.reason ? { reason: String(health.reason) } : {}) };
    } catch (error) {
      return { available: false, reason: toYoloError(error).message };
    }
  }

  // Every agent in registration order with its health, and the one a screen
  // that names none asks: the first available, else the first.
  async function survey() {
    const list = await Promise.all([...agents.values()].map(async (entry) => ({ entry, ...(await healthOf(entry)) })));
    return { list, fallback: list.find((agent) => agent.available) ?? list[0] ?? null };
  }

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

    // Whether a screen can ask: { available, id?, title?, reason?, agents },
    // the agent a screen that names none asks, and every agent a screen may
    // choose, { id, title, available, reason? }, in registration order.
    async status() {
      const { list, fallback } = await survey();
      if (!fallback) return { available: false, reason: "No agent plugin is loaded on this media node", agents: [] };
      const shown = ({ entry, available, reason }) => ({ id: entry.id, title: entry.impl.title ?? entry.id, available, ...(reason ? { reason } : {}) });
      const { id, title, available, reason } = shown(fallback);
      return { available, id, title, ...(reason ? { reason } : {}), agents: list.map(shown) };
    },

    // Runs one request; `emit` receives { type: "tool", name } and
    // { type: "text", text } while it runs. Resolves { text, agent, session },
    // the answer, the agent that gave it, and its session if it has one.
    // `input.agent` names the agent to ask, and the session, if any, is that
    // agent's: when another one answers instead, it starts its own.
    async ask(input, { emit = () => {}, signal } = {}) {
      const { agent: chosen = null, ...request } = normalizeAgentRequest(input);
      const entry = (chosen && agents.get(chosen)) || (await survey()).fallback?.entry || null;
      if (!entry) throw new YoloError("not_found", "No agent plugin is loaded on this media node");
      if (chosen && entry.id !== chosen && Object.hasOwn(request, "session")) request.session = null;
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
