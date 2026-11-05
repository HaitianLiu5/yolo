import { api } from "./api.js";
import { t } from "./i18n.js";

// Which of the node's agents this screen asks (Agent Note
// 2026-10-18-agent-from-the-screen). Each screen keeps its own choice, so the
// car can ask one agent while a phone asks another; without one, Yolo asks
// the first agent that can answer. What Yolo last said about its agents is
// kept here too, for Ask's button and the Settings row. Agents' names and
// what signs them in come from their plugins, never from this screen.

const KEY = "yolo.agent";
const listeners = new Set();
let status = null;

// The id this screen chose, or null for Yolo's choice.
export function chosenAgent(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function chooseAgent(id, storage = globalThis.localStorage) {
  try {
    if (id) storage?.setItem(KEY, id);
    else storage?.removeItem(KEY);
  } catch {
    // A private window: the choice lasts until the page reloads.
  }
  for (const listener of listeners) listener(status);
}

// What Yolo said last: { available, id?, title?, reason?, speech?, agents? }.
export const agentStatus = () => status;

export function onAgentStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadAgentStatus(read = () => api("/v1/agent", { timeoutMs: 8_000, retries: 0 })) {
  status = await read();
  for (const listener of listeners) listener(status);
  return status;
}

// The agent this screen asks now, { id, title, available, reason? }: its
// choice while Yolo still has it, else the one Yolo picks. A node from before
// choosing lists no agents, and only Yolo's pick is known.
export function askedAgent(current = status, chosen = chosenAgent()) {
  if (!current) return null;
  const agents = Array.isArray(current.agents) ? current.agents : [];
  const picked = chosen && agents.find((agent) => agent.id === chosen);
  if (picked) return picked;
  if (!current.title && !current.id) return null;
  return { id: current.id ?? null, title: current.title ?? current.id, available: Boolean(current.available), ...(current.reason ? { reason: current.reason } : {}) };
}

// Another agent that can answer now, for a screen whose agent lost its
// sign-in, or null.
export function otherAgent(id, current = status) {
  const agents = Array.isArray(current?.agents) ? current.agents : [];
  return agents.find((agent) => agent.id !== id && agent.available && !agent.signedOut) ?? null;
}

// What this screen says about an agent that lost its sign-in: { title,
// signIn? }. Only the owner, at a terminal on the node's machine, signs it in.
export function signedOutText({ title, signIn } = {}) {
  const agent = title || t("The agent");
  return signIn?.command
    ? t("{agent} needs signing in again. On the media node's machine, run: {command}", { agent, command: signIn.command })
    : t("{agent} needs signing in again on the media node's machine.", { agent });
}
