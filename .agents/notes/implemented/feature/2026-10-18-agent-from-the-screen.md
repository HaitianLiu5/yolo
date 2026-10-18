# Agent Note: Screens ask the owner's own agent

Status: implemented

English | [中文](2026-10-18-agent-from-the-screen.zh.md)

## Problem

Agents control Yolo through its [remote MCP server](2026-10-07-remote-mcp-server.md), so finding something to watch starts in ChatGPT or Claude. Someone already in the player, in the car or a browser, has no way to say "play the next episode of Friends" or "find a video about the new Model Y": they leave Yolo for another app. Yolo needs a way to ask an agent from the screen itself, and the owner wants that agent to be the one they already run and pay for, so Yolo needs no model API key, holds no model credential, and costs nothing beyond the owner's own plan.

## Decision

A screen's words go to an **agent plugin on the media node**, which hands them to an agent the owner already runs on that machine. The official one, [`plugins/agent-claude-code`](../../../../plugins/agent-claude-code/), runs the owner's signed-in Claude Code. The agent works through its own MCP connection to Yolo, as it would from a terminal, and the play reaches the screen through the Hub like any other.

```
screen ──POST /v1/agent──▶ control plane ──nodeFetch──▶ node /internal/v1/agent ──▶ agent plugin ──▶ claude -p
   ▲                                                                                                    │
   └──────────── Hub play command ◀── Yolo's MCP tools (/mcp) ◀───────────────────────────────────────────┘
```

### The request

