import { YoloError } from "@useyolo/plugin-api";
import { createClaudeCodeSource } from "./claude-code.js";
import { createCodexSource } from "./codex.js";
import { createCustomSource } from "./custom.js";
import { createOwnSource } from "./own.js";

// The official model provider (Agent Note 2026-10-25-models-for-plugins).
// It gives other plugins a model on the owner's own subscription, out of the
// box where the node already runs a signed-in agent for Ask: it borrows
// Codex's sign-in first, then drives Claude Code, then uses Yolo's own
// sign-in or a custom server. Each request goes to the first source that is
// available, and on to the next when that one fails.
//
// Options (yolo.config.json):
//   sources      The order, or a subset, of "codex", "claude-code", "own",
//                and "custom"; [] turns every source off.
//   codex        { models: { default, <purpose> }, reasoning, command }
//   claudeCode   { models: { default, <purpose> }, command }
//   own          { models: { default, <purpose> } }
//   custom       { url, model or models }

export const SOURCE_IDS = Object.freeze(["codex", "claude-code", "own", "custom"]);
const OPTION_KEYS = Object.freeze({ codex: "codex", "claude-code": "claudeCode", own: "own", custom: "custom" });

export function createSubscriptionsProvider({ env = process.env, options = {}, stateDir = null, fetch = globalThis.fetch, run, now, log = console } = {}) {
  const order = Array.isArray(options.sources) ? options.sources : SOURCE_IDS;
  for (const id of order) if (!SOURCE_IDS.includes(id)) log.warn?.(`ignoring unknown model source "${id}"`);
  const sources = order.filter((id) => SOURCE_IDS.includes(id)).map((id) => {
    const settings = options[OPTION_KEYS[id]] ?? {};
    const common = { env, options: settings, ...(run ? { run } : {}), ...(now ? { now } : {}) };
    if (id === "codex") return createCodexSource({ ...common, fetch });
    if (id === "claude-code") return createClaudeCodeSource(common);
    if (id === "own") return createOwnSource({ stateDir, options: settings });
    return createCustomSource({ env, options: settings, fetch });
  });

  return {
    title: "Subscriptions",

    status() {
      const list = sources.map((source) => source.status());
      return {
        available: list.some((entry) => entry.available),
        ...(list.some((entry) => entry.available) ? {} : { reason: sources.length ? "No model source answers on this machine" : "Every model source is turned off" }),
        sources: list,
      };
    },

    async models() {
      const lists = await Promise.all(sources.filter((source) => source.status().available).map((source) => source.models().catch(() => [])));
      return lists.flat();
    },

    async complete(request) {
      let failure = null;
      for (const source of sources) {
        if (!source.status().available) continue;
        try {
          return await source.complete(request);
        } catch (error) {
          if (request.signal?.aborted) throw error;
          log.warn?.(`${source.id}: ${error.message}`);
          failure = error;
        }
      }
      throw failure ?? new YoloError("not_found", "No model source answers on this machine");
    },
  };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function modelSubscriptions(yolo) {
  yolo.registerModelProvider("subscriptions", createSubscriptionsProvider({
    env: yolo.env,
    options: yolo.options,
    stateDir: yolo.stateDir,
    log: yolo.log,
  }));
}
