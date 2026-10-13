# Agent Note: A rule-based egress proxy layer for the media node

Status: proposed

English | [中文](2026-10-13-node-egress-proxy.zh.md)

## Problem

The node downloads every byte a source plays over the home connection ([media pipeline](../../implemented/architecture/2026-10-11-node-media-pipeline.md)), and the quality of source CDNs from that connection varies strongly over time. Measured from the home node on 2026-10-12 and 2026-10-13, one Bilibili mirror delivered 172 kbps one day and up to 70 Mbps the next, while other mirrors delivered 2–5 Mbps with stalls.

Hedged segment reads and the node's memory of each host pick the best mirror live ([segment reads](../../implemented/architecture/2026-10-11-node-media-pipeline.md#segment-reads)). They cannot help when every mirror is slow from the node's network, and they cannot reach content that a source limits to a region the node is not in.

## Proposal

Add an egress layer to the node's core that sends chosen upstream requests through a named proxy, and a plugin type that supplies proxies.

### The egress layer

- **It lives in the node's core and knows no provider.** It decides per request, by host rules in `yolo.config.json`, whether the request goes direct or through a named proxy.
- **It is never a global proxy.** A host that matches no rule goes direct, and the cloudflared tunnel to the control plane and every other connection of the machine stay untouched.
- **A rule lists routes.** It matches host patterns and lists the routes allowed for them, in the order to try when the node knows nothing better. `direct` is one route; a rule without it sends those hosts only through the proxy, which is what region-limited content needs. The first matching rule applies.
- **Every egress path of the node uses the same rules:** the pipeline's upstream fetches (`upstream.js`, `hedge.js`), source plugins' own fetches through a new `yolo.fetch` on the plugin API, yt-dlp's extraction through `--proxy`, and ffmpeg's reads of split inputs through `-http_proxy`.
- **Child processes get a loopback listener, not the proxy.** `--proxy` and `-http_proxy` point at an HTTP proxy that the node runs on `127.0.0.1` and that applies the rules to each connection it opens, so yt-dlp's requests to unmatched hosts still go direct. No credential appears in a command line, which Node's `execFile` copies into its error messages.

```json
{
  "plugins": ["./plugins/source-ytdlp", "./plugins/proxy-url"],
  "egress": {
    "proxies": { "relay": { "provider": "url", "options": { "env": "EGRESS_PROXY_URL" } } },
    "rules": [
      { "hosts": ["*.bilivideo.com", "*.bilivideo.cn"], "via": ["direct", "relay"] },
      { "hosts": ["*.video.example"], "via": ["relay"] }
    ]
  }
}
```

### Proxy providers

Proxy providers are a new plugin type. A node entry registers one with `yolo.registerProxyProvider(id, impl)`. A provider only supplies the current endpoint, `{ url, username?, password?, expiresAt? }` with an `http` or `socks5` URL, and handles its own login and refresh. Yolo asks again before `expiresAt` and after the proxy refuses the credentials. A provider never sees which requests or hosts use it.

- **Yolo ships one generic official provider, `plugins/proxy-url`,** for a fixed HTTP or SOCKS URL read from an environment variable. An owner lists it in `yolo.config.json` like any plugin; it is not in `plugins/official.json`.
- **Providers for commercial accelerator services are local plugins, not official ones.** Such a service needs a private API to log in and hand out an endpoint. That API changes without notice and breaks the plugin, the service's terms may forbid third-party clients, and its device limits can make a login from the node sign the owner out of another session. An owner who accepts that loads their own provider through `yolo.config.json` ([plugin architecture](../../implemented/architecture/2026-10-11-plugin-architecture.md)); Yolo ships no code tied to one service.

### Routes in hedging and host health

Direct and proxied are two routes to the same bytes, so the node treats each pair of a URL and a route as one candidate. The node's memory of hosts (`hosts.js`) keeps faults and throughput per host and route. A hedged segment read ranks and races these candidates under the existing thresholds and bounds. Any other upstream request takes the best-ranked route and moves to the next one on failure, as a `file` request moves to the next URL.

