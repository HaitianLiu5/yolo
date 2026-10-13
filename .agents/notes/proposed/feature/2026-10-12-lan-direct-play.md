# Agent Note: LAN direct play from the home node

Status: proposed

English | [中文](2026-10-12-lan-direct-play.zh.md)

## Problem

A browser at home that plays from Yolo receives every media byte through Cloudflare. The node sends it up the home connection through the cloudflared tunnel, the Worker passes it on, and it comes back down the same connection ([same-origin passthrough](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.md), [Workers VPC](../../implemented/architecture/2026-10-08-workers-vpc-node-access.md)). The home uplink therefore caps quality: the node's ceiling is 4.8 Mbps (`STREAM_MAX_VIDEO_BITRATE_KBPS`), and the Plex plugin asks Plex for a 720p stream of at most that bitrate for every item, which transcodes any larger file even when it sits on the same machine and the browser could decode the original ([source plugin API](../../implemented/architecture/2026-10-11-source-plugin-api.md)). Plex's own apps play such a file directly over the home network. The detour also keeps home playback under the open question about Cloudflare's terms for proxied video ([video terms](../process/2026-10-07-cloudflare-video-terms.md)).

A browser on the node's network should fetch media from the node directly, play the original file when it can decode it, and use the tunnel everywhere else. The player page comes from the control plane's public HTTPS origin and is cross-origin isolated ([canvas engine](../../implemented/architecture/2026-04-04-canvas-playback-engine.md)), so a request to the node on the LAN is a cross-origin request from a public site to a private address, which browsers restrict. Provider names must stay out of the core, the control plane, and the node ([plugin architecture](../../implemented/architecture/2026-10-11-plugin-architecture.md)).

## Proposal

### Verdict

LAN direct play is feasible for Yolo Web in computer and phone browsers, by the mechanism Plex uses: a public hostname that resolves to the node's private address, a publicly trusted certificate for that name, and a client that probes the address and otherwise uses the tunnel. No device needs a private certificate authority or a browser flag. Three conditions limit it:

- Chrome and Firefox ask once per site for Local Network Access, and Chrome on macOS also needs the system's Local Network permission. Safari asks nothing.
- A router with DNS rebinding protection drops the name's private answer unless the owner allowlists the domain.
- The car is unproven. Whether Tesla's browser (desktop Chrome 148 on Linux) shows or grants the Local Network Access permission is unknown, and only a test in the car on home Wi-Fi answers it. A car whose probe fails keeps using the tunnel.

"No transcoding" holds wherever the browser decodes the file's codecs. An original MP4 file plays as it is; a Matroska file with codecs the browser decodes is remuxed by stream copy; audio the browser cannot decode (DTS, TrueHD) is converted alone; a full transcode remains for image subtitles, video the browser cannot decode, and Wi-Fi slower than the file. The gain is large for Plex and for the planned NAS sources. yt-dlp items are not transcoded today, so for them the LAN path only removes the tunnel round trip and the uplink cap.

### Design

1. The node opens a second listener, HTTPS on its LAN address, that serves only `/m/*` and a probe. The internal API stays on `127.0.0.1:9191`.
2. The control plane gives the listener a hostname in the owner's zone that resolves to the node's private IPv4 address, and obtains its certificate from Let's Encrypt by DNS-01. The private key never leaves the node.
3. The Hub tells each device the LAN origin. The device probes it and reports whether it reached it, and the Hub passes `network: "lan"` to `prepare` for a device that did.
4. The media token in the path stays the only credential. LAN URLs are the same `/m/{token}/…` paths under the LAN origin.
5. On the LAN path a source plugin chooses direct play, remux, or transcode from the device's capabilities and a higher bitrate ceiling. The node's core judges playability from containers and codecs only, so no provider name enters it.
6. A LAN failure during playback becomes the existing recovery, through the tunnel, at the same position.
7. Yolo runs no plex.direct-style service. Every owner at 1.0 has a Cloudflare zone, and the owner's own zone gives the same result.

