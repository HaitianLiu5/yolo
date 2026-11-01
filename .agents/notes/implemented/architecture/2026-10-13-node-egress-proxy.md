# Agent Note: A rule-based egress proxy layer for the media node

Status: implemented

English | [中文](2026-10-13-node-egress-proxy.zh.md)

## Problem

The node downloads every byte a source plays over the home connection ([media pipeline](2026-10-11-node-media-pipeline.md)), and resolves every web page through yt-dlp from that connection too. Some content is limited to a region the node is not in: a sports replay or an anime series that a site gives only to viewers in its own country, even to a paying account, while the media servers it then names answer from anywhere. The node needs to send the few requests that a region limits through a proxy in that region, and nothing else.

The quality of source CDNs from the home connection also varies strongly over time. Measured from the home node on 2026-10-12 and 2026-10-13, one Bilibili mirror delivered 172 kbps one day and up to 70 Mbps the next, while other mirrors delivered 2–5 Mbps with stalls. Hedged segment reads and the node's memory of each host pick the best mirror live ([segment reads](2026-10-11-node-media-pipeline.md#segment-reads)), but cannot help when every mirror is slow from the node's network.

## Decision

The node's core has an egress layer that sends the upstream requests the owner's rules choose through named proxies, and a plugin type supplies those proxies ([`service/node/src/egress/`](../../../../service/node/src/egress/)).

### Rules

The owner's `yolo.config.json` has an optional `egress` section beside `plugins`. It names proxies, each with the provider that supplies it and that provider's options, and lists rules that match host names:

```json
{
  "plugins": ["./plugins/source-ytdlp", "./plugins/proxy-url"],
  "egress": {
    "proxies": { "abroad": { "provider": "url", "options": { "env": "EGRESS_ABROAD_PROXY_URL" } } },
    "rules": [
      { "hosts": ["api.video.example", "*.api.video.example"], "via": ["abroad"] },
      { "hosts": ["*.cdn.example"], "via": ["direct", "abroad"] }
    ]
  }
}
```

- **The first rule whose hosts match applies,** and its `via` lists the routes in the order to try them. `direct` is one route. A pattern `*.example.com` matches the subdomains of `example.com`, not `example.com` itself.
- **A host that matches no rule goes direct.** The layer is never a global proxy: the cloudflared tunnel to the control plane, the media listeners, and every other connection of the machine never see it, and without an `egress` section the node's requests are exactly what they were.
- **A rule without `direct` sends its hosts only through proxies,** which is what region-limited content needs: when every proxy it lists fails, the request fails instead of going direct. A rule that lists `direct` too moves to the next route when one fails before a response.
- **A malformed section stops the node at startup** ([`rules.js`](../../../../service/node/src/egress/rules.js)): a route that names no proxy, a proxy called `direct`, or a host pattern with a scheme or path. A typo must not send traffic another way.

### Proxy providers

Proxy providers are a plugin type. A node entry registers one with `yolo.registerProxyProvider(id, { endpoint(options, { refused }) })`, and a proxy in `egress.proxies` names it as `provider`. `endpoint` returns where the proxy is now, `{ url, username?, password?, expiresAt? }` with an `http://` or `https://` URL (credentials may also sit in the URL), and handles the provider's own sign-in. A provider never learns which requests or hosts use it.

- **The node asks again** shortly before `expiresAt` (60 seconds), after the proxy answers 407 to the credentials it gave (once, with `refused: true`), and 30 seconds after a provider had no endpoint; it asks once at a time per proxy. A plugin that fails to start takes its providers away with it.
- **Yolo ships one generic official provider, [`plugins/proxy-url`](../../../../plugins/proxy-url/src/node.js),** which registers `url`: a fixed proxy whose URL, credentials included, is in the environment variable that the proxy's `options.env` names. It is in the catalog of `plugins/official.json` but never loaded by default; an owner turns it on in Settings › Plugins or lists it in `yolo.config.json`, and since it can only load at start, turning it on waits for the node's restart. Its directory names no provider, so `scripts/provider-names.js` lists it with the template as a plugin that gives none.
- **Providers for commercial accelerator services are local plugins, not official ones.** Such a service hands out an endpoint only through a private API that changes without notice, its terms may forbid third-party clients, and its device limits can sign the owner out of another session when the node signs in. An owner who accepts that loads their own provider through `yolo.config.json` ([plugin architecture](2026-10-11-plugin-architecture.md)), or copies an endpoint the service's own client shows into `proxy-url`'s variable. Yolo ships no code tied to one service.
- **SOCKS proxies are not supported yet:** an endpoint with a `socks5://` URL is refused with that message.

### Every egress path follows the rules

