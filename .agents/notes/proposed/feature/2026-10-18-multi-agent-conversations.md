# Agent Note: Conversations with any of the owner's agents

Status: proposed

English | [中文](2026-10-18-multi-agent-conversations.zh.md)

## Problem

[Screens ask the owner's own agent](../../implemented/feature/2026-10-18-agent-from-the-screen.md) lets a screen ask one agent, Claude Code, one question at a time. Three gaps remain:

- **One agent.** Owners also run Codex, Gemini CLI, Copilot, Kimi, and others, already signed in at home. `registerAgent` accepts several, but `/v1/agent` reports only the first and the screen never says which agent answers.
- **No conversation.** The panel shows one question and one sentence. Closing it loses both; a follow-up within ten minutes continues the CLI's session, but the person cannot see what came before, and cannot start over.
- **Setup per agent.** Each CLI must add Yolo's MCP server itself and sign in to it with OAuth before the Ask button appears. Every new agent repeats that on the home machine.

## Proposal

The shape stays: screen → control plane → node → agent plugin → the owner's CLI. Four things change: the control plane keeps conversations, it signs a short-lived agent token for each question, the node keeps several agents, and plugins work per conversation.

### Agent plugins

- **Claude Code** keeps `claude -p --output-format stream-json` with `--resume`. Its MCP config becomes `{ "type": "http", "url": "<origin>/mcp", "headers": { "Authorization": "Bearer <agent token>" } }` instead of the owner's own `yolo` entry.
- **Codex**, a new official plugin, runs `codex exec --json --ignore-user-config --skip-git-repo-check -s read-only -C <its directory>` and continues with `codex exec resume <session> --json`. Yolo's server comes in through `-c mcp_servers.yolo.url=…` and `-c mcp_servers.yolo.bearer_token_env_var=YOLO_AGENT_TOKEN`, so the token travels in the environment, not on the command line.
- **ACP agents**, one new official plugin, speak the [Agent Client Protocol](https://agentclientprotocol.com/protocol/overview): `initialize`, `session/new` or `session/load`, `session/prompt`, and `session/update` notifications mapped to Yolo's events. `mcpServers` holds only Yolo's server (HTTP with the token header). The client declares no file system or terminal capability and grants `session/request_permission` only for Yolo's tools. A built-in catalog names each agent's launch command; one entry in `yolo.config.json` adds another:

```json
{ "plugin": "agent-acp", "options": { "agents": ["gemini", { "id": "my-agent", "title": "My Agent", "command": "my-agent", "args": ["--acp"] }] } }
```

The catalog starts with Gemini CLI (`gemini --acp`, from its help). Copilot (`copilot --acp`), Kimi (`kimi acp`), Kiro (`kiro-cli acp`), and Qoder (`qodercli --acp`) come from Multica's and Paseo's source and join only after they are run on the home machine and shown to ask before using their own tools.

`registerAgent(id, { title, icon?, health, ask })` grows: `health()` resolves `{ available, reason?, version? }`, and `ask({ text, language, device, session, mcp }, { signal, emit })` resolves `{ session }`, the CLI's session id, so the node stores nothing. One agent answers one question at a time; different agents may answer at once, at most two in total, and a third waits.

### The agent token

For each question the control plane signs a token with `NODE_SECRET`: owner, asking device, conversation, key version, and an expiry of the plugin's timeout plus a margin (about ten minutes). It reaches the node in the `nodeFetch()` request and the CLI through its MCP config. `/mcp` already accepts paired devices' credentials through `resolveExternalToken` ([`service/control/src/index.js`](../../../../service/control/src/index.js)); it accepts these too, with the `read` and `control` scopes only, and refuses `remove_device`, `queue_remove`, `queue_clear`, and `playlist_delete` on the server instead of through each CLI's flags. The asking device is the default target, and the audit actor is `agent:<id>`. Rotating the owner's key version revokes every outstanding token, as it does image links.

A new agent then needs nothing on the home machine beyond its own model login: no `mcp add`, no OAuth.

### Conversations and the API

The control plane stores conversations in D1 (migration `0009`, both tables with `user_id` per the [D1 data model](../../implemented/architecture/2026-10-07-d1-data-model.md)):

- `agent_conversations(id, user_id, agent_id, agent_session, title, device_id, created_at, updated_at)`
- `agent_messages(id, user_id, conversation_id, role, text, steps, created_at)`

It passes the node's stream to the screen and accumulates it, writing with `waitUntil` when the stream ends, so a screen that disconnects keeps what arrived. `agent_session` comes back in a new `{ type: "session", id }` event and goes out with the next question.

| Route | Purpose |
|---|---|
| `GET /v1/agents` | Every agent's card: `id`, `title`, `icon`, `available`, `reason`, `version`, `busy` |
| `GET /v1/agent/conversations` | Recent conversations |
| `GET /v1/agent/conversations/{id}` | One conversation's messages |
| `POST /v1/agent/conversations/{id}/messages` | `{ agent, text, language }`, NDJSON stream; `new` as the id starts one |
| `DELETE /v1/agent/conversations/{id}` | Delete a conversation and its messages |
| `GET /internal/v1/agents` | Each plugin's `health()`, cached about a minute |
| `POST /internal/v1/agent` | `{ agent, text, language, device, session, token, mcpUrl }`, NDJSON with the `session` event |

The player and Worker deploy together. A node without `/internal/v1/agents` falls back to today's `/internal/v1/agent` status and one agent. The node only gains endpoints, so `NODE_PROTOCOL` stays.

### The panel

The Ask button opens a conversation panel:

- **Agents across the top**, one chip each with its icon and a dot: available, unavailable, or answering. An unavailable chip says why and what fixes it ("Codex is not signed in: run codex login at home"). Each screen remembers its last choice; with one agent the row collapses to a label.
- **The conversation** under its title (the first question), with **New** and **History**; history lists recent conversations with their agent and time.
- **Messages**: questions on the right, answers on the left, each step as one small line that folds when the answer ends, and a card (thumbnail and title) for what the agent played.
- **The field** right under the messages, with Stop while an answer runs and a microphone where the browser offers speech recognition. In the car the panel opens from the top so the field stays above the keyboard.

Conversations belong to the owner, not a screen: one started on a phone continues in the car, and "here" always means the asking screen. A conversation has one agent, since agents cannot share sessions; switching agents starts a new one. Reopening the panel returns to the last conversation unless it is older than six hours. The system prompt keeps answers to a sentence or two.

### Data size and retention

D1 stores only what the screen shows: questions, answers, and step labels, never tool arguments or results, reasoning, system prompts, search results, or thumbnails. The CLI keeps the full context for resuming at home, and D1 keeps its session id.

A sample Claude Code transcript of 7.9 MB was 39 % tool results, 30 % attached context, 18 % tool arguments, 9 % reasoning, and under 1 % (0.07 MB) the text either side saw. Caps of 1,000 characters per question, 4,000 per answer, and 20 steps of 120 characters keep a turn under about 20 KB; a typical turn is about 1 KB. At 50 turns a day that is about 18 MB a year, against the free plan's 500 MB per database and 100,000 rows written a day. A daily job deletes conversations older than 90 days and keeps at most 500 per owner, which bounds even capped turns near 90 MB.

The CLIs' own transcripts at home are the part that grows. Each plugin runs in one fixed directory of its own (Claude resumes only in the directory a session began in), apart from the owner's coding sessions, and deletes a session's files when Yolo deletes or expires its conversation, touching nothing outside that directory.

### Plan

Each step is one PR, merged and deployed:

1. Conversations and history with Claude Code alone: migration, routes, the `session` event, the panel's history and New.
2. The agent token, Claude Code moved onto it, server-side refusal of deleting tools.
3. Several agents: `/internal/v1/agents`, `GET /v1/agents`, the agent row, the grown plugin interface.
4. The Codex plugin, after checking on the home machine that `exec` runs MCP tools without stopping for approval.
5. The ACP plugin, Gemini first, then the catalog entries one by one.
6. Optional plugins later: usage and limits, speech, live sync of one conversation across screens through the Hub.

## How other products do it

Read from source, October 2026:

| Product | Claude Code | Codex | Other agents | Conversation store | Retention |
|---|---|---|---|---|---|
| [Multica](https://github.com/multica-ai/multica) | stream-json in and out | `codex app-server` | ACP or each CLI's JSON mode | Server Postgres: every event, tool output capped at 8 KB | None in the database; local task directories 24 h, Codex session files 14 days |
| [Paseo](https://github.com/getpaseo/paseo) | Claude Agent SDK | `codex app-server` | ACP | Agent metadata on disk; timeline in memory, rebuilt from the CLI's history | None |
| [Happy](https://github.com/slopus/happy) | Claude Agent SDK | `codex app-server` | Gemini over ACP | Server Postgres, end-to-end encrypted: text, reasoning, tool arguments, no tool output | None |
| [AionUi](https://github.com/iOfficeAI/AionUi) | ACP adapter | ACP adapter | ACP | Local SQLite: text, tool calls, reasoning, permissions, diffs | None |

Every one resumes through the CLI's own session. Paseo's provider snapshot (availability, reason, models, modes, capabilities) is the model for the agent cards; [ADHDev](https://github.com/vilmire/adhdev)'s providers-as-data manifests are the model for the ACP catalog.

## Alternatives considered

**ACP for every agent, Claude Code and Codex included, as AionUi does.** One code path, but it adds two adapter packages (`claude-agent-acp`, `codex-acp`) that themselves wrap the Agent SDK and `codex app-server`; Multica, Paseo, and Happy all keep native paths for those two.

**`codex app-server` instead of `codex exec`.** It suits long sessions with approvals mid-turn. A Yolo question is one turn, so one process per turn with `exec resume` is as simple as the Claude Code plugin.

**Embedding Paseo, AionUi, or Multica.** They are coding workbenches that give an agent the machine; Yolo wants an agent that can reach only Yolo.

**Each CLI's own `mcp add` and OAuth, as today.** ACP passes an HTTP MCP server only as a URL and headers, so a CLI's stored OAuth token cannot be used there, and every new agent would repeat the setup at home.

**History only in the screen's browser, or only in the CLI's files as Paseo does.** A conversation would not follow the owner from phone to car, and nothing would show while the home machine is off.

**Storing whole transcripts, as Multica and AionUi do.** They serve coding, where people review edits and commands; a screen needs what was asked and what played, and transcripts are where the size comes from.

**Carrying a conversation's text to another agent.** It would claim continuity the new agent's session does not have.

## Acceptance criteria

- A question and its answer are still there after the panel closes, the page reloads, or the same owner opens Ask on another screen.
- A follow-up in a conversation continues the agent's session; New starts a fresh one.
- The agent row lists every registered agent with its availability and reason; Claude Code, Codex, and Gemini each find and play something.
- A newly installed agent works with only its own login on the home machine.
- A token cannot delete devices, queue entries, or playlists, and fails after its expiry or a key rotation.
- D1 holds no tool results or reasoning; a measured turn on the home machine replaces the estimates above, in D1 and on disk.

## Risks

- **Agents that run their own tools without asking.** Some may read files outside their empty directory. Each catalog entry is tried on the home machine first; one that ignores refused permissions stays out.
- **Prompt injection from web pages.** Bounded by the token: search and playback control only.
- **The owner's plan.** Each question spends the owner's own Claude, ChatGPT, or Gemini allowance; no new cost, but real usage.
- **CLI drift.** Flags and event formats change between releases; each plugin pins what it parses and reports a version it cannot read as unavailable.
- **Unmeasured numbers.** The data sizes are estimates until a measured turn replaces them.
