# Agent Note: LAN direct play from the home node

Status: implemented

English | [中文](2026-10-12-lan-direct-play.zh.md)

## Problem

A browser at home that plays from Yolo through the control plane receives every media byte through Cloudflare. The node sends it up the home connection through the cloudflared tunnel, the Worker passes it on, and it comes back down the same connection ([same-origin passthrough](../architecture/2026-10-07-same-origin-media-passthrough.md), [Workers VPC](../architecture/2026-10-08-workers-vpc-node-access.md)). The home uplink therefore caps quality: the node's ceiling is 4.8 Mbps (`STREAM_MAX_VIDEO_BITRATE_KBPS`), and the Plex plugin asks Plex for a 720p stream of at most that bitrate for every item, which transcodes any larger file even when it sits on the same machine and the browser could decode the original ([source plugin API](../architecture/2026-10-11-source-plugin-api.md)). Plex's own apps play such a file directly over the home network. The detour also keeps home playback under Cloudflare's terms for proxied video ([media off the Worker](../../proposed/architecture/2026-10-13-media-off-the-worker.md)).

The player page comes from the control plane's public HTTPS origin and is cross-origin isolated ([canvas engine](../architecture/2026-04-04-canvas-playback-engine.md)), so a request to the node on the LAN is a cross-origin request from a public site to a private address, which browsers restrict. Provider names must stay out of the core, the control plane, and the node ([plugin architecture](../architecture/2026-10-11-plugin-architecture.md)).

## Decision

A device on the node's network fetches media from the node directly and plays the original file where it decodes it; everywhere else, and whenever the LAN path fails, it uses the tunnel. The mechanism is Plex's: a public name that resolves to the node's private address, a publicly trusted certificate for that name, and a client that probes the name and otherwise uses the tunnel. Every owner uses their own Cloudflare zone; Yolo runs no plex.direct-style service. No device needs a private certificate authority or a browser flag.

This amends one standing rule: the client is same-origin with every `/m/*` request except on the node's LAN origin, which answers with CORS headers that the cross-origin isolated page accepts. The media token in the path stays the only credential, and LAN URLs are the same `/m/{token}/…` paths under the LAN origin.

### The LAN listener

[`service/node/src/lan.js`](../../../../service/node/src/lan.js) runs a second HTTPS listener once the control plane has named it and installed a certificate for the name:

- It binds the machine's private IPv4 address only: the first RFC 1918 address of a wired or Wi-Fi interface, skipping tunnel and virtual interfaces, or `LAN_ADDRESS`. The port is `LAN_PORT` (9443; 0 turns the listener off). Every 60 seconds the node checks its address and moves the listener when DHCP gave it another one.
- It serves `GET` and `HEAD` under `/m/{token}/…` through the same media pipeline, `OPTIONS` preflights, and `GET /lan/probe` (`{ ok, name }`, no token), and nothing else: the internal API stays on `127.0.0.1:9191`, and owner pairing codes stay on the Unix socket.
- It answers only requests whose `Host` is its own name (421 otherwise), which defeats DNS rebinding against it, and only peers with private, link-local, or loopback addresses.
- Every answer carries `Access-Control-Allow-Origin` set to the control plane's `PUBLIC_ORIGIN`, `Access-Control-Expose-Headers` (`Content-Range`, `Accept-Ranges`, `Content-Length`, `ETag`, `X-Yolo-Error-Code`), `Timing-Allow-Origin`, `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox`. A response never has an HTML or XML content type. Preflights allow `Range`.
- The node keeps an ECDSA P-256 key under `<runtime>/.lan/` (ignored by git) and builds a certificate request for its one name ([`lan-csr.js`](../../../../service/node/src/lan-csr.js)); the key never leaves the node. A new chain is checked against the key and the name and swapped in with `setSecureContext()`, without a restart.