- **The node's own requests** go through the layer's `fetch()`: the media pipeline's upstream reads (`upstream.js`, `hedge.js`, and its byte-range reads), frames and storyboards (`frames.js`), and the sound AI subtitles read (`audio.js`). A proxied route uses undici's `ProxyAgent` with the endpoint's credentials as `Proxy-Authorization`.
- **Plugins** get `yolo.fetch`, the same function, for their own requests to a source; the yt-dlp plugin uses it for Bilibili's part list, danmaku, subtitles, mirror probes, and DRM checks.
- **Child processes get a proxy on loopback, not the proxy itself.** When the owner has rules, the node starts an HTTP proxy on `127.0.0.1` at a free port ([`listener.js`](../../../../service/node/src/egress/listener.js)) that applies the rules to each connection it opens: HTTPS arrives as `CONNECT` and is tunnelled direct or through the proxy's own `CONNECT`, and a plain-HTTP request is sent over a connection opened the same way. It accepts only loopback peers. Plugins get its address from `yolo.egressProxy()`, null without rules; the yt-dlp plugin passes it as `--proxy` on every run, so yt-dlp's requests to hosts no rule matches still go direct. ffmpeg gets it as `-http_proxy` for an input whose host has a rule that is not only `direct`. No credential appears in a command line, which Node's `execFile` copies into its error messages.

### Credentials and status

- Credentials live in environment variables documented by `.env.example`; `yolo.config.json` names a variable at most. No log line or error carries a proxy's credentials or address: proxies are named by their config names, and an error from a proxied route has the endpoint's username, password, and authorization header removed.
- A failed route logs a warning with the host and route, and a tunnel the loopback proxy opens logs its host and route at debug level. A provider's first endpoint, its renewals, and its failures are logged with the proxy's name and provider.
- `/internal/v1/health` has `egress`: the number of rules, whether the loopback proxy listens, and each proxy's provider and status (`ready`, `idle` before its first use, `unavailable` with the provider's error, or `no_provider` when no loaded plugin registered it), never its endpoint. `npm run yolo -- doctor` fails a proxy with no provider and warns about an unavailable one.

### Scope

Only the node-to-source leg changes. The device's paths, through the control plane's tunnel and by [LAN direct play](../feature/2026-10-12-lan-direct-play.md), are unchanged, and so is Plex.

## Deferred

**Routes in hedging and host health.** Direct and proxied are two routes to the same bytes, so a later change would treat each pair of a URL and a route as one candidate: the node's memory of hosts (`hosts.js`) would keep faults and throughput per host and route, and a hedged segment read would race these candidates under the existing thresholds and bounds, with no rule depending on the time of day. Today a rule's routes are tried in the order it lists them, and a route that fails moves the request to the next one. The work starts when telemetry shows that the remaining stalls happen while every mirror is slow: the devices' `stall_start` events in Workers Logs ([device telemetry](../feature/2026-10-11-device-telemetry.md)) line up, by the UTC timestamp on each node log line, with node hedges that find every mirror of the segment slow. A proxied route would then pay its extra first-byte latency against the 1.5-second hedge threshold, and a hedge across two routes could read the same bytes twice against a paid allowance.

## Alternatives considered

**A system-wide VPN or TUN client in global mode.** It needs no change to Yolo, but it would route the cloudflared tunnel to the control plane, and everything else the machine sends, through the proxy's region, so every device's media and every control-plane request to the node would take that detour too.

**Retrying only yt-dlp through a proxy when a site answers with a region error.** It would cover one source and only its extraction, depend on each site's wording of the error, and leave the node's own requests and ffmpeg's reads without a way to reach a region-limited host.

**The whole egress layer as a plugin.** Rules decide the route of the pipeline's own upstream reads, hedging included, and of the child processes the node starts, so the hook has to be in the core whatever implements it; what differs between services is only where a proxy is and how to sign in to it, which is what a provider plugin holds. The rules name hosts and proxies from the owner's config, never a provider, so the core still names none.

**Passing the proxy's URL to yt-dlp and ffmpeg directly.** It would put the credentials in a command line and in `execFile`'s error messages, and send every request of the child process through the proxy, including those to hosts no rule matches.

## Consequences

An owner reaches region-limited content by adding a provider plugin and a rule that lists only hosts the region limits, usually the site's playback API, while its media servers stay direct and full speed; nothing changes for an owner without rules. A provider for any service is a small plugin that only hands out endpoints, and the generic `proxy-url` covers any fixed proxy.

The costs:

- A local provider runs with the node's full rights, `.env` and `NODE_SECRET` included, under the plugin trust model, and breaks whenever its service's private API changes. While a proxy has no endpoint, a host whose rule also lists `direct` goes direct, and content behind a proxy-only rule does not play.
- Any process on the machine can send through the loopback proxy, and a plugin that calls the global `fetch` instead of `yolo.fetch` bypasses the rules.
- yt-dlp sends every request through the loopback proxy whenever the owner has rules, one more local hop for hosts that go direct.
- A request whose body is a stream tries only its first route.
- Proxied bytes may count against a paid allowance, and playing region-limited content through a proxy can conflict with the source's terms.
- A site may answer a proxied page with media hosts that only its region reaches, which the node, fetching media direct, cannot read; the source's plugin then has to choose hosts that answer from anywhere, as the yt-dlp plugin does for Bilibili ([Bilibili through the egress rule](../feature/2026-10-27-bilibili-through-the-egress-rule.md)).

The tests in [`service/node/test/egress.test.js`](../../../../service/node/test/egress.test.js) pin the rules, the provider's endpoint lifecycle (one ask reused, a renewal before expiry, one more after a 407), that a proxy-only host never goes direct, that the loopback proxy tunnels matched hosts through the proxy and every other host direct, that no log line carries a password, and that plugins register providers and fetch through the layer.