This amends one standing rule: the client is no longer same-origin with every `/m/*` request. The LAN origin is the one exception, and it is served with CORS headers that the cross-origin isolated page accepts.

### How a device finds the node on its LAN

- The node reports its LAN listener in `/internal/v1/health` as `lan: { origin, address, notAfter }`. The Hub's `welcome` carries `lan: { origin }` while the node reports a working listener.
- The device probes `GET {origin}/lan/probe` with a 2-second timeout. The probe carries no token. It runs on `welcome`, on the browser's `online` event, and after a LAN media failure. When the result changes, the device sends `{ v: 1, type: "network", lan: true | false }`, and the Hub keeps the latest value per device, as it keeps the viewport.
- A screen's first probe waits until the owner turns on "Play over the home network" for that screen in settings, so that the browser's Local Network Access prompt appears when the owner expects it rather than on a first visit. After that, probes run on their own. Where the Permissions API knows the permission (Chrome's `local-network`), `granted` skips the wait and `denied` makes settings show how to allow it.
- The probe decides, as the parallel connection tests of Plex Web do ([Plex](#how-plex-jellyfin-and-emby-do-it)). A probe away from home fails quietly: the private address times out, or TLS fails against whichever device holds that address on the other network.

### How a stream picks the LAN path

- The Hub sends `network: "lan"` in `prepare` for a device whose last probe succeeded. The node then takes `LAN_MAX_VIDEO_KBPS` (unlimited by default) as its ceiling instead of `STREAM_MAX_VIDEO_BITRATE_KBPS`, still lowered by the device's [adaptive cap](../../implemented/feature/2026-10-11-adaptive-quality.md), and passes `network` in the plugin's prepare context.
- The stream descriptor gains `origin`: the LAN origin, or `null` for the page's own origin. The device resolves every stream, playlist, and subtitle URL against it; `player.js` and `subtitles.js` resolve against `location.origin` today. The node's playlists already use absolute paths (`/m/{token}/…`), which resolve against the playlist's own origin.
- A device that becomes reachable during playback keeps its stream. The LAN path applies from the next stream: a new item, a seek before the stream's start, a quality or track change, or recovery.

### Hostname and certificate

For the owner's own zone (`haitian.site`):

- **The name** is one label per node, outside the passkey relying party `yolo.haitian.site`: for example `yolo-lan-<random>.haitian.site`. A name under `yolo.haitian.site` could ask for the owner's passkeys, because WebAuthn lets a page on a subdomain use its parent domain as the relying party ID. The session cookies are `__Host-` cookies, which a sibling host cannot set or overwrite.
- **The DNS record** is a DNS-only (not proxied) A record to the node's private IPv4 address with a 60-second TTL. The control plane updates it when the node reports a new address.
- **The certificate** comes from Let's Encrypt through ACME DNS-01, the only challenge type that needs no inbound connection to the node. The node generates the key pair and a CSR for its one name and returns the CSR in `/internal/v1/health`. The control plane runs the ACME order with WebCrypto, writes the `_acme-challenge` TXT record through the Cloudflare API with a token limited to DNS edit on that zone (the Worker secret `LAN_DNS_TOKEN`), and sends the chain to a new `/internal/v1/lan/certificate`. The node swaps it in without a restart. Renewal follows ACME Renewal Information, or two thirds of the lifetime without it, so the shorter lifetimes that Let's Encrypt and the CA/Browser Forum have scheduled need no change ([certificates](#certificates-for-a-private-address)).
- **What becomes public:** the name appears in Certificate Transparency logs, and the A record publishes the node's private address. Neither tells more than a home LAN address.

For other owners: [distribution](2026-10-11-distribution-to-other-owners.md) already gives every owner a Cloudflare account and a domain, so the one-command deploy creates the DNS token, and the same mechanism serves them. A Yolo-run plex.direct-style service is needed only by owners without a zone, which means [self-hosting without Cloudflare](../architecture/2026-10-07-self-hosting-without-cloudflare.md), outside 1.0. Such a service needs a rate-limit override from Let's Encrypt for its shared domain ([certificates](#certificates-for-a-private-address)); authoritative DNS that answers IP-encoded names (`192-168-1-10.<owner-hash>.<domain>`); issuance that signs only CSRs, authenticated by each owner's control plane; and Yolo as an always-on dependency of every owner's renewals. Its complexity is high, and it waits for self-hosting.

### The LAN listener and authorization

- The listener serves only `GET` and `HEAD` under `/m/{token}/…`, `OPTIONS` preflights, and `/lan/probe`. The media token authorizes each media request exactly as through the Worker ([same-origin passthrough](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.md)). Nothing else is reachable on the LAN; owner pairing codes stay on the Unix socket.
- It binds to the node's private IPv4 address only and refuses peers outside private ranges, so a global IPv6 address behind a router that admits inbound IPv6 does not expose it. It answers only requests whose `Host` is its own name, which defeats DNS rebinding against it. It serves no HTML: every body is media, a playlist, WebVTT, or JSON, with `X-Content-Type-Options: nosniff`.
- CORS: `Access-Control-Allow-Origin` is the control plane's `PUBLIC_ORIGIN`. `Access-Control-Expose-Headers` lists `Content-Range`, `Accept-Ranges`, `ETag`, and `X-Yolo-Error-Code`, so hls.js and the canvas engine can read ranges and typed errors. Responses also carry `Cross-Origin-Resource-Policy: cross-origin`, so the page's COEP accepts them however the browser fetches them.
- A single byte range is a CORS-safelisted `Range` value, so media requests need no preflight. The canvas engine's prefetcher also sends `X-Drive-In-Prefetch: 1`, a custom header that would make every segment request preflighted, and preflights are cached per URL; on the LAN the flag moves into the URL's query.

### What "no transcoding" means per source

| Source | Today, through the tunnel | On the LAN |
|---|---|---|
| Plex | Plex's transcoder at 720p and at most 4.8 Mbps; `directStream=1` already copies video that fits those limits | **Direct play:** the plugin returns Plex's original part (`/library/parts/{id}/{changestamp}/{file}`) as a `file` Input with `cache: false`, and the node proxies it by byte range, when the container and codecs play in the device. **Direct stream:** Plex's universal transcoder with the device's resolution and the LAN ceiling, which copies the video and converts only what the device cannot play. **Transcode:** as today, for burned-in image subtitles and video the device cannot decode |
| yt-dlp | No transcode: the node proxies or joins formats chosen under the 4.8 Mbps cap | The plugin is unchanged. The LAN ceiling lets it choose 1080p and above, and VP9 or AV1 where the device decodes them. The node still downloads from the internet; the LAN path saves the uplink and the round trip through Cloudflare |
| NAS and folder files ([0.5](2026-10-11-own-library-and-nas.md)) | Not built | ffprobe describes the file. MP4 or WebM with supported codecs plays directly; Matroska is remuxed by stream copy; DTS or TrueHD audio is converted alone; anything else is transcoded. Through the tunnel the same files usually exceed the uplink and need a transcode on NAS hardware, so the LAN path is what lets high-bitrate NAS files play at home |

**Plex: the node proxies the original file; the browser never calls Plex.** A browser that fetched from Plex directly would hold the owner's Plex token, which administers the whole Plex server, and the client would need Plex's URLs and authentication, which breaks the provider-neutral client. Plex's own `plex.direct` name and certificate would still need the same Local Network Access permission, so going direct gains nothing in the browser. Plex usually runs on the node's own machine (`PLEX_URL` defaults to `http://localhost:32400`), so the proxy costs a loopback copy, or a second LAN hop when Plex runs elsewhere; the media token, session expiry, stop, and progress stay Yolo's.

### Where it sits in the plugin architecture

- **The control plane's core** holds each device's `network` state, the LAN origin in `welcome`, and the DNS and ACME work. None of it names a provider.
- **The node's core** owns the LAN listener, the LAN ceiling, `network` in the prepare context, and a playability helper, `context.playable(media)`. The helper takes a provider-neutral description, `{ container, video: { codec, profile, bitDepth, hdr, width, height }, audio: [{ codec, channels }], kbps }`, compares it with the device's capabilities, and answers `direct`, `remux`, `audio`, or `transcode` with its reasons. The `file` Input gains `remux`: ffmpeg stream copy into fMP4 HLS, with audio copied or converted to AAC. Local paths for the folder plugin come with 0.5.
- **Capabilities** grow the detail direct play needs ([capability negotiation](../../implemented/architecture/2026-10-07-capability-negotiation.md)): containers (`mp4`, `webm`); video codecs with profile and bit depth (H.264 High versus High 10, HEVC Main versus Main 10, AV1, VP9); audio codecs (`mp4a`, `mp3`, `opus`, `flac`, `ac-3`, `ec-3`); HDR; and a `maxHeight` from the display. The `<video>` engine measures them with `MediaCapabilities.decodingInfo()`. The car's profile stays 720p H.264 and AAC on canvas.
- **Plugins** map their own metadata into the description. The Plex plugin chooses the part, Plex's direct stream, or Plex's transcode; yt-dlp keeps choosing formats from the cap and codec list; folder and WebDAV use ffprobe. Provider code stays in `plugins/`, so `git grep -niE "plex|yt-?dlp|youtube" -- service/` keeps its current hits. The client stays provider-neutral: it sees an origin and a delivery.

### Fallback

- No LAN origin, a pending or denied permission, or a failed probe: the device uses the tunnel, as today.
- A LAN media request fails during playback (Wi-Fi lost, the car drives off, a laptop wakes on another network): the engine's network error starts the player's recovery. The device first sends `network` with `lan: false`, so the rebuild at the same position goes through the tunnel at the tunnel's ceiling, and the plugin picks a transcode if the original exceeds it. In the car, the canvas engine's buffer of up to 210 seconds usually covers the switch.
- Wi-Fi slower than the original: the adaptive-quality controller lowers the cap, and the plugin switches to a transcode, still served over the LAN.
- An expired certificate, a stale address, or a router that drops the name: the probe fails, and the device stays on the tunnel. Settings and `/diag` show the permission state and the probe's last result.

### Owner setup

| Step | When it is needed |
|---|---|
| A Cloudflare API token with DNS edit on the zone, stored as the Worker secret `LAN_DNS_TOKEN` | Once, required; the deploy command can create it for other owners |
| Turn on "Play over the home network" for the screen in Yolo's settings | Once per screen |
| Allow Local Network Access for the site in Chrome and Firefox | Once per browser, at the browser's prompt |
| Allow Chrome in macOS System Settings, Privacy & Security, Local Network | Once per Mac, at the system's prompt |
| Allowlist the domain in the router's DNS rebinding protection | Only where the router filters private answers |
| Allow the node in the macOS firewall | Only where the firewall is on |
| A DHCP reservation for the node's machine | Optional; avoids DNS record updates |

Without any of these steps, media flows through the tunnel exactly as today, and nothing breaks.

### Feasibility and complexity

| Piece | Feasibility | Complexity | Difficulty |
|---|---|---|---|
| LAN listener: `/m/*`, probe, CORS, private-address binding, certificate reload | Feasible | Low | Reusing the media handler behind a second server |
| Hostname, DNS record, and ACME DNS-01 run by the control plane | Feasible | Medium | An ACME client in a Worker; renewals as lifetimes shrink; address changes |
| Discovery, probe, `network` state, and the stream origin in both engines | Feasible | Medium | Local Network Access states per browser; resolving every URL against the stream's origin |
| Capability detail and the playability helper | Feasible | Medium | Codec profiles and HDR differ per browser and system |
| Plex direct play and direct stream on the LAN | Feasible | Low to medium | Whether Plex writes fMP4 segments when it copies HEVC, which Apple's HLS rules require |
| Remux of Matroska by stream copy in the node | Feasible | Medium to high | Seeking: restarting ffmpeg at a keyframe and mapping positions |
| yt-dlp on the LAN | Feasible | Low | Only the ceiling and the codec list change |
| Fallback through recovery | Feasible | Low to medium | Telling a LAN failure from an upstream failure |
| The car on home Wi-Fi | Unknown | Low if the permission works | Tesla's browser's handling of Local Network Access, testable only in the car |
| A Yolo-run plex.direct-style service | Feasible, not proposed | High | A rate-limit override, authoritative DNS, issuance, and uptime as a dependency of every owner |

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
- **The car.** Tesla's browser is desktop Chrome 148 on Linux ([display size](../../implemented/feature/2026-10-11-display-size.md)), so Local Network Access applies to it. Chrome marks the feature as needing embedder support, and Android WebView grants it unconditionally ([chromestatus](https://chromestatus.com/feature/5152728072060928)); nothing documents whether Tesla's browser prompts, grants, or denies. The canvas engine fetches from the main thread, so Chrome's extra rule for service and shared workers does not apply. The device will report the permission state and the probe's result in its `env` event ([device telemetry](../../implemented/feature/2026-10-11-device-telemetry.md)), which answers the question the first time the car is on home Wi-Fi.

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

The playability helper turns this into four outcomes:

- **Direct play:** MP4 or WebM whose codecs the device decodes, served by byte range. Matroska is remuxed everywhere until Chrome documents its support and Safari has any.
- **Remux:** a container the device does not take with codecs it decodes. ffmpeg's stream copy changes the container "with no quality loss" but "might not work in some cases" ([ffmpeg](https://ffmpeg.org/ffmpeg.html)). The node writes HLS with `-hls_segment_type fmp4` ([formats](https://ffmpeg.org/ffmpeg-formats.html)); the muxer cuts a segment "on the next key frame" after `hls_time`, and Apple requires every segment to start with an IDR frame and HEVC to travel in fMP4 rather than MPEG-TS.
- **Audio only:** video copied and audio converted to AAC, for DTS, TrueHD, and AC-3 or E-AC-3 outside Safari.
- **Transcode:** video the device cannot decode (HEVC in Chrome without a hardware decoder, AV1 on older Apple devices, 10-bit H.264), an image subtitle (PGS or VobSub) to burn in, because browsers draw only WebVTT, or a bitrate above what the link sustains.

The car's profile is 720p H.264 and AAC on canvas, so it direct-plays only sources already inside that profile, such as many yt-dlp formats. For everything else, the LAN path saves the car the tunnel hop but not the transcode.

## Certificates for a private address

- **No certificate for the address itself.** The Baseline Requirements say "CAs SHALL NOT issue Certificates containing Internal Names or Reserved IP Addresses" ([BR §4.2.2](https://github.com/cabforum/servercert/blob/main/docs/BR.md)), and Let's Encrypt validates IP-address certificates only by HTTP-01 or TLS-ALPN-01 ([Let's Encrypt](https://letsencrypt.org/2025/07/01/issuing-our-first-ip-address-certificate)). The node needs a DNS name.
- **DNS-01** can "validate domain names whose webservers aren't exposed to the public internet" ([challenge types](https://letsencrypt.org/docs/challenge-types/)).
- **Lifetimes keep shrinking.** Let's Encrypt's default profile issues 90-day certificates; its 45-day `tlsserver` profile has been available since 2026-05-13; the default drops to 64 days on 2027-02-10 and to 45 days on 2028-02-16 ([from 90 to 45](https://letsencrypt.org/2025/12/02/from-90-to-45), [profiles](https://letsencrypt.org/docs/profiles/)). The CA/Browser Forum caps every public certificate at 200 days from 2026-03-15, 100 days from 2027-03-15, and 47 days from 2029-03-15 ([SC-081](https://cabforum.org/2025/04/11/ballot-sc081v3-introduce-schedule-of-reducing-validity-and-data-reuse-periods/)). Renewal is therefore automatic from the start, and renewals that follow ACME Renewal Information are exempt from rate limits ([rate limits](https://letsencrypt.org/docs/rate-limits/)).
- **Rate limits** allow 50 certificates per registered domain every 7 days, and the registered domain comes from the Public Suffix List ([rate limits](https://letsencrypt.org/docs/rate-limits/)). One owner renewing one name never approaches it. A domain shared by many owners would need an override from Let's Encrypt, because the list does not accept entries "whose sole purpose is to circumvent rate limits of third parties" ([guidelines](https://github.com/publicsuffix/list/wiki/Guidelines)).
- **Cloudflare** documents a restriction only for proxied records that point at private addresses ([private origins](https://developers.cloudflare.com/dns/private-origins/troubleshooting/)), so the record stays DNS-only. API tokens are scoped to zones, and their runtime restrictions cover client addresses and lifetime, not records ([create a token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [restrict tokens](https://developers.cloudflare.com/fundamentals/api/how-to/restrict-tokens/)). Cloudflare's Origin CA certificates "only encrypt traffic between Cloudflare and your origin server", so browsers do not trust them ([Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)).
- **DNS rebinding protection** discards public answers that point at private addresses. OpenWrt enables `rebind_protection` by default and allowlists with `rebind_domain` ([OpenWrt](https://openwrt.org/docs/guide-user/base-system/dhcp)); pfSense has it "active by default" and allowlists with `private-domain` or `rebind-domain-ok` ([pfSense](https://docs.netgate.com/pfsense/en/latest/services/dns/rebinding.html)); OPNsense filters too, with Unbound's private domains as the allowlist ([OPNsense](https://docs.opnsense.org/manual/unbound.html)); a FRITZ!Box takes exceptions per host name ([FRITZ!Box](https://uk.fritz.com/service/knowledge-base/dok/FRITZ-Box-5590-Fiber/3565_The-FRITZ-Box-reports-Your-DNS-rebind-protection-rejected-your-query-for-reasons-of-security/)). The owner allowlists the node's name or the whole zone.
- **Public wildcard DNS services** such as [sslip.io](https://sslip.io/) answer names that embed an address, and [local-ip.sh](https://local-ip.sh/) publishes the private key of its wildcard certificate for anyone to use, which lets anyone impersonate every name under it.

## Alternatives considered

**The browser fetches from Plex directly**, through Plex's own `plex.direct` URL. The page would hold the owner's Plex token, which administers the whole Plex server; the client would carry Plex's URLs and authentication, against the provider-neutral client; Plex's address needs the same Local Network Access permission; and Yolo's media token, session expiry, and progress would not apply. The node, usually on Plex's own machine, proxies the original file for the cost of a loopback copy.

**Plain HTTP to the node's private IP address**, through Chrome's mixed-content exemption. It works only in Chrome, only for `fetch()` or an IP-literal URL, and still needs the Local Network Access permission. Safari and Firefox upgrade or block the request, and the media token would cross the LAN unencrypted.

**A private certificate authority or a self-signed certificate on the node.** Every device would have to trust the authority, which the car cannot, and an installed root authority can impersonate any site to that device.

**Public wildcard DNS services such as sslip.io or nip.io.** Every owner's LAN playback would depend on a third party's DNS, and a service that also hands out a shared wildcard certificate publishes its private key, so anyone can impersonate the name ([certificates](#certificates-for-a-private-address)).

**A Yolo-run plex.direct-style service now.** Every 1.0 owner already has a Cloudflare zone, which gives the same result with no service for Yolo to run. The service is worth its cost only together with [self-hosting without Cloudflare](../architecture/2026-10-07-self-hosting-without-cloudflare.md).

**ACME on the node, with the zone token in `.env`.** It is simpler: a maintained Node ACME client exists, and no internal endpoint is added. But it puts a credential that edits the whole zone on the home machine, where every node plugin can read `.env` ([plugin trust model](../../implemented/architecture/2026-10-11-plugin-architecture.md)). With the control plane running ACME, the node holds only the key for its own name.

**A wildcard certificate for a LAN subdomain** (`*.lan.haitian.site`). The node needs one name, and a certificate for exactly that name keeps a stolen key useful for that name only.

**Matching public addresses before probing.** The node would have to learn its own public address, a device that reaches Cloudflare over IPv6 would not match a node seen over IPv4, and the probe would still be needed.

**WebRTC data channels between the page and the node.** They need no certificate, DNS name, or router exception. But every engine would need a custom loader, Safari's native HLS could not use one, the node would need a WebRTC stack, and Chrome plans to bring WebRTC under Local Network Access as well ([chromestatus](https://chromestatus.com/feature/5065884686876672)).

**Serving the player from the node on the LAN, as Jellyfin does.** A second origin would need its own device credential, its own cross-origin isolation, and a cross-origin realtime channel, and the owner's passkeys are bound to the control plane's name.

**Switching to the LAN path in the middle of a stream.** It saves at most the rest of one stream's tunnel traffic and costs a rebuild the owner did not ask for; the next stream takes the LAN path anyway.

## Acceptance criteria

On the owner's home Wi-Fi, with `LAN_DNS_TOKEN` configured and "Play over the home network" on for each screen:

- Chrome and Safari on the Mac, Safari on the iPhone, and Firefox play a Plex film stored as H.264 and AAC in MP4 at its original resolution and bitrate from the LAN origin. Plex shows no transcode session for it, and Workers Logs show no `/m/*` request for its session.
- A Matroska film with H.264 video plays through Plex's direct stream with the video copied, as Plex's decision reports.
- A yt-dlp item plays above 4.8 Mbps where the source and the device allow it.
- Turning Wi-Fi off during LAN playback continues at the same position through the tunnel.
- A browser that denied Local Network Access, a router that drops the name, and an expired certificate each leave playback on the tunnel, and settings show the reason.
- The certificate renews without a node restart.
- The car either plays from the LAN origin or reports the permission state and probe result that kept it on the tunnel.
- `git grep -niE "plex|yt-?dlp|youtube" -- service/` hits the same files as before.

## Risks

Security:

- **A new listener on the home machine.** Every device on the LAN, guests and smart-home devices included, can reach it. It serves only media authorized by a token and the probe, binds to the private IPv4 address, refuses peers outside private ranges and requests for other `Host` names, and serves no HTML. A flaw in the media handler becomes reachable from the LAN, not only through the Worker.
- **The zone credential.** `LAN_DNS_TOKEN` can edit every record in the zone, because Cloudflare scopes API tokens to zones, not to records. It sits with the Worker's other secrets, whose theft is already a full compromise.
- **The node's private key** lets a thief impersonate the node's name on any network. The name lies outside the passkey relying party and cannot set the `__Host-` session cookies. It is same-site with the control plane, so the owner routes must keep checking the exact origin rather than the site.
- **The permission is broad.** Local Network Access opens the whole LAN to the control plane's origin, not only the node, so a script injected into the page could scan the home network. The page's content security policy and its lack of third-party scripts are the defense.
- **What becomes public:** the A record publishes the node's private address, and Certificate Transparency logs publish the name.
- **The media token** works on both origins, so a leaked URL also plays from the LAN until its session ends, as it plays through the Worker today.

Other risks and costs:

- The car may never get the permission, and then its LAN path stays unused.
- Many owners will not know how to add a rebinding exception to their router, so their LAN path stays off; settings must say why.
- Two media paths double what a playback bug can depend on, so telemetry must record which origin served each stream.
- A remux by stream copy cuts segments only at keyframes, so a file with sparse keyframes seeks coarsely.
- A high-bitrate original over weak Wi-Fi stalls before the adaptive controller steps down to a transcode.
- For yt-dlp items the node still downloads over the home connection, so a slow home downlink stays slow.
- The DNS record follows a changed DHCP address only after the node's next report and the record's TTL.
- An expired certificate turns the LAN path off until the control plane renews it; playback continues through the tunnel.
- The proposal changes a standing rule: every `/m/*` request is same-origin today, as the [canvas engine](../../implemented/architecture/2026-04-04-canvas-playback-engine.md) note and the root `AGENTS.md` state. Implementing it updates both.