The internal API gains `PUT /internal/v1/lan` (`{ name, allowOrigin }`, answering the listener's status and a certificate request) and `PUT /internal/v1/lan/certificate` (`{ name, chain }`), and `/internal/v1/health` reports `lan: { enabled, port, address, name, origin, listening, notBefore, notAfter, error }` ([node internal API](../architecture/2026-10-07-node-internal-api.md)).

### Name, record, and certificate

The Worker secret `LAN_DNS_TOKEN` is the only input the owner gives: a Cloudflare API token with Zone Read and DNS Edit on the zone that holds `PUBLIC_ORIGIN`'s host. Without it nothing below runs. With it, [`service/control/src/edge/lan.js`](../../../../service/control/src/edge/lan.js) runs every 5 minutes on the Worker's cron trigger, and when the owner presses Check now in settings:

1. **The zone and the name.** It finds the most specific zone containing the page's host that the token can read, and names the node once: `yolo-lan-<8 hex digits>.<zone>`, for example `yolo-lan-3f9a01c2.example.com`. A name equal to or under the passkey relying party's host (`yolo.example.com`) is refused, because WebAuthn lets a page on a subdomain use its parent domain as the relying party ID. The session cookies are `__Host-` cookies, which a sibling host cannot set or overwrite.
2. **The node.** Through `nodeFetch()` it sends `PUT /internal/v1/lan` with the name and `PUBLIC_ORIGIN`; the node answers its private address, its certificate's validity, and a certificate request.
3. **The record.** It keeps a DNS-only (not proxied) A record from the name to that address, TTL 60 seconds, and moves it when the node reports another address.
4. **The certificate.** When the node has no certificate for the name, or two thirds of its lifetime have passed, it runs an ACME order with DNS-01 ([`acme.js`](../../../../service/control/src/edge/acme.js): WebCrypto, ES256, no contact address), publishes the `_acme-challenge` TXT record, waits up to a minute for public DNS to answer it, deletes it after validation, and sends the chain to `PUT /internal/v1/lan/certificate` through `nodeFetch()`. A failed issuance waits 30 minutes, doubling up to a day, before the next try.

`LAN_ACME_DIRECTORY` names the ACME server: Let's Encrypt's production directory in `wrangler.jsonc`, and its staging directory, whose certificates browsers reject, when the variable is unset. The state is one KV value, `yolo:lan` in `OAUTH_KV`, including the ACME account's private key; it is written when something changed and otherwise once an hour. `GET /v1/owner/lan` shows it to the signed-in owner without the key, and `POST /v1/owner/lan/check` runs the steps now ([v1 HTTP API](../architecture/2026-10-07-v1-http-api.md)).

The name appears in Certificate Transparency logs, and the A record publishes the node's private address. Neither tells more than a home LAN address.

### Discovery and the path of a stream

- The Hub's `welcome` carries `lan: { origin, notAfter }` while the last check found the node listening with a valid certificate, and `lan: null` otherwise ([Hub and realtime channel](../architecture/2026-10-07-hub-and-realtime-channel.md)).
- "Play over the home network" in settings is per screen ([`clients/player/src/lan.js`](../../../../clients/player/src/lan.js)). Until the owner turns it on, the screen never probes, so the browser's Local Network Access prompt appears when the owner expects it; a screen whose browser already granted Chrome's `local-network` permission counts as on until the owner turns it off.
- The screen probes `GET {origin}/lan/probe`: on the welcome, on the browser's `online` event, 30 seconds after a LAN stream failed (2-second timeout), and when the owner turns it on or presses Check (60 seconds, which leaves time for the browser's prompt). An automatic probe does not fetch while the permission is denied, nor while it is still to be asked on a screen that never reached the node, so no prompt appears by itself.
- The screen sends `{ v: 1, type: "network", lan, reason }` when the answer changes and once after each welcome, and its own play requests carry `network: "lan" | "tunnel"`. The Hub keeps the latest value per device (`network:<deviceId>`); a device's own request sets it, and nobody else's does.
- The Hub passes `network` to `prepare`. The node takes the LAN path only while its listener serves; then its ceiling is `LAN_MAX_VIDEO_KBPS` (200,000 by default, above any disc remux) instead of `STREAM_MAX_VIDEO_BITRATE_KBPS`, still lowered by the device's [adaptive cap](2026-10-11-adaptive-quality.md), and the plugin's prepare context carries `network` and `playable()`. The stream descriptor carries `network` and `origin` (the LAN origin, or null).
- The device resolves every stream, playlist, segment, and subtitle URL against the stream's origin; the node's playlists use absolute paths, which resolve against the playlist's own origin. The canvas engine marks read-ahead with the query `prefetch=1` on every origin, because a custom header would make every LAN segment request wait for a preflight, and the `<video>` engine loads with `crossorigin="anonymous"` ([two engines](../architecture/2026-10-12-two-playback-engines.md)).
- A device that becomes reachable during playback keeps its stream; the LAN path applies from the next stream: a new item, a seek outside the stream, a quality or track change, or a recovery.

### Playing the original

