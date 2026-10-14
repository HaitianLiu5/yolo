# Agent Note: The owner signs in with passkeys and a node-issued code

Status: implemented

English | [中文](2026-10-08-passkey-owner-sign-in.zh.md)

## Problem

Yolo has one human user, the owner, who must sign in before approving an agent or pairing a screen. The bar has to be high: the media node sits on the home network and fetches arbitrary URLs for whoever controls Yolo. The control plane's address is written in a public repository, so anyone can find the sign-in page and try to guess whatever secret bootstraps the first credential. Recovery must also work when every passkey is lost, without a web recovery flow that an attacker could use.

## Decision

The owner signs in **only with passkeys**. The first passkey, and a reset after every passkey is lost, need a **6-digit pairing code issued by the home node**:

1. On the home machine, `npm run owner-code` asks the running node for a code and prints it.
2. The owner enters it at `/login` within 15 minutes and creates a passkey.

The node issues and verifies the code and keeps it only in memory; Cloudflare never stores it. A code expires after 15 minutes, five wrong attempts void it, it works once, a new request replaces the old code, and a node restart discards it. The control plane checks a code with `POST /internal/v1/owner-code/verify` (which counts a wrong attempt but does not consume the code) and consumes it with `POST /internal/v1/owner-code/consume` after the passkey verifies and before it is saved.

Registering with a code while passkeys exist is a **reset**: after the new passkey is saved, every other passkey is deleted and every web session is revoked. There is no web recovery; only the home machine can reset. Adding a passkey while signed in needs no code. While the node is offline, a code cannot be used, and `/login` asks for the node to be started first.

The owner signs in at `/login`, which shows what the sign-in is for ([owner web pages](2026-10-12-owner-web-pages.md)), or in Yolo's settings without leaving playback: the client runs the same WebAuthn ceremony on its page against `/auth/passkey/*` ([Yolo Web](../feature/2026-10-11-yolo-web-client.md)). Signed in, the owner adds more passkeys there and removes any but the last; removing one signs out every other owner session ([owner routes](2026-10-07-v1-http-api.md#owner-routes)).

Issuing a code is local only. `POST /local/v1/owner-code` is not on the node's TCP port: it is served on the node's Unix socket (by default `.yolo-node.sock` at the repository root, or `/tmp/yolo-<uid>/<hash>.sock` when that path is too long for a socket; mode 0600; changed with `NODE_LOCAL_SOCKET`), and its requests are signed with `nodeSecret` too ([`service/node/src/local.js`](../../../../service/node/src/local.js), [`owner-code.js`](../../../../service/node/src/owner-code.js)). The signature cannot tell the owner from the control plane, which holds `nodeSecret` and forwards public `/m/*` requests to the node; but cloudflared and Workers VPC reach only TCP addresses, so neither the control plane nor the internet can issue a code.

## Alternatives considered

**An admin password.** Passkeys sign in with a glance (Face ID), resist phishing, and leave no password to leak.

**Cloudflare Access.** It needs Zero Trust administration that a passkey does not.

**A long one-time setup code in a Worker secret (`OWNER_INIT_CODE`)**, used until 2026-10-11. Every recovery required rotating the secret, and the code was stored in Cloudflare.

**A second loopback TCP port for issuing codes.** It is as safe only as long as the tunnel never points at it; a Unix socket cannot be reached by the tunnel at all.

**A longer code.** Six digits are enough, like the pairing code of the WeChat keyboard app, because the only exposure window is the short time before the first registration, and recovery requires the home machine. Because the address is public, the expiry, the five-attempt limit, and single use are required.

## Consequences

Signing in is a passkey prompt, and no secret that bootstraps the owner's identity ever lives in Cloudflare or in the repository. Recovery requires physical access to the home machine, with the node running. A reset revokes passkeys and web sessions only; agent tokens and device credentials survive it ([OAuth](2026-10-07-oauth-authorization-server.md)). `PUBLIC_ORIGIN` (a var in `service/control/wrangler.jsonc`) is the passkey relying party and the OAuth issuer and token audience, so moving the instance to another address means registering every passkey again and re-authorizing every agent. The relying party ID is `PUBLIC_ORIGIN`'s full host, which on an instance without a domain is its workers.dev host; workers.dev is a public suffix, so no other Cloudflare account can claim it, and a rename of the workers.dev subdomain is such a move ([no-domain deployment](../feature/2026-10-13-no-domain-deployment.md#moving-the-address)).
