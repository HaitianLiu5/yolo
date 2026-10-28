# Agent Note: Plugins call models on the owner's own subscription

Status: implemented

English | [中文](2026-10-25-models-for-plugins.zh.md)

## Problem

Several plugins want a language model: a metadata plugin that must recognize which episode a web upload is ([metadata plugins](2026-10-25-metadata-plugins.md)), a translator for AI subtitles ([AI subtitles](../feature/2026-10-18-ai-subtitles.md)), and later ones. Without a shared capability each brings its own model client, its own key, and its own option names; `subtitles-openai` does, with a URL and an API key for a server the owner runs.

Most owners already pay for a model through a subscription (ChatGPT Plus or Pro, Claude Pro or Max, GitHub Copilot), not through API keys, and many have already signed in to it on the node's machine: Ask runs the owner's Codex or Claude Code there, signed in with that subscription ([screens ask the owner's own agent](../feature/2026-10-18-agent-from-the-screen.md)). Local gateways such as Magpie show what owners expect: Magpie serves every agent on a machine through one address, with no sign-in of its own, by using the sign-ins Codex and Claude Code already hold. Without a way to use any of this, an AI feature in Yolo means a separate API key and a separate bill, or nothing.

## Decision

The media node has a **model** capability ([`service/node/src/models.js`](../../../../service/node/src/models.js)). Plugins call it as `yolo.models`; a **model provider plugin** supplies it. The official one, `@useyolo/model-subscriptions`, works out of the box the way Magpie does: it **borrows the sign-in of an agent already on the node**, Codex's first and Claude Code's next, so an owner whose node runs Ask needs no step at all. Unlike Magpie, it borrows without taking over: it never writes, refreshes, or copies another app's credential. Yolo's own sign-in, through pi's model library, and a custom server are the fallback for a node with no signed-in agent. Yolo does not depend on Magpie.

### What plugins get

Every node entry's API has `yolo.models`, a `ModelClient` ([`service/plugin-api/src/index.js`](../../../../service/plugin-api/src/index.js)). `available()` resolves false when no provider can answer or the plugin has made its calls for the day, and `complete()` then throws `not_found` or `rate_limited`, so every AI feature is optional and takes its path without a model.

```js
if (await yolo.models.available()) {
  const answer = await yolo.models.complete({
    purpose: "identify",            // what the answer is for; the provider picks the model
    system: "Identify the film or TV episode this video is a copy of.",
    messages: [{ role: "user", content: JSON.stringify(facts) }],
    schema: IDENTITY_SCHEMA,        // a JSON Schema: the answer is parsed and checked against it
    maxTokens: 400,
  });
  // → { json, text, model: "gpt-…", source: "codex", usage: { input, output } }
}
```

- **One call shape for every provider and source.** A plugin names a `purpose` (`[a-z][a-z0-9-]{0,31}`), never a provider, source, or model, so it works with whatever the node has. A request has 1 to 50 messages, the last the user's, at most 100,000 characters with the system prompt, and `maxTokens` from 1 to 8,000 (1,000 by default). With `schema`, the node parses the answer and checks it against the schema (types, `enum`, `const`, `required`, `properties`, `additionalProperties`, `items`, the bounds and lengths, and `anyOf`); a reply that does not fit throws `resolve_failed`.
- **Text only, no tools.** `complete` sends messages and gets one answer: no tool calls, no browsing, no files. A plugin gives the model what it needs to know in the messages. This keeps a call bounded in time and cost, and keeps plugins from turning the node into an agent.
- **The node keeps the limits.** Calls run at most two at a time, each with a 60-second timeout, under a daily number of calls per calling plugin, `MODEL_CALLS_PER_DAY` (500 by default). The node's own identification of items counts as the plugin `metadata`. A plugin over its number gets `rate_limited` until the next day. The node logs each call's plugin, purpose, provider and source, model, tokens, and time, never its content.

### Model provider plugins

A plugin registers a provider with `yolo.registerModelProvider(id, impl)`; the node uses the first provider in load order whose `status()` says it is available.

| Method | Purpose |
|---|---|
| `complete(request)` | Run one request, with the `signal` the node aborts after 60 seconds, on the model the provider chooses for its purpose; resolve with `{ text, json?, model?, source?, usage? }` |
| `models()` | Optional: the models its sources can use, `[{ id, name, source }]` |
| `status()` | Optional: `{ available, reason?, sources? }`, without secrets, for `/internal/v1/health` and `yolo doctor`; a provider without it counts as available |

`/internal/v1/health` reports `models`: `{ provider, providers, callsPerDay, calls }`, the provider in use, each provider with its status, and today's calls per plugin ([node's internal API](2026-10-07-node-internal-api.md)). `yolo doctor` shows it as `node.models`: `ok` with the day's calls, or `info` when no model answers, never a failure.

