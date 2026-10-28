import { YoloError } from "@useyolo/plugin-api";

// The `custom` source (Agent Note 2026-10-25-models-for-plugins): a server
// that speaks OpenAI's Chat Completions, such as Ollama, LM Studio, or a
// Magpie the owner runs. Its options: `url`, the API's base such as
// "http://127.0.0.1:11434/v1", and `model`, or `models` by purpose; a key,
// when the server wants one, in MODEL_CUSTOM_API_KEY.

/** The Chat Completions request for a model request. */
export function chatBody(request, model) {
  return {
    model,
    messages: [...(request.system ? [{ role: "system", content: request.system }] : []), ...request.messages],
    max_tokens: request.maxTokens,
    ...(request.schema ? { response_format: { type: "json_schema", json_schema: { name: "answer", schema: request.schema } } } : {}),
  };
}

export function createCustomSource({ env = process.env, options = {}, fetch = globalThis.fetch } = {}) {
  const base = typeof options.url === "string" ? options.url.replace(/\/+$/, "") : null;
  const key = env.MODEL_CUSTOM_API_KEY || null;
  const model = (purpose) => options.models?.[purpose] ?? options.models?.default ?? options.model ?? null;
  const headers = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };

  return {
    id: "custom",

    status() {
      if (!base) return { id: "custom", available: false, reason: "No custom model server is set (the plugin's custom.url)" };
      if (!model("default")) return { id: "custom", available: false, reason: "No model is named for the custom server (custom.model)" };
      return { id: "custom", available: true };
    },

    async models(signal) {
      if (!base) return [];
      const response = await fetch(`${base}/models`, { headers, signal });
      if (!response.ok) return model("default") ? [{ id: model("default"), source: "custom" }] : [];
      const { data = [] } = await response.json();
      return data.map((entry) => ({ id: entry.id, name: entry.id, source: "custom" }));
    },

    async complete(request) {
      if (!base) throw new YoloError("not_found", "No custom model server is set");
      const chosen = model(request.purpose);
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(chatBody(request, chosen)),
        signal: request.signal,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        throw new YoloError(response.status === 429 ? "rate_limited" : "resolve_failed", `The custom model server answered ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const answer = await response.json();
      return {
        text: answer.choices?.[0]?.message?.content ?? "",
        model: answer.model ?? chosen,
        source: "custom",
        usage: { input: answer.usage?.prompt_tokens ?? null, output: answer.usage?.completion_tokens ?? null },
      };
    },
  };
}