- **`POST /v1/agent`** `{ text, language? }` needs the `control` scope. A paired screen's own credential makes that screen the agent's default target: the control plane looks up its name and passes `device: { id, name }` with the text. `text` is at most 1,000 characters. The answer is NDJSON (`application/x-ndjson`), streamed as the agent works: `{ type: "tool", name }` for each tool it calls (Yolo's own by their MCP names, such as `search` and `play`), `{ type: "text", text }` for words it writes on the way, then `{ type: "done", text }` with its one sentence or `{ type: "error", error }`. A refusal before the agent starts (no text, no agent on the node, the node offline) is an ordinary `/v1` error status.
- **`GET /v1/agent`** answers `{ available, title?, reason? }`, read from the node; a node from before agents answers 404, which becomes `available: false` with "Upgrade the media node".
- **On the node**, [`service/node/src/agents.js`](../../../../service/node/src/agents.js) keeps the agents plugins register and runs one request at a time: a new request aborts the one still running, since the person changed their mind, and starts once that one has stopped, so two never play or queue at once; a closed connection aborts it too. `/internal/v1/agent` (GET for the status, POST for the stream) sends its headers at once; `nodeFetch()`'s 15-second timeout covers only them, and cloudflared flushes NDJSON as it is written. The endpoint is new and only the new control plane calls it, so `NODE_PROTOCOL` stays.

### The agent plugin

An agent plugin calls `yolo.registerAgent(id, { title?, health?, ask })` in its node factory ([`@useyolo/plugin-api`](../../../../service/plugin-api/src/index.js)); the first registered is the one screens ask. `ask(request, { signal, emit })` gets `{ text, device, language }`, reports `tool` and `text` events through `emit`, stops when `signal` aborts, and resolves `{ text }`. A failed start removes the plugin's agents with its sources.

`agent-claude-code` runs `claude -p --output-format stream-json --verbose` once per request, in the plugin's cache directory, with the request on stdin so nothing a person says is read as a flag:

- **Its own login and Yolo connection.** No key or token passes from Yolo. The CLI uses the owner's Claude Code login and its MCP server named `yolo` (the `server` option), which [`yolo-connect-agent`](../../../../skills/yolo-connect-agent/SKILL.md) adds with user scope. The plugin reads that entry from Claude Code's user config (`~/.claude.json`, or under `CLAUDE_CONFIG_DIR`) and passes it back with `--mcp-config`; the same name, type, URL, and headers find the OAuth token Claude Code already keeps for it. With no such entry the agent reports itself unavailable, so screens show no Ask button; when the CLI's first message shows a server it cannot reach, the request fails with a message that says to connect it.
- **Yolo's server alone, narrow tools, no prompts.** `--strict-mcp-config` leaves out the owner's other MCP servers and plugins, and `--setting-sources ""` their settings files, whose allow rules would otherwise add to the ones here; a request, or a page it reads, cannot reach another integration. `--tools WebSearch,WebFetch` leaves only web search and page reading of the built-in tools: nothing runs commands or edits files. `--allowedTools mcp__yolo,WebSearch,WebFetch` with `--permission-mode dontAsk` refuses anything else without asking, and `--disallowedTools` removes Yolo's deleting tools (`remove_device`, `queue_remove`, `queue_clear`, `playlist_delete`). It never bypasses permissions.
- **What it is told.** `--append-system-prompt` says it acts for a Yolo screen that may be a car's while someone drives, plays on the screen that asked unless told otherwise, searches the library before the web, picks the best match without asking, and ends with one short sentence in the person's language.
- **A short memory.** A request within `memoryMinutes` (10) of the same screen's last answer continues that conversation with `--resume`, so "the next one" works. Each screen has its own, since a conversation keeps the system prompt it began with, which names its screen; a conversation the CLI no longer has starts anew, but a request that failed after a tool ran is not asked again, since it may have played or queued already.
- **Its environment.** The child gets the node's environment without names that look like secrets (`SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`, `CREDENTIAL`, `COOKIE`), so `NODE_SECRET` and source credentials stay with the node; `CLAUDE_CODE_OAUTH_TOKEN`, a login of Claude Code's own, stays.
- **Finding the CLI.** `command` (`CLAUDE_CODE_COMMAND`, default `claude`) is looked up on `PATH`, then where its installers put it (`~/.local/bin`, `~/.claude/local`, Homebrew, `/usr/local/bin`), since a launchd or systemd service reads no login profile. Without it the agent reports itself unavailable and screens show no button. `model` (`CLAUDE_CODE_MODEL`) picks a model; `timeoutSeconds` (180) ends a request that runs too long, with SIGTERM and, 5 seconds later, SIGKILL.

The plugin is in [`plugins/official.json`](../../../../plugins/official.json), last; on a machine without Claude Code it loads and answers `available: false`.

### On the screen

The home screen's header has an **Ask** button (the agent's title, such as "Ask Claude Code", is its label) while `GET /v1/agent` says an agent is available; the player checks on every welcome ([`clients/player/src/ask.js`](../../../../clients/player/src/ask.js)). It opens a panel near the top, clear of the on-screen keyboard: one field, and one line under it that names the step the agent is on ("Searching the web…", "Starting it…") and then shows its sentence or its error. After a tool that changes what plays here, the panel closes on its own 1.5 seconds after the answer; closing it, or asking again, stops the request. A phone's keyboard dictation works in the field; the car's microphone is not used yet.

## Alternatives considered

**An agent loop inside the control plane, calling a model API.** Fastest to answer, since Yolo's tools run in the Worker, but every owner would need an API key paid by use, and Yolo would hold it. The owner's own agent costs nothing more and needs no credential in Yolo.

**The model API's remote MCP connector pointed at Yolo's `/mcp`.** The same key, plus a token Yolo would have to issue itself, for a detour back into the same Worker.

**A long-lived Claude Code process per conversation (`--input-format stream-json`).** Saves the CLI's start on each request, but needs process supervision and memory limits on the node; one run per request with `--resume` is simpler and keeps the conversation.

**`--dangerously-skip-permissions` with a strict MCP config, as some gateways do.** It would let the CLI run any tool it has; narrowing the tools and refusing the rest keeps the agent to searching and playing.

**Speech in the car's browser.** Tesla lets a page use the cabin microphone only on AMD Ryzen cars since 2026.26, with a prompt per request; it waits until the owner's car is known to have it.

## Consequences

The owner asks for something to watch from the screen they are watching on, with the agent and plan they already have; Yolo stores no model credential and pays for no model. Each request starts the CLI, which takes a few seconds before the first step shows, and nothing answers while the node or its machine is off. What the agent can do is what its Yolo connection and the two web tools allow, minus deleting; a request someone says in the car reaches an agent that can search the web and play on any screen. The screen sees only Yolo's events and the agent's last sentence, never its reasoning.