A provider's own sign-in runs from a `setup` entry, as a DNS provider's does ([DNS provider plugins](2026-10-14-dns-provider-plugins.md)): the operator's command line finds the enabled plugin whose setup entry sets up `models` ([`ops/lib/setup-entry.js`](../../../../ops/lib/setup-entry.js)) and imports it on the node's machine ([`ops/commands/models.js`](../../../../ops/commands/models.js)).

```bash
npm run yolo -- models status                  # each source and whether it answers; the node's provider and today's calls
npm run yolo -- models login [subscription]    # Yolo's own sign-in, for a node with no signed-in agent
npm run yolo -- models logout <subscription>
```

`models login` needs the owner at a terminal on the node's machine (an SSH session works); without one it stops with `needs_human`. The node reads a new sign-in on its next call, with no restart.

The core names no model vendor or agent: they appear only in the provider plugin, its dependency, and the owner's config. `scripts/provider-names.js` lists `model-subscriptions` among the plugin directories that name no provider, since it serves whichever vendor the owner's subscription is with.

### The official provider

`@useyolo/model-subscriptions` ([`plugins/model-subscriptions`](../../../../plugins/model-subscriptions/src/node.js)) is in the default load list and registers the provider `subscriptions`. A request goes to the first source that is available, and on to the next when that one fails. The default order is `codex`, `claude-code`, `own`, `custom`; the `sources` option reorders or limits them, and `[]` turns every source off.

| Source | How it calls | Setup | Measured |
|---|---|---|---|
| `codex`: Codex's sign-in, borrowed | Reads Codex's credential and calls the Responses endpoint Codex itself uses | None when Codex is signed in | About 10 s and 252 tokens on the owner's laptop on 2026-10-26; 4.8 s and 174 tokens in an earlier probe |
| `claude-code`: Claude Code, driven | Runs `claude -p` with no tools, the schema, and the prompt on stdin | None when Claude Code is signed in | 4 to 10 s, about 1,400 input tokens |
| `own`: Yolo's own sign-in | pi's model library with the credential `models login` stored | `npm run yolo -- models login` | Depends on the subscription |
| `custom`: a server the owner runs | OpenAI's Chat Completions: Ollama, LM Studio, a Magpie the owner runs | `custom.url` and `custom.model` | Depends on the server |

The measured figures are identifications of a Bilibili upload of *Nathan for You* S01E08. Every answer named the show, season, and episode correctly; Claude Code's Haiku once made up the episode's title, which is why the node confirms a model's answer against records before it describes an item.

**Borrowing Codex's sign-in, read-only.** The `codex` source ([`codex.js`](../../../../plugins/model-subscriptions/src/codex.js)) reads `auth.json` in Codex's home (`$CODEX_HOME`, else `~/.codex`) again whenever its modification time changes, and sends each request with its access token and `ChatGPT-Account-Id` straight to `https://chatgpt.com/backend-api/codex/responses` with `fetch`, streamed, with `store: false` and low reasoning effort. That token does not work on OpenAI's public API, which is why this source calls Codex's endpoint. The model is the one the plugin's `codex.models` names for the purpose, else the top-level `model` of Codex's `config.toml`, else the first model Codex's model list gives. The plugin never writes the file and never refreshes the token: a refresh rotates the refresh token, so a second refresher would sign Codex out, as Magpie risks by refreshing it itself. When the token is within 60 seconds of expiry or a request gets 401, the plugin runs `codex exec --skip-git-repo-check --ephemeral --sandbox read-only "Reply with OK."` with stdin closed, at most once in ten minutes, so Codex renews its own sign-in by its own rules, then reads the file again. If Codex cannot renew it, the source fails with "run codex login on the media node's machine" and the next source answers.