The node's core answers the plugin's `playable(media)`: a provider-neutral description, `{ container, video: { codec, profile, bitDepth, hdr, width, height }, audio: [{ codec, channels }], kbps }`, compared with the device's capabilities and the stream's limit ([`media/playable.js`](../../../../service/node/src/media/playable.js)). It answers `direct` (the container and codecs play as they are), `remux` (only the container does not), `audio` (only the audio does not), or `transcode` (the video codec, a bit depth above 8, HDR, a height above `maxHeight`, or a bitrate above the limit), with every reason. Capabilities gain `containers` (`mp4` for every play profile); the `<video>` profile adds `flac`, `ac-3`, and `ec-3` where the browser plays them and takes `maxHeight` from the display (1080, 1440, or 2160). The car's profile stays 720p H.264 and AAC on canvas ([capability negotiation](../architecture/2026-10-07-capability-negotiation.md)).

| Source | Through the tunnel | On the LAN |
|---|---|---|
| Plex | Plex's transcoder at 720p and at most 4.8 Mbps; `directStream=1` copies video that fits those limits | **Direct play:** when `playable()` says `direct`, no subtitle is burned in, and the chosen audio is the file's default, the plugin returns Plex's part (`/library/parts/{id}/{changestamp}/{file}`) as a `file` Input with `cache: false`, and the node proxies it by byte range. **Direct stream:** otherwise a `<video>` device gets Plex's universal transcoder at the device's picture size (16:9 of its `maxHeight`) with `maxVideoBitrate` at the stream's limit, so Plex copies video that fits and converts only the rest, and a target of at most 20 Mbps where it must transcode. The car keeps the fixed 720p transcode |
| yt-dlp | No transcode: the node proxies or joins formats chosen under the 4.8 Mbps cap | The plugin is unchanged; the LAN ceiling lets it choose higher-bitrate formats within its height targets. The node still downloads from the internet; the LAN path saves the uplink and the round trip through Cloudflare |

The browser never calls Plex: the token goes from the node to Plex as a header, and the device sees only `/m/…` URLs. Plex usually runs on the node's machine (`PLEX_URL` defaults to `http://localhost:32400`), so the proxy costs a loopback copy; the media token, session expiry, stop, and progress stay Yolo's.

### Fallback

- No LAN origin, the switch off, a denied permission, or a failed probe: the device uses the tunnel.
- Any recovery of a LAN stream (an engine error, a stalled seek, a frozen picture, a stream that fails to load) first turns the screen to the tunnel: it sends `network` with `lan: false`, records `lan_fallback`, and the recovery's own request asks for the tunnel, so the rebuild at the same position comes through the tunnel at the tunnel's ceiling, and the plugin transcodes when the original exceeds it. Thirty seconds later the screen probes again. In the car the canvas engine's buffer of up to 210 seconds usually covers the switch.
- Wi-Fi slower than the original: the adaptive-quality controller lowers the cap, and the plugin switches to a transcode, still over the LAN.

### Telemetry

Workers Logs show which path each stream took and why a LAN attempt failed ([device telemetry](2026-10-11-device-telemetry.md)):

- The device event `lan_probe` carries `outcome`, `trigger`, `elapsedMs`, `permission` (Chrome's `local-network` state, or null), and the LAN `host`. Outcomes are `ok`; `timeout` (no answer in time: another network, or a firewall); `permission_denied`; `permission_prompt` (the permission is still to be asked, or a prompt was dismissed); `certificate` (the welcome's certificate has expired); `dns_rebinding` (a quick failure with the permission granted and a valid certificate: the name did not reach the node, usually because the router's rebinding protection dropped its private answer); and `http_<status>`.
- The device event `lan_fallback` carries the failing error's `code` and `message` and the `position`; `stream_selected` gains `network`, `lanHost`, and `original` (the source's file as it is).
- The Hub logs `event: "stream"` for every prepare (`sessionId`, `deviceId`, `reason`, `requester`, `asked`, `network`, `deliveryType`, `maxVideoKbps`), where `network` is the path the node served, and `event: "network"` for each report.
- The control plane logs `kind: "lan"` with `event: "certificate"`, `"address_changed"`, or `"error"` (`step`, `message`, `failures`, `retryAt`).

### Owner setup

| Step | When it is needed |
|---|---|
| A Cloudflare API token with Zone Read and DNS Edit on the zone, stored as the Worker secret `LAN_DNS_TOKEN` | Once, required |
| Turn on "Play over the home network" for the screen in Yolo's settings | Once per screen |
| Allow Local Network Access for the site in Chrome and Firefox | Once per browser, at the browser's prompt |
| Allow Chrome in macOS System Settings, Privacy & Security, Local Network | Once per Mac, at the system's prompt |
| Allowlist the name or the zone in the router's DNS rebinding protection | Only where the router filters private answers |
| Allow the node in the macOS firewall | Only where the firewall is on |
| A DHCP reservation for the node's machine | Optional; avoids DNS record updates |

