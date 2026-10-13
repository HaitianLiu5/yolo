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
- Server-side request forgery through source plugins, the media pipeline, or thumbnails (`/v1/thumbnail`), which fetch URLs from the owner's home network
- Path traversal in cached files or subtitles
- Tokens or credentials leaking through logs (including device telemetry), responses, or error messages
- Command injection through URL or parameter handling (yt-dlp, ffmpeg)

## Out of scope

- Issues that require access to the owner's home machine, which is by design how the owner recovers access
- Malicious plugins: plugins run with the full rights of the node or the Worker, and reviewing a plugin before installing it is the safeguard

## Security design

- The Cloudflare Worker is the only public entry point; the media node has no public address and is reached through Workers VPC, with every request signed ([node access](.agents/notes/implemented/architecture/2026-10-08-workers-vpc-node-access.md)).
- With LAN direct play on, the node also serves media to screens at home over HTTPS on its private LAN address. Every device on the home network, guests and smart-home devices included, can reach that listener; it serves only token-authorized `/m/*` and a probe, refuses peers outside local ranges and other `Host` names, and serves no document. Its setup costs two secrets: the Worker secret `LAN_DNS_TOKEN` can edit every record in the zone, because Cloudflare scopes API tokens to zones, and the ACME account key that obtains the node's certificate is stored in KV with the OAuth grants ([LAN direct play](.agents/notes/implemented/feature/2026-10-12-lan-direct-play.md)).
- The owner signs in only with passkeys; the code that registers the first passkey is issued by the node on a local Unix socket that neither the Worker nor the internet can reach ([owner sign-in](.agents/notes/implemented/architecture/2026-10-08-passkey-owner-sign-in.md)).
- Agents and screens use scoped OAuth tokens and device credentials; only their hashes are stored, and device credentials are checked on every request, so revocation is immediate ([OAuth](.agents/notes/implemented/architecture/2026-10-07-oauth-authorization-server.md)).
- Media URLs carry a signed, expiring token in the path and no cookies ([same-origin passthrough](.agents/notes/implemented/architecture/2026-10-07-same-origin-media-passthrough.md)).
- Device telemetry strips tokens, credentials, and media tokens on both ends before it reaches the logs ([device telemetry](.agents/notes/implemented/feature/2026-10-11-device-telemetry.md)).
- Secrets live in environment variables and Worker secrets, never in the repository; a control plugin's options are bundled into the Worker and must not hold secrets.