No rule depends on the time of day: a route's quality changes by the hour and by byte range, as a mirror's does, so only live measurement ranks routes. A proxy whose provider has no current endpoint is not a route until it has one.

### Credentials and telemetry

- Credentials live in environment variables documented by `.env.example`. `yolo.config.json` names a variable at most, and no log line or error message contains a proxy's credentials or full URL.
- The node's hedge and failover log lines carry the route of each attempt, and every segment read logs the host and route that completed it, so telemetry records which route each segment used. Provider refreshes and failures are logged without credentials.

### Scope

Only the node-to-source leg changes. The device's paths, through the control plane's tunnel and by [LAN direct play](../../implemented/feature/2026-10-12-lan-direct-play.md), are unchanged, and so is Plex.

## When to start

Work has not started. It starts when either condition holds:

- Telemetry shows that the remaining stalls happen while every mirror is slow: the devices' `stall_start` events in Workers Logs ([device telemetry](../../implemented/feature/2026-10-11-device-telemetry.md)) line up, by the UTC timestamp on each node log line, with node hedges that find every mirror of the segment slow.
- The owner needs content that a source limits to a region.

## Parts and complexity

| Part | Complexity | Why |
|---|---|---|
| Rules and route choice in the node's core | Small | Pure functions of the config and the node's memory of hosts |
| Routes in `hosts.js` and `hedge.js` | Medium | Candidates become pairs of a URL and a route; thresholds and bounds stay, and every ranking and hedging test gains a route |
| Proxied requests in the node process (`upstream.js`, `yolo.fetch`) | Medium | HTTP and SOCKS proxies for Node's `fetch`, with credentials that refresh |
| The loopback listener for yt-dlp and ffmpeg | Medium | An HTTP proxy that accepts only loopback peers, applies the rules per connection, and forwards direct or through the proxy |
| The provider plugin type and `plugins/proxy-url` | Small | Registration, refresh before expiry and after refused credentials, and one provider without expiry |
| Telemetry and redaction | Small | A route field on existing log lines and one line per segment |
| A local provider for an accelerator service | Outside Yolo | Depends on that service's private API and changes with it |

## Alternatives considered

**A system-wide VPN or TUN client in global mode.** It needs no change to Yolo, but it would route the cloudflared tunnel to the control plane, and everything else the machine sends, through the proxy's region, so every device's media and every control-plane request to the node would take that detour too.

## Acceptance criteria

- Without an `egress` section, every upstream request goes direct.
- With a rule, the node reads a matched host's segments over the routes it lists, ranked by the node's memory of hosts; the node's log lines show the route of every segment; and unmatched hosts and the cloudflared tunnel never use a proxy.
- Content behind a proxy-only rule resolves with yt-dlp and plays.
- No credential appears in `yolo.config.json`, a log line, an error message, or a command line, and `.env.example` documents every variable.
- `service/` names no proxy or accelerator service, and the [plugin architecture](../../implemented/architecture/2026-10-11-plugin-architecture.md) note lists proxy providers among the plugin types.

## Risks

- A proxy adds latency before the first byte, so a proxied route can lose hedges at the 1.5-second first-byte threshold and be demoted even when its throughput is higher.
- A hedge across two routes can read the same bytes twice, and proxied bytes may count against a paid allowance.
- A local provider runs with the node's full rights, `.env` and `NODE_SECRET` included, under the plugin trust model, and breaks whenever its service's private API changes. While it has no endpoint, a host whose rule also lists `direct` goes direct, and content behind a proxy-only rule does not play.
- Any process on the machine can send through the loopback listener, and a plugin that calls the global `fetch` bypasses the rules.
- After a restart the node's memory of hosts is empty, so it follows each rule's route order until it has measured the routes.
- Playing region-limited content through a proxy can conflict with the source's terms.
