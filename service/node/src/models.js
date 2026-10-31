import { YoloError } from "@useyolo/core";

// The node's language model (Agent Note 2026-10-25-models-for-plugins). A
// model provider plugin answers requests on the owner's own subscription;
// every other plugin calls it as `yolo.models`, naming what the answer is for,
// never a provider or a model. The node keeps the limits: two requests at a
// time, 60 seconds each, and a daily number of calls per plugin. It logs each
// call's plugin, purpose, source, model, tokens, and time, never its content.

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PURPOSE = /^[a-z][a-z0-9-]{0,31}$/;
const PROVIDER_FIELDS = Object.freeze(["title", "complete", "models", "status"]);
const MAX_CONCURRENT = 2;
const TIMEOUT_MS = 60_000;
export const DEFAULT_CALLS_PER_DAY = 500;
const DEFAULT_MAX_TOKENS = 1000;
const MAX_TOKENS = 8000;
const MAX_MESSAGES = 50;
const MAX_CONTENT = 100_000;

export function checkModelProviderImpl(id, impl) {
  if (!PROVIDER_ID.test(String(id))) {
    throw new TypeError(`Model provider id "${id}" must be lowercase letters, digits and dashes, starting with a letter`);
  }
  if (!impl || typeof impl !== "object") throw new TypeError(`Model provider ${id} must be an object of methods`);
  if (typeof impl.complete !== "function") throw new TypeError(`Model provider ${id}: complete must be a function`);
  for (const method of ["models", "status"]) {
    if (impl[method] !== undefined && typeof impl[method] !== "function") throw new TypeError(`Model provider ${id}: ${method} must be a function`);
  }
  if (impl.title !== undefined && typeof impl.title !== "string") throw new TypeError(`Model provider ${id}: title must be a string`);
  return Object.keys(impl).filter((key) => !PROVIDER_FIELDS.includes(key));
}

const typeOf = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

/**
 * Null when `value` fits `schema`, else where and how it does not. Covers
 * the JSON Schema that plugins give models: types, enum, const, required,
 * properties, additionalProperties, items, minimum, maximum, the string and
 * array lengths, and anyOf.
 */
export function schemaError(value, schema, at = "answer") {
  if (!schema || typeof schema !== "object" || schema === true) return null;
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((option) => !schemaError(value, option, at))) return `${at} fits none of its choices`;
  }
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const types = [schema.type].flat();
    const fits = types.includes(actual) || (actual === "integer" && types.includes("number"));
    if (!fits) return `${at} is ${actual}, not ${types.join(" or ")}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    return `${at} is not one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`;
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) return `${at} is not ${JSON.stringify(schema.const)}`;
  if (actual === "integer" || actual === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return `${at} is below ${schema.minimum}`;
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return `${at} is above ${schema.maximum}`;
  }
  if (actual === "string") {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) return `${at} is shorter than ${schema.minLength}`;
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) return `${at} is longer than ${schema.maxLength}`;
  }
  if (actual === "array") {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) return `${at} has fewer than ${schema.minItems} items`;
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) return `${at} has more than ${schema.maxItems} items`;
    for (const [index, item] of value.entries()) {
      const error = schemaError(item, schema.items, `${at}[${index}]`);
      if (error) return error;
    }
  }
  if (actual === "object") {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return `${at} has no ${key}`;
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      const property = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties;
      if (property === false) return `${at} has an unexpected ${key}`;
      const error = schemaError(item, property, `${at}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

/** The JSON in a model's answer: the text itself, or a fenced block in it. */
export function parseAnswer(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    throw new YoloError("resolve_failed", "The model's answer is not JSON");
  }
}