**Driving Claude Code, not borrowing its token.** Claude Code keeps its credential in the Keychain, and Anthropic has restricted the use of subscription credentials outside Claude Code before, so the plugin does not read it. The `claude-code` source ([`claude-code.js`](../../../../plugins/model-subscriptions/src/claude-code.js)) runs the `claude` command Ask already runs, as `claude -p --model <model> --tools "" --strict-mcp-config --no-session-persistence --output-format json --system-prompt <system> [--json-schema <schema>]` in the temporary directory, with the prompt on stdin, and reads the answer's `structured_output`. The model is the one `claudeCode.models` names, else `haiku`. That is Claude Code itself answering, under Claude Code's own terms, wherever Claude Code can read its sign-in: in the node's service, where Ask runs it. A plain SSH shell may not reach the Keychain, as on the owner's Mac mini, where it answered "Not logged in"; after that answer the source is unavailable for ten minutes. The source costs Claude Code's own prompt on every call, so it comes after Codex.

**Yolo's own sign-in, through pi's model library.** For a node with no signed-in agent, `npm run yolo -- models login` signs in through `@earendil-works/pi-ai` 1.4.0 (MIT), the model library of pi, whose extension model Yolo's plugins already follow ([plugin architecture](2026-10-11-plugin-architecture.md)). It offers OpenAI's Sign in with ChatGPT first, because OpenAI documents plan usage for open-source projects and personal projects that run locally, which a Yolo node is; then GitHub Copilot and OpenRouter. It does not offer Anthropic's sign-in: Claude subscriptions go through the `claude-code` source. The `own` source ([`own.js`](../../../../plugins/model-subscriptions/src/own.js)) puts the schema in the system prompt, and the node checks the answer.

- **No browser is needed on the node's machine.** pi-ai's sign-in prints the authorization URL and also accepts the redirected address pasted into the terminal, racing its own callback server on `127.0.0.1`. The owner signs in on a phone or laptop and pastes the `127.0.0.1` address the browser could not open.
- **The credential stays on the node,** in `credentials.json`, mode 0600, in the plugin's `stateDir` (`<runtime dir>/.yolo/plugins/useyolo-model-subscriptions/`, ignored by Git and never deleted by Yolo, unlike `cacheDir`). Every write is a read-modify-write under the lock file `credentials.lock` beside it, so the node and `models login` never refresh or write over each other. This credential is Yolo's own, so refreshing it signs nothing else out.
- **Only this source needs Node.js 22.19,** pi-ai's minimum. The plugin imports pi-ai only when the `own` source is used, so its `engines` stays at Yolo's 22.12, and the other sources work on any Node.js Yolo runs on.

**A custom server.** The `custom` source ([`custom.js`](../../../../plugins/model-subscriptions/src/custom.js)) calls an OpenAI Chat Completions server at `custom.url` with `custom.model`, or `custom.models` by purpose, and the key in `MODEL_CUSTOM_API_KEY` when the server wants one.

### Choosing models

Each source takes its own options, mapping purposes to models with a default for purposes they do not name:

```json
{
  "source": "./plugins/model-subscriptions",
  "options": {
    "sources": ["codex", "claude-code", "own", "custom"],
    "codex": { "models": { "default": "<model>" }, "reasoning": "low", "command": "codex" },
    "claudeCode": { "models": { "default": "haiku" }, "command": "claude" },
    "own": { "models": { "default": "<provider>/<model>" } },
    "custom": { "url": "http://127.0.0.1:11434/v1", "model": "qwen3:8b" }
  }
}
```

Without a named model, `codex` uses Codex's own, `claude-code` uses Haiku, and `own` picks a small model the subscription offers (a `mini`, `nano`, `haiku`, `flash`, `small`, or `lite` one), since the purposes Yolo has are short, structured answers. `codex.command` and `claudeCode.command` fall back to `CODEX_COMMAND` and `CLAUDE_CODE_COMMAND`, as the agent plugins' do.

### Privacy

A call sends what the plugin puts in its messages to the model's vendor, under the owner's own account: for metadata, an item's title, description, uploader, site, duration, date, and file name, and the titles of the other parts of the same upload, never the media or the owner's history. Borrowing is on by default, so a node whose Codex or Claude Code is signed in sends these without a further step; this is the same account and vendor Ask already sends the owner's requests to. The privacy policy (`site/public/privacy.html` and `site/public/zh/privacy.html`) and the `yolo-deploy` skill say so, `"sources": []` turns every source off, and leaving the plugin out of the load list removes the capability.

## Alternatives considered

**Only Yolo's own sign-in.** An earlier draft of this note had the owner sign in for Yolo with `models login` before any AI feature worked. It is the documented route and stays as the fallback, but it asks every owner for a step when most nodes already hold a signed-in agent for Ask.

