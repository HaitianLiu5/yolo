import { YoloError } from "@useyolo/plugin-api";
import { claudePrompt } from "./claude-code.js";
import { createCredentialFile } from "./credentials.js";

// The `own` source (Agent Note 2026-10-25-models-for-plugins): Yolo's own
// sign-in through pi's model library, pi-ai, for a node with no signed-in
// agent. `npm run yolo -- models login` signs in (setup.js); the node then
// calls the model with that credential, which pi-ai refreshes under the
// credential file's lock. pi-ai is imported only when this source is used,
// so the plugin's other sources work without it.

// The subscriptions Yolo signs in to, in the order it offers them. Sign in
// with ChatGPT comes first: OpenAI documents plan usage for open-source and
// local projects. Claude subscriptions go through Claude Code instead.
export const OFFERED = Object.freeze(["openai", "github-copilot", "openrouter"]);
const FACTORIES = Object.freeze({ openai: "openaiProvider", "github-copilot": "githubCopilotProvider", openrouter: "openrouterProvider" });
// A model to prefer when the owner names none: a small one, since Yolo's
// purposes are short, structured answers.
const SMALL = /(^|[-.])(mini|nano|haiku|flash|small|lite)([-.]|$)/i;

/** pi-ai's Models collection with the offered providers, over `credentials`. */
export async function piModels(credentials, { load = (id) => import(`@earendil-works/pi-ai/providers/${id}`), core = () => import("@earendil-works/pi-ai") } = {}) {
  const { createModels } = await core();
  const models = createModels({ credentials, identity: { userAgent: { custom: "yolo" } } });
  for (const id of OFFERED) models.setProvider((await load(id))[FACTORIES[id]]());
  return models;
}

function pickModel(list, named) {
  if (named) return list.find((model) => model.id === named) ?? null;
  return list.find((model) => SMALL.test(model.id)) ?? list[0] ?? null;
}

export function createOwnSource({ stateDir, options = {}, loadModels = piModels } = {}) {
  const credentials = stateDir ? createCredentialFile(stateDir) : null;
  let collection = null;
  const signedIn = () => (credentials ? OFFERED.filter((id) => credentials.providers().includes(id)) : []);

  return {
    id: "own",

    status() {
      if (!credentials) return { id: "own", available: false, reason: "The plugin has no state directory" };
      if (!signedIn().length) return { id: "own", available: false, reason: "Yolo has no model sign-in of its own: npm run yolo -- models login" };
      return { id: "own", available: true };
    },

    async models() {
      const providers = signedIn();
      if (!providers.length) return [];
      collection ??= await loadModels(credentials);
      return providers.flatMap((provider) => collection.getModels(provider).map((model) => ({ id: `${provider}/${model.id}`, name: model.name, source: "own" })));
    },

    async complete(request) {
      const [provider] = signedIn();
      if (!provider) throw new YoloError("not_found", "Yolo has no model sign-in of its own");
      collection ??= await loadModels(credentials);
      const named = String(options.models?.[request.purpose] ?? options.models?.default ?? "").replace(`${provider}/`, "") || null;
      const model = pickModel(collection.getModels(provider), named);
      if (!model) throw new YoloError("resolve_failed", `${provider} has no model ${named ?? "to use"}`);
      const system = [
        request.system,
        request.schema ? `Answer with only JSON that fits this JSON Schema:\n${JSON.stringify(request.schema)}` : null,
      ].filter(Boolean).join("\n\n");
      const answer = await collection.completeSimple(model, {
        ...(system ? { systemPrompt: system } : {}),
        messages: [{ role: "user", content: claudePrompt(request.messages), timestamp: Date.now() }],
      }, {
        signal: request.signal,
        maxTokens: request.maxTokens,
        ...(model.reasoning ? { reasoning: "low" } : {}),
      });
      if (answer.stopReason === "error" || answer.stopReason === "aborted") {
        throw new YoloError("resolve_failed", `${provider}: ${answer.errorMessage || answer.stopReason}`);
      }
      return {
        text: answer.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
        model: `${provider}/${answer.responseModel ?? model.id}`,
        source: "own",
        usage: { input: answer.usage?.input ?? null, output: answer.usage?.output ?? null },
      };
    },
  };
}
