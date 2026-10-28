# Agent Note: Connect an agent on the home machine from a signed-in screen

Status: proposed

English | [中文](2026-10-22-remote-agent-approval.zh.md)

## Problem

An agent CLI on the home machine, such as Codex or Claude Code, reaches Yolo's MCP server with an OAuth token from the [authorization server](../../implemented/architecture/2026-10-07-oauth-authorization-server.md). Its MCP login is the authorization code flow with PKCE and a loopback redirect: the CLI opens a listener on `127.0.0.1`, prints the authorization URL, and waits for the browser to come back to that listener. The MCP authorization spec defines only this flow, so the CLIs offer no device code login for an MCP server (Codex's `--device-auth` signs in to OpenAI only).

The owner is usually away from the home machine. Approving on a phone sends the phone's browser to the phone's own `127.0.0.1`, which fails; the owner must copy that failed address back to the home machine by hand. Codex 0.144.4 waits a fixed 300 seconds for it, so a login from a phone often times out. The same holds for every agent whose login is a loopback redirect, and for [screens asking the owner's agent](../../implemented/feature/2026-10-18-agent-from-the-screen.md), which use that agent's own login to Yolo.

## Proposal

A command on the home machine asks Yolo for an agent token through a device grant; the owner approves it on any screen where they are signed in, and the command writes the token where the agent reads it.

### The flow

1. On the home machine the owner, or an agent working for them, runs `npm run yolo -- connect <agent>` (for example `codex`). It requests a grant from `POST /oauth/device_authorization` with `grant=agent`, the agent's id, and the machine's name, and prints a short code and `verification_uri_complete`, as `cf` and `npm run yolo -- auth` do.
2. Yolo shows the pending request to the signed-in owner: on the approval page the link opens, in a banner on every connected player and Apple TV app through the realtime channel, and in a list of pending requests in Settings. The request names the agent, the machine, the short code, and the scopes, with each scope switchable as on the authorization page.
3. The owner compares the short code with the one the command printed and presses **Allow** with their passkey session. Approval accepts only same-origin submissions, as screen pairing does.
4. The command polls `POST /oauth/token` with the device code grant and receives an access token and a refresh token for Yolo's origin, the same audience and scopes an authorization code grant gives an agent, so `/mcp` and `/v1` accept it unchanged.
5. The agent's plugin writes the token into the agent's own credential store and checks it with one read-only MCP call. For Codex this is `$CODEX_HOME/.credentials.json` (or the keychain), keyed by the server's name and a hash of its config, with the issuer set so that Codex refreshes the token itself.

A grant works once and expires after 10 minutes, so nothing waits on the CLI's own timeout.

### Where the pieces live

- The control plane extends the [device code grant](../../implemented/feature/2026-10-07-device-code-pairing.md) in `service/control/src/auth/device.js` with an agent grant that ends in an OAuth grant held by the provider, not a device credential. Whether `workers-oauth-provider` can issue tokens for a grant completed without a redirect is the first thing to establish; if it cannot, the control plane completes a normal authorization for the request internally.
- The pending request reaches signed-in screens as a realtime message to the owner's Hub; a screen without an owner session shows nothing.
- Writing the token is agent-specific, so each agent plugin exports a `connect` entry the command calls; the command and the control plane name no agent.
- Push notifications to a locked phone (Web Push, which iOS allows only for a web app added to the home screen) are a later step; the banner and the Settings list come first.

## Alternatives considered

**Paste the failed address.** The owner approves on the phone and sends the `127.0.0.1` address back to the home machine. It works today, but it is a manual copy of a credential-bearing URL, and with Codex it must happen within 300 seconds. A script that runs the authorization code exchange itself removes the time limit but not the copy.

**A long-lived bearer token in an environment variable.** Codex reads a bearer token from `bearer_token_env_var`. Yolo would have to issue a token that never expires and has no refresh, which the authorization server avoids for agents, and the owner would have to set the variable in every shell the agent runs in.

**Relay the redirect through Yolo.** Set the CLI's callback URL to a Yolo route that forwards the code through the node to the CLI's loopback listener. It needs no change to the agent's credential store, but it works only when the agent runs on the node's machine, it keeps the CLI's 300-second limit, and the authorization link still has to travel from the home machine to the phone.

**Wait for agents to support a device code login for MCP.** Nothing in the MCP authorization spec asks for it.

**Per-question tokens only.** [Conversations with any of the owner's agents](2026-10-18-multi-agent-conversations.md) proposes a short-lived token that Yolo signs for each question a screen asks, which removes any login for Ask. It does not cover the owner's own sessions with the agent, which this proposal does.

## Acceptance criteria

- From a phone away from home, the owner connects Codex on the home machine: they run the command or ask an agent to, approve with the passkey in a Yolo page or the player's banner, and Codex then calls Yolo's MCP tools without copying any address.
- The token refreshes after an hour without the owner.
- A request that is not approved within 10 minutes, or is denied, leaves the agent's credential store unchanged.
- No file under `service/` names an agent.

## Risks

- Writing into an agent's credential store relies on a format the agent does not document; an update to the agent can break it. The plugin's check after writing detects this and reports it, and the plugin owns the format.
- A pending request on every signed-in screen invites approving a request the owner did not start. The short code, the machine's name, and the 10-minute lifetime limit this; a denied or expired request is never shown again.
- The agent grant gives an agent the same access an authorization code grant does, so its approval keeps the same passkey session and scope controls.