**Call Codex's endpoint through pi-ai.** pi-ai has a Codex API, but routing the `codex` source through it would make every owner's model calls load pi-ai and its vendors' SDKs, and need Node.js 22.19, for one HTTP request with a bearer token. The source calls the endpoint with `fetch`; pi-ai loads only for Yolo's own sign-in.

**Refresh borrowed tokens, as Magpie does.** Magpie reads Codex's `auth.json` and Claude Code's Keychain entry and refreshes their tokens itself. A refresh rotates the refresh token, so Yolo refreshing Codex's credential can sign Codex out, and the owner's Ask with it. Yolo reads only, and lets Codex refresh.

**Read Claude Code's token and call Anthropic's API.** It would be as fast as the `codex` source, but Anthropic has restricted subscription credentials to its own apps before, and the Keychain is not reachable from every process. Running `claude` keeps the call inside Claude Code. For the same reason the `own` source offers no Anthropic sign-in.

**Drive `codex exec` for every call.** It worked on the owner's Mac mini, right in 12 seconds, but Codex's agent prompt made one identification cost 25,820 tokens, against a few hundred through the borrowed token. The plugin runs Codex only to have it renew its sign-in.

**Depend on Magpie.** Pointing plugins at Magpie's local gateway (`127.0.0.1:3425`, key `magpie`) needs no code, and remains possible as a `custom` source. As the way, it would make a separate desktop app a requirement of every AI feature, a headless Mac mini or a NAS included, and Yolo would know nothing of the sign-ins it relies on.

**Write Yolo's own OAuth client for each provider.** Each provider's flow, client registration, token refresh, and API differ and change; pi-ai maintains them for the `own` source.

**Daily limits per provider, set in the provider's options.** A limit belongs to the node, which counts every plugin's calls whatever provider answers them; one number in the node's environment covers every provider, including one a community plugin adds.

**Put the model capability in the core instead of a plugin.** The core would then carry an LLM library, and name vendors and agents. As a provider plugin it stays as optional as Plex: an owner who wants no AI leaves it out, and another library or gateway can replace it.

**Run the owner's agent (the Claude Code or Codex plugin) for each question.** An agent plugin's run starts a full agent with Yolo's MCP tools, takes tens of seconds to minutes, and runs one at a time with the screens' Ask requests. The `claude-code` source runs the same command without tools or MCP servers, for one answer, outside Ask's queue.

**Make the calls from the control plane.** The borrowed sign-ins and pi-ai's OAuth flows live on the node's machine, OpenAI's plan usage is offered to software that runs locally, and the plugins that need models run on the node. The Worker has no use for them.

**Give plugins tools or browsing.** A model that searches the web would identify more uploads, but every call would become an unbounded agent run with unbounded cost. Plugins gather what the model needs (a database's search results, for example) and ask it to decide.

## Consequences

An owner whose node runs Ask has a model for every plugin with no further step, on the subscription they already pay for, and an owner with no agent signs Yolo in once from any device. Plugins call one interface and never learn which vendor answered; tests pin the node's limits and schema check ([`service/node/test/models.test.js`](../../../../service/node/test/models.test.js)) and each source's request and answer ([`plugins/model-subscriptions/test/sources.test.js`](../../../../plugins/model-subscriptions/test/sources.test.js)).

- **The `codex` source uses an endpoint OpenAI does not document for third parties,** with a token issued to Codex. OpenAI can change the endpoint or refuse other callers at any time. The source then fails, `models status` says so, and the next source answers; `models login` with Sign in with ChatGPT is the documented route and the place to go if OpenAI objects.
- **Each vendor's terms decide whether its subscription may be used here.** Driving `claude` keeps the Claude call inside Claude Code, and the plugin offers its own sign-ins only for vendors that allow them.
- **A subscription's allowance is shared.** Yolo's calls count against the same plan the owner uses in ChatGPT, Claude, Codex, and Ask. The daily number of calls and small default models bound this, and `yolo doctor` shows the day's calls.
- **Borrowing follows another app's file format and command line,** which Codex and Claude Code can change in any release. The plugin checks what it reads and fails the source with a message naming the fix when it cannot.
- **pi-ai is young and moves fast**, and pulls in several vendors' SDKs ([third-party notices](../../../../THIRD_PARTY_NOTICES.md)). The plugin pins its version and is the only place that imports it, so an incompatible release changes one source.
- **Content leaves the home** to the model's vendor whenever a plugin calls a model, under the owner's account, by default through the agent the owner already uses.
- **The capability is shaped by its first user**, metadata, and stays experimental before 1.0 like the rest of the plugin API.