// The request as a provider gets it, checked.
function normalizeRequest(request) {
  if (!request || typeof request !== "object") throw new YoloError("invalid_request", "A model request must be an object");
  const purpose = String(request.purpose ?? "");
  if (!PURPOSE.test(purpose)) throw new YoloError("invalid_request", "A model request needs a purpose: lowercase letters, digits and dashes");
  if (request.system !== undefined && typeof request.system !== "string") throw new YoloError("invalid_request", "system must be a string");
  const messages = request.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) {
    throw new YoloError("invalid_request", `A model request needs 1 to ${MAX_MESSAGES} messages`);
  }
  let length = (request.system ?? "").length;
  const checked = messages.map((message) => {
    if (message?.role !== "user" && message?.role !== "assistant") throw new YoloError("invalid_request", "A message's role is user or assistant");
    if (typeof message.content !== "string" || !message.content) throw new YoloError("invalid_request", "A message's content is a string");
    length += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (checked.at(-1).role !== "user") throw new YoloError("invalid_request", "The last message is the user's");
  if (length > MAX_CONTENT) throw new YoloError("invalid_request", `A model request is longer than ${MAX_CONTENT} characters`);
  if (request.schema !== undefined && (!request.schema || typeof request.schema !== "object")) {
    throw new YoloError("invalid_request", "schema must be a JSON Schema object");
  }
  const maxTokens = request.maxTokens === undefined ? DEFAULT_MAX_TOKENS : Number(request.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS) {
    throw new YoloError("invalid_request", `maxTokens is a whole number from 1 to ${MAX_TOKENS}`);
  }
  return {
    purpose,
    ...(request.system ? { system: request.system } : {}),
    messages: checked,
    ...(request.schema ? { schema: request.schema } : {}),
    maxTokens,
  };
}

const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
const message = (error) => error?.message || String(error);

// A provider's status, which never throws.
async function statusOf(entry) {
  try {
    const status = entry.impl.status ? await entry.impl.status() : { available: true };
    return {
      available: status?.available !== false,
      ...(status?.reason ? { reason: String(status.reason) } : {}),
      ...(Array.isArray(status?.sources) ? { sources: status.sources } : {}),
    };
  } catch (error) {
    return { available: false, reason: message(error) };
  }
}

/**
 * The registry of model providers and the limits of their calls. `forPlugin`
 * gives each plugin its `yolo.models`, counted against its own daily calls.
 */
export function createModelRegistry({
  logger = console,
  maxConcurrent = MAX_CONCURRENT,
  timeoutMs = TIMEOUT_MS,
  callsPerDay = DEFAULT_CALLS_PER_DAY,
  now = Date.now,
} = {}) {
  const providers = new Map(); // id → { id, plugin, impl }, in registration order
  const calls = new Map(); // plugin → calls today
  let day = null;
  let running = 0;
  const waiting = [];

  // The first provider that says it can answer, with its status.
  async function choose() {
    for (const entry of providers.values()) {
      const status = await statusOf(entry);
      if (status.available) return { entry, status };
    }
    return null;
  }

  function today() {
    const date = new Date(now());
    const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    if (key !== day) {
      day = key;
      calls.clear();
    }
    return calls;
  }

  async function slot(signal) {
    if (running < maxConcurrent) {
      running += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiting.push(waiter);
      signal?.addEventListener("abort", () => {
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason ?? new YoloError("resolve_failed", "The model request was aborted"));
      }, { once: true });
    });
  }

  function release() {
    const next = waiting.shift();
    if (next) next.resolve();
    else running -= 1;
  }

  async function complete(plugin, input) {
    const request = normalizeRequest(input);
    const used = today().get(plugin) ?? 0;
    if (used >= callsPerDay) {
      throw new YoloError("rate_limited", `${plugin} made its ${callsPerDay} model calls for today`);
    }
    const chosen = await choose();
    if (!chosen) throw new YoloError("not_found", "No model is available on this media node");
    calls.set(plugin, used + 1);

    const controller = new AbortController();
    const outer = input.signal;
    const abort = () => controller.abort(outer.reason);
    if (outer?.aborted) abort();
    outer?.addEventListener("abort", abort, { once: true });
    const started = now();
    let timer = null;
    try {
      await slot(controller.signal);
      timer = setTimeout(() => controller.abort(new YoloError("resolve_failed", `The model took longer than ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      let answer;
      try {
        answer = await chosen.entry.impl.complete({ ...request, signal: controller.signal });
      } finally {
        release();
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      const text = typeof answer?.text === "string" ? answer.text : "";
      const result = {
        text,
        model: typeof answer?.model === "string" ? answer.model : null,
        source: typeof answer?.source === "string" ? answer.source : null,
        usage: { input: count(answer?.usage?.input), output: count(answer?.usage?.output) },
      };
      if (request.schema) {
        const json = answer?.json !== undefined ? answer.json : parseAnswer(text);
        const error = schemaError(json, request.schema);
        if (error) throw new YoloError("resolve_failed", `The model's answer does not fit the schema: ${error}`);
        result.json = json;
      }
      logger.info?.(`[models] ${plugin} ${request.purpose}: ${chosen.entry.id}/${result.source ?? "-"} ${result.model ?? "-"}, ${result.usage.input ?? "?"}+${result.usage.output ?? "?"} tokens, ${now() - started} ms`);
      return Object.freeze(result);
    } catch (error) {
      const reason = controller.signal.aborted && controller.signal.reason instanceof YoloError ? controller.signal.reason : error;
      logger.warn?.(`[models] ${plugin} ${request.purpose}: ${chosen.entry.id} failed after ${now() - started} ms: ${message(reason)}`);
      if (reason instanceof YoloError) throw reason;
      throw new YoloError("resolve_failed", `The model failed: ${message(reason)}`, { cause: reason });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", abort);
    }
  }

  return {
    add(id, impl, plugin) {
      if (providers.has(id)) throw new Error(`Model provider id "${id}" is already registered`);
      providers.set(id, { id, plugin, impl });
    },
    remove(id) {
      providers.delete(id);
    },
    has: (id) => providers.has(id),
    ids: () => [...providers.keys()],

    /** The `yolo.models` of the plugin named `plugin`. */
    forPlugin(plugin) {
      return Object.freeze({
        available: async () => (today().get(plugin) ?? 0) < callsPerDay && Boolean(await choose()),
        complete: (request) => complete(plugin, request),
      });
    },

    /**
     * Every provider with its status, the one in use, and today's calls per
     * plugin, for /internal/v1/health and yolo doctor.
     */
    async status() {
      const list = [];
      for (const entry of providers.values()) {
        list.push({ id: entry.id, plugin: entry.plugin, ...(entry.impl.title ? { title: entry.impl.title } : {}), ...(await statusOf(entry)) });
      }
      return {
        provider: list.find((entry) => entry.available)?.id ?? null,
        providers: list,
        callsPerDay,
        calls: Object.fromEntries(today()),
      };
    },
  };
}