Without any of these steps, media flows through the tunnel and nothing breaks. Settings show each screen's last probe in words, and the owner's "Home network" card shows the name, address, certificate dates, and the last error.

## How Plex, Jellyfin, and Emby do it

**Plex** solves the same problem as Yolo, because Plex Web is also served from a public HTTPS origin:

- **Names and certificates.** Each server is reached as `https://{IP-description}.{identifier}.plex.direct:{port}`, where the address part is "a `-` separated string of the IPv4 or IPv6 address components" ([Plex Media Server API](https://developer.plex.tv/pms/)). Plex's DNS answers any such name with the address it encodes, and each server holds a wildcard certificate for its own identifier. The certificates came from DigiCert at the 2015 launch and come from Let's Encrypt today ([secure connections](https://support.plex.tv/articles/206225077-how-to-use-secure-server-connections/), [Valsorda, 2015](https://words.filippo.io/how-plex-is-doing-https-for-all-its-users/)).
- **Discovery.** A client asks plex.tv for the server's connections (`/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`). Each has a `uri` and the flags `local` and `relay`, and "connections labeled as `local` should be preferred over those that are not, and `relay` should only be used as a last resort" ([API](https://developer.plex.tv/pms/)). The shipped Plex Web 4.162 tests every direct connection in parallel and tries relays only when all of them fail; this is read from its code, not from documentation. Native apps also find servers on the LAN by GDM multicast on UDP ports 32410, 32412, 32413, and 32414 ([network](https://support.plex.tv/articles/200430283-network/)), which a browser cannot use.
- **Fallback.** Remote access through a forwarded port, then Plex Relay, which is limited to 2 Mbps per stream for every subscriber ([relay](https://support.plex.tv/articles/216766168-accessing-a-server-through-relay/)).
- **DNS rebinding.** Plex documents that a router's rebinding protection can block the secure local connection, and tells owners to allow `plex.direct`, for example with `rebind-domain-ok=/plex.direct/` in dnsmasq or `private-domain: "plex.direct"` in Unbound ([secure connections](https://support.plex.tv/articles/206225077-how-to-use-secure-server-connections/)).
- **Local Network Access.** Since Chrome 142, Plex Web asks for the permission. If the owner denies it, Plex Web connects remotely ([Plex forum, 2025-11-06](https://forums.plex.tv/t/important-note-about-the-plex-web-app-local-network-access/933264)), which since 2025-04-29 requires Plex Pass or a Remote Watch Pass ([remote playback](https://support.plex.tv/articles/requirements-for-remote-playback-of-personal-media/)).
- **The decision.** Direct Play sends the file unchanged; Direct Stream repackages it and may convert the audio alone; burned-in subtitles always need a full transcode ([direct play and direct stream](https://support.plex.tv/articles/200250387-streaming-media-direct-play-and-direct-stream/)). The server decides from the client's profile and the requested quality at `/{transcodeType}/:/transcode/universal/decision`, which takes `directPlay`, `directStream`, `directStreamAudio`, `location` (`lan`, `wan`, `cellular`), and `X-Plex-Client-Profile-Extra`; the original file is `/library/parts/{partId}/{changestamp}/{filename}` ([API](https://developer.plex.tv/pms/)). The LAN Networks setting decides which clients count as local ([network](https://support.plex.tv/articles/200430283-network/)).

**Jellyfin** serves its own web client, so in a browser at home the page and the media share one origin, often plain HTTP, and none of the browser constraints below arise. HTTPS is off by default and left to a reverse proxy; Jellyfin runs no certificate service ([networking](https://jellyfin.org/docs/general/post-install/networking/)). Native clients find servers by a UDP broadcast to port 7359. `LocalNetworkSubnets` decides which clients are local, and `RemoteClientBitrateLimit` applies only to the others. A client sends a device profile, which jellyfin-web builds with `canPlayType` (`browserDeviceProfile.js`), and the server's `StreamBuilder` chooses direct play, direct stream (video untouched), or transcode ([transcoding](https://jellyfin.org/docs/general/post-install/transcoding/)).

**Emby** uses Emby Connect only to help devices locate the server; every connection is direct ([Emby Connect](https://emby.media/support/articles/Emby-Connect.html)). The owner brings a domain and a certificate ([secure your server](https://emby.media/support/articles/Secure-Your-Server.html)). The hosted app at `https://app.emby.media` cannot reach a server without HTTPS because browsers block the mixed content, and Emby's advice is to open the app over plain HTTP instead ([connectivity](https://emby.media/support/articles/Connectivity.html)).

Yolo takes Plex's shape (a public name for a private address, a real certificate, a probe, and a fallback), because its page also lives on a public HTTPS origin. It takes Jellyfin's device profile for the playability decision. It needs none of Plex's central services, because each owner already has a zone.

## Browser constraints

These were checked on 2026-10-12, when Chrome stable is 156, Firefox 157, and Safari 27.

- **Mixed content.** An HTTPS page cannot play plain-HTTP media from a public name. Chrome upgrades audio and video to HTTPS without falling back ([chromestatus](https://chromestatus.com/feature/5557268741357568)), Firefox 127 does the same for images, audio, and video ([Firefox 127](https://www.firefox.com/en-US/firefox/127.0/releasenotes/)), and Safari 18 upgrades all images and media ([WebKit](https://webkit.org/blog/15443/)). The node therefore needs HTTPS with a certificate for its name.
- **Local Network Access in Chrome.** Since Chrome 142, a public site's request to an address "reserved for local use" waits for a permission prompt ([Chrome](https://developer.chrome.com/blog/local-network-access), [chromestatus](https://chromestatus.com/feature/5152728072060928)). The address space comes from the resolved IP, so a public name that resolves to `192.168.x.x` counts as local even over valid HTTPS. It covers `fetch()`, subresources, and iframe navigations, and WebSockets and WebTransport since Chrome 147. The decision persists as a site setting. Chrome 145 split the permission into `local-network` and `loopback-network` and kept `local-network-access` as an alias ([chromestatus](https://chromestatus.com/feature/5068298146414592)). The preflight headers of the earlier Private Network Access design are gone, and enterprise policies such as `LocalNetworkAccessAllowedForUrls` can grant it in advance ([chromestatus](https://chromestatus.com/feature/5197681148428288)).
- **Chrome's mixed-content exemption** lets an HTTPS page use plain HTTP only for a private IP literal, a `.local` name, or a `fetch()` with `targetAddressSpace: "local"`, and states that a "public domain is not exempt from mixed content, even if it resolves to a local network address" ([Chrome](https://developer.chrome.com/blog/local-network-access)). `<video src>` and hls.js's XHR cannot declare the option, and Safari and Firefox have no such exemption.
- **Firefox** enabled Local Network Access for all users in Firefox 153 and extended it to WebSockets in 154 ([153](https://www.firefox.com/en-US/firefox/153.0/releasenotes/), [154](https://www.firefox.com/en-US/firefox/154.0/releasenotes/)). For HTTPS to a private address it checks the permission only after the TLS handshake succeeds (`network.lna.defer_https_check`), so a probe that meets another network's device fails at TLS before any prompt.
- **Safari** ships no Local Network Access: WebKit's preference is off by default, and the bug to enable it is open ([WebKit bug 295047](https://bugs.webkit.org/show_bug.cgi?id=295047)). Apple's Local Network privacy (iOS 14 and macOS 15 and later) exempts Safari and WebKit views and blocks other apps' outgoing local connections until the user grants the privilege, which affects Chrome on macOS. It does not apply to listening for and accepting incoming connections, so the node's listener needs no grant ([TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)).
- **CORS and COEP.** Under `Cross-Origin-Embedder-Policy: credentialless`, a cross-origin `no-cors` request such as `<video src>` loads without a `Cross-Origin-Resource-Policy` header and without credentials ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy)). hls.js and the canvas engine send `cors` requests, which need `Access-Control-Allow-Origin`. A single byte range is a safelisted `Range` value in Chrome 99, Firefox 117, Safari 16, and later ([MDN](https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_request_header)), and `Content-Range` must be exposed explicitly. Firefox supports `credentialless` since 119; Safari does not, so the page is not cross-origin isolated there, and Safari plays through `<video>`.
- **The car.** Tesla's browser is desktop Chrome 148 on Linux ([display size](2026-10-11-display-size.md)), so Local Network Access applies to it. Chrome marks the feature as needing embedder support, and Android WebView grants it unconditionally ([chromestatus](https://chromestatus.com/feature/5152728072060928)); nothing documents whether Tesla's browser prompts, grants, or denies. The canvas engine fetches from the main thread, so Chrome's extra rule for service and shared workers does not apply. The car's `lan_probe` events, with the permission state and the outcome, answer the question the first time the car is on home Wi-Fi.

## What a browser plays without a transcode

Direct play needs a container that the `<video>` element or Media Source Extensions accept and codecs that the device decodes. As of 2026-10-12:

| Format | Chrome and Edge | Firefox | Safari |
|---|---|---|---|
| MP4 (and fMP4), WebM | Yes | Yes | Yes |
| Matroska | In Chromium's media type table since 145, with no release note | Since 145, for the common codecs | Not documented |
| H.264, 8-bit | Yes | Yes, through the system's decoder | Yes |
| HEVC | Since 107 where hardware decodes it, on every Mac with macOS 11 or later | Windows since 134, macOS since 136, Linux since 137 | Yes |
| AV1 | Yes | Yes | Only with a hardware decoder: M3 Macs, iPhone 15 Pro, iPhone 16 and later |
| VP9 | Yes | Yes | Yes |
| AAC, MP3, FLAC | Yes | Yes | Yes |
| AC-3, E-AC-3 | No (desktop Chrome) | No primary source; treated as no | Yes, in HLS |
| DTS, TrueHD | No | No | No |

Sources: MDN on [containers](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers), [video codecs](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs), and [audio codecs](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs); [Chrome's HEVC](https://chromestatus.com/feature/5186511939567616); Firefox [134](https://www.mozilla.org/en-US/firefox/134.0/releasenotes/), [136](https://www.mozilla.org/en-US/firefox/136.0/releasenotes/), [137](https://www.mozilla.org/en-US/firefox/137.0/releasenotes/), and [145](https://www.mozilla.org/en-US/firefox/145.0/releasenotes/); [Safari 17's AV1](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/); Chromium's [media type table](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/base/mime_util_internal.cc) and [AC-3 build flag](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/media_options.gni); and Apple's [HLS authoring specification](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices). Browser support for 10-bit H.264 (High 10) is not documented, so it counts as unsupported.

The four outcomes of `playable()` follow from it:

- **Direct play:** MP4 whose codecs the device decodes, served by byte range. Matroska is never direct-played, because Chrome documents no support and Safari has none.
- **Remux:** a container the device does not take with codecs it decodes. Plex does it with its direct stream. ffmpeg's stream copy changes the container "with no quality loss" but "might not work in some cases" ([ffmpeg](https://ffmpeg.org/ffmpeg.html)); its HLS muxer cuts a segment "on the next key frame" after `hls_time` ([formats](https://ffmpeg.org/ffmpeg-formats.html)), and Apple requires every segment to start with an IDR frame and HEVC to travel in fMP4 rather than MPEG-TS.
- **Audio only:** video copied and audio converted to AAC, for DTS, TrueHD, and AC-3 or E-AC-3 outside Safari.
- **Transcode:** video the device cannot decode (HEVC in Chrome without a hardware decoder, AV1 on older Apple devices, 10-bit video, HDR), an image subtitle (PGS or VobSub) to burn in, because browsers draw only WebVTT, or a bitrate above the stream's limit.

The car's profile is 720p H.264 and AAC on canvas, so it direct-plays only sources already inside that profile, such as many yt-dlp formats. For everything else, the LAN path saves the car the tunnel hop but not the transcode.

## Certificates for a private address

- **No certificate for the address itself.** The Baseline Requirements say "CAs SHALL NOT issue Certificates containing Internal Names or Reserved IP Addresses" ([BR §4.2.2](https://github.com/cabforum/servercert/blob/main/docs/BR.md)), and Let's Encrypt validates IP-address certificates only by HTTP-01 or TLS-ALPN-01 ([Let's Encrypt](https://letsencrypt.org/2025/07/01/issuing-our-first-ip-address-certificate)). The node needs a DNS name.
- **DNS-01** can "validate domain names whose webservers aren't exposed to the public internet" ([challenge types](https://letsencrypt.org/docs/challenge-types/)).
- **Lifetimes keep shrinking.** Let's Encrypt's default profile issues 90-day certificates; its 45-day `tlsserver` profile has been available since 2026-05-13; the default drops to 64 days on 2027-02-10 and to 45 days on 2028-02-16 ([from 90 to 45](https://letsencrypt.org/2025/12/02/from-90-to-45), [profiles](https://letsencrypt.org/docs/profiles/)). The CA/Browser Forum caps every public certificate at 200 days from 2026-03-15, 100 days from 2027-03-15, and 47 days from 2029-03-15 ([SC-081](https://cabforum.org/2025/04/11/ballot-sc081v3-introduce-schedule-of-reducing-validity-and-data-reuse-periods/)). Renewal at two thirds of whatever lifetime a certificate has needs no change as they shrink.
- **Rate limits** allow 50 certificates per registered domain every 7 days, and the registered domain comes from the Public Suffix List ([rate limits](https://letsencrypt.org/docs/rate-limits/)). One owner renewing one name never approaches it. A domain shared by many owners would need an override from Let's Encrypt, because the list does not accept entries "whose sole purpose is to circumvent rate limits of third parties" ([guidelines](https://github.com/publicsuffix/list/wiki/Guidelines)).
- **Cloudflare** documents a restriction only for proxied records that point at private addresses ([private origins](https://developers.cloudflare.com/dns/private-origins/troubleshooting/)), so the record stays DNS-only. API tokens are scoped to zones, and their runtime restrictions cover client addresses and lifetime, not records ([create a token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [restrict tokens](https://developers.cloudflare.com/fundamentals/api/how-to/restrict-tokens/)). Cloudflare's Origin CA certificates "only encrypt traffic between Cloudflare and your origin server", so browsers do not trust them ([Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)).
- **DNS rebinding protection** discards public answers that point at private addresses. OpenWrt enables `rebind_protection` by default and allowlists with `rebind_domain` ([OpenWrt](https://openwrt.org/docs/guide-user/base-system/dhcp)); pfSense has it "active by default" and allowlists with `private-domain` or `rebind-domain-ok` ([pfSense](https://docs.netgate.com/pfsense/en/latest/services/dns/rebinding.html)); OPNsense filters too, with Unbound's private domains as the allowlist ([OPNsense](https://docs.opnsense.org/manual/unbound.html)); a FRITZ!Box takes exceptions per host name ([FRITZ!Box](https://uk.fritz.com/service/knowledge-base/dok/FRITZ-Box-5590-Fiber/3565_The-FRITZ-Box-reports-Your-DNS-rebind-protection-rejected-your-query-for-reasons-of-security/)). The owner allowlists the node's name or the whole zone.
- **Public wildcard DNS services** such as [sslip.io](https://sslip.io/) answer names that embed an address, and [local-ip.sh](https://local-ip.sh/) publishes the private key of its wildcard certificate for anyone to use, which lets anyone impersonate every name under it.

## Alternatives considered

**The browser fetches from Plex directly**, through Plex's own `plex.direct` URL. The page would hold the owner's Plex token, which administers the whole Plex server; the client would carry Plex's URLs and authentication, against the provider-neutral client; Plex's address needs the same Local Network Access permission; and Yolo's media token, session expiry, and progress would not apply. The node, usually on Plex's own machine, proxies the original file for the cost of a loopback copy.

**Plain HTTP to the node's private IP address**, through Chrome's mixed-content exemption. It works only in Chrome, only for `fetch()` or an IP-literal URL, and still needs the Local Network Access permission. Safari and Firefox upgrade or block the request, and the media token would cross the LAN unencrypted.

**A private certificate authority or a self-signed certificate on the node.** Every device would have to trust the authority, which the car cannot, and an installed root authority can impersonate any site to that device.

**Public wildcard DNS services such as sslip.io or nip.io.** Every owner's LAN playback would depend on a third party's DNS, and a service that also hands out a shared wildcard certificate publishes its private key, so anyone can impersonate the name ([certificates](#certificates-for-a-private-address)).

**A Yolo-run plex.direct-style service.** Every owner already has a Cloudflare zone, which gives the same result with no service for Yolo to run; [distribution](../../proposed/feature/2026-10-11-distribution-to-other-owners.md) gives other owners their own account and domain, and their deploy command can create the DNS token. The service needs a rate-limit override from Let's Encrypt for its shared domain, authoritative DNS that answers IP-encoded names, issuance that signs only CSRs authenticated by each owner's control plane, and Yolo as an always-on dependency of every owner's renewals. It is worth that cost only together with [self-hosting without Cloudflare](../../proposed/architecture/2026-10-07-self-hosting-without-cloudflare.md).

**ACME on the node, with the zone token in `.env`.** It is simpler: a maintained Node ACME client exists, and no internal endpoint is added. But it puts a credential that edits the whole zone on the home machine, where every node plugin can read `.env` ([plugin trust model](../architecture/2026-10-11-plugin-architecture.md)). With the control plane running ACME, the node holds only the key for its own name.

**ACME and the LAN state in the Hub Durable Object, renewed by an alarm.** The Hub is per user, while the node, its name, and its certificate belong to the deployment; a cron trigger needs no object to wake, and one KV value holds the state that every Hub's welcome reads.

**A wildcard certificate for a LAN subdomain** (`*.lan.example.com`). The node needs one name, and a certificate for exactly that name keeps a stolen key useful for that name only.

**Matching public addresses before probing.** The node would have to learn its own public address, a device that reaches Cloudflare over IPv6 would not match a node seen over IPv4, and the probe would still be needed.

**A plain-HTTP probe of the address literal, to tell a DNS failure from a TLS failure.** It would add a plaintext listener and work only in Chrome. The quick-failure outcome, with the permission state and the elapsed time, already tells the owner what to check.

**Probing on every page without the per-screen switch.** Chrome and Firefox would show the Local Network Access prompt on a first visit, before the owner knows why.

**WebRTC data channels between the page and the node.** They need no certificate, DNS name, or router exception. But every engine would need a custom loader, Safari's native HLS could not use one, the node would need a WebRTC stack, and Chrome plans to bring WebRTC under Local Network Access as well ([chromestatus](https://chromestatus.com/feature/5065884686876672)).

**Serving the player from the node on the LAN, as Jellyfin does.** A second origin would need its own device credential, its own cross-origin isolation, and a cross-origin realtime channel, and the owner's passkeys are bound to the control plane's name.

**Switching to the LAN path in the middle of a stream.** It saves at most the rest of one stream's tunnel traffic and costs a rebuild the owner did not ask for; the next stream takes the LAN path anyway.

## Consequences

At home, a browser plays a Plex original at its own resolution and bitrate with no Plex transcode and no media through Cloudflare; Plex's direct stream copies the video of files whose container or audio the browser does not take; yt-dlp items rise above 4.8 Mbps where the source and the device allow it. Away from home, and whenever the LAN path fails, playback is exactly as before. The only owner input is one token, so an installer can set the feature up.

Security costs:

- **A new listener on the home machine.** Every device on the LAN, guests and smart-home devices included, can reach it. It serves only token-authorized media and the probe, binds the private IPv4 address, refuses peers outside local ranges and requests for other `Host` names, and serves no document. A flaw in the media handler becomes reachable from the LAN, not only through the Worker.
- **The zone credential.** `LAN_DNS_TOKEN` can edit every record in the zone, because Cloudflare scopes API tokens to zones, not to records. It sits with the Worker's other secrets, whose theft is already a full compromise. The ACME account key sits in KV with the OAuth grants.
- **The node's private key** lets a thief impersonate the node's name on any network. The name lies outside the passkey relying party and cannot set the `__Host-` session cookies. It is same-site with the control plane, so the owner routes keep checking the exact origin rather than the site.
- **The permission is broad.** Local Network Access opens the whole LAN to the control plane's origin, not only the node, so a script injected into the page could scan the home network. The page loads no third-party scripts.
- **What becomes public:** the A record publishes the node's private address, and Certificate Transparency logs publish the name.
- **The media token** works on both origins, so a leaked URL also plays from the LAN until its session ends, as it plays through the Worker.

Other costs:

- Whether the car's browser grants Local Network Access is unknown until the car is on home Wi-Fi; its `lan_probe` events answer it, and a car that never gets the permission stays on the tunnel.
- Owners who cannot add a rebinding exception to their router keep the tunnel; the screen's settings say why.
- Two media paths double what a playback bug can depend on; telemetry records the path of every stream.
- A high-bitrate original over weak Wi-Fi stalls before the adaptive controller steps down to a transcode.
- For yt-dlp items the node still downloads over the home connection, so a slow home downlink stays slow.
- A changed DHCP address reaches the record within the node's 60-second check, the next 5-minute run, and the record's 60-second TTL.
- An expired certificate turns the LAN path off until the control plane renews it; playback continues through the tunnel.
- Capabilities do not measure HDR or 10-bit decoding, so such originals are transcoded even where the browser could play them.
- The node's own remux (ffmpeg stream copy of a `file` Input, with seeking restarted at keyframes) is not built: Plex remuxes with its direct stream, and the folder and NAS sources that need it come with [Yolo's own library](../../proposed/feature/2026-10-11-own-library-and-nas.md). Renewal does not use ACME Renewal Information.

## Testing

The node's tests pin the listener's scope (its own Host, local peers, CORS, no internal API, a new certificate without a restart) and that a source's upstream credentials never reach the device. The control plane's tests run ACME DNS-01 against a stand-in served at Let's Encrypt's staging directory URL that checks every JWS signature and the challenge record, with the Cloudflare API and the node as stand-ins; nothing calls Let's Encrypt or Cloudflare. The Hub's and the client's unit tests pin the fallback's request path, the Plex plugin's tests the original part with its token in a header only, and [`test/e2e/lan-direct.test.js`](../../../../test/e2e/lan-direct.test.js) plays a Plex original from the LAN origin in Chromium and falls back to the tunnel at the same position. The car's behavior is checked in the car ([in-car checks](../testing/2026-07-21-test-layers.md#in-car-checks)).
