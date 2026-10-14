# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately:

1. Do **not** open a public GitHub issue.
2. Use [GitHub Security Advisories](https://github.com/HaitianLiu5/yolo/security/advisories/new).

We will acknowledge receipt within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

- Bypassing authentication or authorization: OAuth tokens and scopes, passkey sign-in and the owner pairing code, device credentials, realtime tickets
- Forging or leaking media tokens, or reaching `/m/*` without one
- Reaching the node's LAN listener for anything but token-authorized media and its probe, from a peer outside local address ranges, or under another `Host` name
- Reaching the node's remote listener (remote direct play, exposed to the internet through a router port) for anything but token-authorized media and its probe, under another `Host` or TLS server name, or past its per-address limits; and the router port mapping the node creates by PCP, NAT-PMP, or UPnP IGD outliving the owner's switch or the node
- Without a domain: learning from the listener known by the home's address, without the page's `Origin`, that it serves Yolo or what the control plane's origin is; the certificate-check listener or its router port 80 mapping outliving the order; and the node's ACME account key leaving `.lan/wan/ip.json`
- Serving media through the Worker's `/m/*` relay while the owner has it off
- Server-side request forgery through source plugins, the media pipeline, or thumbnails (`/v1/thumbnail`), which fetch URLs from the owner's home network
- Path traversal in cached files or subtitles
- Tokens or credentials leaking through logs (including device telemetry), responses, or error messages
- Command injection through URL or parameter handling (yt-dlp, ffmpeg)

## Out of scope

- Issues that require access to the owner's home machine, which is by design how the owner recovers access
- Malicious plugins: plugins run with the full rights of the node or the Worker, and reviewing a plugin before installing it is the safeguard

## Security design

- The Cloudflare Worker is the control plane's only public entry point; it reaches the media node's internal API through Workers VPC, with every request signed ([node access](.agents/notes/implemented/architecture/2026-10-08-workers-vpc-node-access.md)). The Worker relays media only while the owner has the relay on, because relaying video is most likely outside Cloudflare's terms ([media off the Worker](.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.md)).
- With LAN direct play on, the node also serves media to screens at home over HTTPS on its private LAN address. Every device on the home network, guests and smart-home devices included, can reach that listener; it serves only token-authorized `/m/*` and a probe, refuses peers outside local ranges and other `Host` names, and serves no document. Its setup costs two secrets: the Worker secret `MEDIA_DNS_TOKEN` can edit every record in the zone, because Cloudflare scopes API tokens to zones, and the ACME account key that obtains the node's certificate is stored in KV with the OAuth grants ([LAN direct play](.agents/notes/implemented/feature/2026-10-12-lan-direct-play.md)).
- With remote direct play on, the node serves media to any device on the internet over HTTPS through a router port that it maps by PCP, NAT-PMP, or UPnP IGD (or that the owner forwards), under a DNS-only name whose record publishes the home's public address. That listener serves only token-authorized `/m/*` and a probe, answers only its own name in `Host` and in TLS, checks the token before any session work, refuses an address after 20 failed requests in a minute for 10 minutes, bounds connections per address and in all, requires TLS 1.2 or newer, logs no URL, and serves no document. Turning remote access off removes the record, closes the listener, and deletes the router mapping; the threat model is in [media off the Worker](.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.md#the-threat-model-of-the-remote-listener).
- Without a domain, the remote listener is known by the home's public address and the node obtains the Let's Encrypt certificate for that address itself, so the node holds the ACME account key (owner-readable only) as well as the listener's key, and no zone credential exists. The CA's HTTP-01 check reaches a plain-HTTP listener that exists, with the router's port 80 mapped to it, only while an order runs. A scanner that connects by address sends the right `Host`, so the listener answers its probe and sends CORS headers only to the page's origin and refuses with empty bodies; the token check before any work and the per-address limits remain its defence, and the address enters Certificate Transparency logs ([media without a domain](.agents/notes/implemented/feature/2026-10-13-no-domain-deployment.md#media-without-a-domain)).
- The owner signs in only with passkeys; the code that registers the first passkey is issued by the node on a local Unix socket that neither the Worker nor the internet can reach ([owner sign-in](.agents/notes/implemented/architecture/2026-10-08-passkey-owner-sign-in.md)).
- Agents and screens use scoped OAuth tokens and device credentials; only their hashes are stored, and device credentials are checked on every request, so revocation is immediate ([OAuth](.agents/notes/implemented/architecture/2026-10-07-oauth-authorization-server.md)).
- Media URLs carry a signed, expiring token in the path and no cookies ([same-origin passthrough](.agents/notes/implemented/architecture/2026-10-07-same-origin-media-passthrough.md)).
- Device telemetry strips tokens, credentials, and media tokens on both ends before it reaches the logs ([device telemetry](.agents/notes/implemented/feature/2026-10-11-device-telemetry.md)).
- Secrets live in environment variables and Worker secrets, never in the repository; a control plugin's options are bundled into the Worker and must not hold secrets.
