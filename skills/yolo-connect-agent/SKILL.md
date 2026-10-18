---
name: yolo-connect-agent
description: Connect an AI agent to an owner's Yolo instance over MCP - Claude Code, claude.ai and the Claude apps, ChatGPT, or Codex - so it can search, play, and control videos. Covers the server address, each client's steps, the owner's passkey approval, and checking the connection.
---

# Connect an agent to Yolo

Yolo serves a remote MCP server with OAuth at `https://<address>/mcp`. Any MCP client that supports remote servers and OAuth can use it; the owner approves each one once, with their passkey, on Yolo's consent page, and can switch scopes off there. After connecting, the agent should load [`skills/yolo`](../yolo/SKILL.md) for how to use the tools ([remote MCP server](../../.agents/notes/implemented/feature/2026-10-07-remote-mcp-server.md)).

## Before you start

- **The address.** In the instance's checkout, it is `instance.publicOrigin` in `npm run yolo -- config show`: the owner's domain, or the instance's workers.dev host when it has no domain. Otherwise ask the owner. Never use an address from an example or another instance.
- **The owner's passkey exists.** If the consent page says "Yolo is not set up yet", do the passkey step of [`skills/yolo-deploy`](../yolo-deploy/SKILL.md) first.
- **HUMAN:** every client ends on Yolo's consent page, where the owner signs in with the passkey and presses Allow. You cannot do that part.

## Claude Code

You can run this yourself:

```sh
claude mcp add --transport http --scope user yolo https://<address>/mcp
```

`--scope user` makes it available in every project; drop it to add Yolo to the current project only. Then ask the owner to type `/mcp` in Claude Code, choose `yolo`, and choose Authenticate: the browser opens Yolo's consent page.

Connected this way on the media node's machine, with user scope and the name `yolo`, the same Claude Code also answers the **Ask** button on the owner's screens: the node's `agent-claude-code` plugin runs it with its own login, so the owner needs no API key ([screens ask the owner's own agent](../../.agents/notes/implemented/feature/2026-10-18-agent-from-the-screen.md)).

## claude.ai, Claude Desktop, and the Claude mobile apps

The owner does this in the app (a connector added on claude.ai also appears in the desktop and mobile apps):

1. **Settings > Connectors > Add custom connector.**
2. Name `Yolo`, URL `https://<address>/mcp`, then **Add** and **Connect**: Yolo's consent page opens.
3. In a chat, turn the Yolo connector on from the tools menu.

Custom connectors depend on the Claude plan, and on Team and Enterprise plans an organization owner adds them first; the Connectors page says when the plan lacks them.

## ChatGPT

The owner does this on chatgpt.com (custom MCP connectors need a paid plan, and the menu names change between versions):

1. **Settings > Apps & Connectors > Advanced settings**, and turn on **Developer mode**.
2. **Create** a connector: name `Yolo`, MCP server URL `https://<address>/mcp`, authentication **OAuth**, and confirm: Yolo's consent page opens.
3. In a chat, add the Yolo connector from the tools menu.

## Codex

You can run this yourself:

```sh
codex mcp add yolo --url https://<address>/mcp
codex mcp login yolo
```

`codex mcp login` opens Yolo's consent page for the owner. The same entry can be written by hand in `~/.codex/config.toml`:

```toml
[mcp_servers.yolo]
url = "https://<address>/mcp"
```

If the flags differ in the installed version, `codex mcp --help` lists them.

## Check the connection

Ask the agent to call `get_status`. It returns what is playing and the media node's health; `node_offline` means the agent is connected but the home node is down. The owner sees and revokes connected agents in Yolo's settings, under Connected agents.

| Problem | Fix |
|---|---|
| The consent page says Yolo is not set up | Create the owner's passkey first (`npm run owner-code`, then `/login`) |
| The client reports an OAuth or discovery error | Check the address ends in `/mcp` and opens in a browser; `npm run yolo -- doctor` checks the Worker |
| Tools are missing | The owner switched a scope off on the consent page: disconnect and connect again |
