# Agent Note: One OAuth authorization server for every client

Status: implemented

English | [中文](2026-10-07-oauth-authorization-server.zh.md)

## Problem

Yolo has very different clients: ChatGPT and Claude reach it as remote MCP clients, a browser or phone signs in interactively, a car screen has no keyboard, and a WebSocket opened by a browser cannot carry an `Authorization` header. Each needs a credential with a defined scope that the owner can revoke, and none may depend on cookies (see [same-origin passthrough](2026-10-07-same-origin-media-passthrough.md)).

## Decision

The control plane is the OAuth 2.1 authorization server for all clients, built on `@cloudflare/workers-oauth-provider` ([`service/control/src/index.js`](../../../../service/control/src/index.js)). Every client presents a bearer access token:

| Client | Flow |
|---|---|
| Agents (Claude, ChatGPT) | Dynamic client registration (RFC 7591) or a Client ID Metadata Document, then authorization code with PKCE. Metadata at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` (RFC 9728) |
| Browsers and phones | Authorization code with PKCE |
| Car and TV screens | The device code flow (RFC 8628) — see [device code pairing](../feature/2026-10-07-device-code-pairing.md) |
| The media node | No OAuth: it is reached through Workers VPC, and requests are signed with `nodeSecret` ([node access](2026-10-08-workers-vpc-node-access.md)) |

The authorization page, the device approval page, and the owner's settings routes under `/v1/owner` require the owner to be signed in; they are the only places the session cookie is used ([passkey owner sign-in](2026-10-08-passkey-owner-sign-in.md), [owner routes](2026-10-07-v1-http-api.md#owner-routes)).

### Scopes

| Scope | Allows |
|---|---|
| `read` | Reading status, devices, libraries, the queue, playlists, and history, and frames of videos ([video frames](../feature/2026-10-13-video-frames.md)) |
| `control` | Playing, pausing, seeking, switching devices, choosing tracks |
| `manage` | Changing the queue, playlists, history, and devices |

Scopes do not imply each other: a token with only `manage` cannot read status. Agents request all three by default (`requiredScopes`), and the owner can switch off any of them on the authorization page ([owner web pages](2026-10-12-owner-web-pages.md)). Each MCP tool and each `/v1` route requires exactly one scope.

### Tokens

Access tokens last one hour; refresh tokens rotate. The provider stores clients, grants, and token hashes in the `OAUTH_KV` namespace and encrypts their `props`, so D1 has no OAuth tables. A token's audience is the deployment's origin (for example `https://yolo.example.com`), so one token covers both `/mcp` and `/v1`. An MCP client that names the URL it was given as its resource indicator (`resource=https://yolo.example.com/mcp`, as the MCP authorization spec has clients do and as Codex does, sometimes beside the origin) gets the same token: before the provider reads an authorization or token request, the Worker maps every `resource` on Yolo's origin to the origin, as RFC 8707 allows ([`service/control/src/auth/resource.js`](../../../../service/control/src/auth/resource.js)). Without this, the provider, which matches resources exactly, refuses such a client with `invalid_target`. Device credentials are the control plane's own tokens, accepted through `resolveExternalToken` into the same `/v1` authorization.

### Realtime tickets

A browser cannot set `Authorization` on a WebSocket, so a client first calls `POST /v1/realtime/ticket` with its bearer token and receives a one-time ticket valid for 30 seconds, then connects to `wss://…/v1/realtime?ticket=…` ([`service/control/src/realtime.js`](../../../../service/control/src/realtime.js)). A paired device's ticket carries its device id, so the connection can only be that device.

The ticket is `<hub id>.<secret>`. The user's [Hub](2026-10-07-hub-and-realtime-channel.md) Durable Object issues the secret and keeps its hash in its own storage for 30 seconds; the upgrade request goes to the Hub the id names, which redeems the secret once and learns the device id from what it stored. The Worker accepts only ids that `HUB.idFromString` accepts for its own namespace, so a made-up ticket wakes no Hub, and it drops any device or user header the client sent.

## Alternatives considered

**Realtime tickets in `OAUTH_KV`.** Each connection costs a KV write and a delete, and Workers Free allows 1,000 KV writes a day: a car on a weak connection that reconnects every 30 seconds for two hours uses 240 of them, and once the writes run out, new connections and agents' token refreshes fail until midnight UTC. A Durable Object's storage allows 100,000 row writes a day on Free and is consistent, so a ticket also cannot be redeemed twice at two locations.

**Cloudflare Access with a cookie.** It puts sign-in in front of every route, but it requires Zero Trust administration, does not give agents the OAuth flow that remote MCP clients expect, and its cookie does not reach native players, cross-origin requests, or LAN-direct media.

## Consequences

Every client uses one token type checked in one place, and an agent connects by pasting one URL and approving it. The owner revokes an agent in Yolo's settings: `DELETE /v1/owner/agents/:id` revokes every grant of that client, with its access and refresh tokens, through the provider's `listUserGrants` and `revokeGrant`; KV is eventually consistent, so a token already issued may keep working at other locations for up to about a minute. An owner reset with the pairing code revokes web sessions and passkeys but neither agent tokens nor device credentials. Devices are revoked in settings or with `remove_device`.
