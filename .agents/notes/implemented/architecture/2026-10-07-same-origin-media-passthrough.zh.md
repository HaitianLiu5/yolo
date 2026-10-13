# Agent Note: 媒体流经同源透传，凭路径 token 授权

Status: implemented

[English](2026-10-07-same-origin-media-passthrough.md) | 中文

## 问题

媒体由家里的节点提供，但播放器运行在只能访问控制面的浏览器里。播放器页面为了 [SharedArrayBuffer 音频时钟](2026-04-04-canvas-playback-engine.zh.md)必须跨源隔离（COOP/COEP），而在 `Cross-Origin-Embedder-Policy: credentialless` 下，跨源请求不带 cookie。原生播放器和在家庭网络里直接从节点取流的设备也不带 cookie。所以媒体需要一个随 URL 本身携带的凭据，以及一条不增加第二层认证的路径。

## 决策

媒体经控制面、在播放器自己的源下到达设备。Worker 在站点根路径用 Workers Static Assets 提供特斯拉客户端（`clients/tesla/dist`，其中 `public/_headers` 加上 COOP/COEP），Yolo 自己的路由列在 `service/control/wrangler.jsonc` 的 `assets.run_worker_first` 里；其他路径都是静态文件或客户端的 `index.html`。[`service/control/src/media.js`](../../../../service/control/src/media.js) 把 `/m/*` 下的 `GET` 和 `HEAD` 请求原样转给节点，只转发字节范围和缓存校验相关的请求头，并原样返回节点的回答，包括 `410 SESSION_EXPIRED`。

媒体 URL 只靠路径里的**媒体 token** 授权，不涉及 cookie，也不涉及节点请求签名：

- Hub 为每个会话签发一个 token：`HMAC-SHA256(nodeKey, sessionId|userId|exp)`。节点在本地校验，不需要回调控制面（[`service/node/src/media/pipeline.js`](../../../../service/node/src/media/pipeline.js)）。
- token 是**路径前缀** `/m/{token}/…`，所以 HLS 清单里的相对 URL 会自动带上它，节点改写的每个 URI 也统一加上这个前缀。
- token 的有效期与会话相同，最长 12 小时（`MEDIA_TOKEN_TTL_SECONDS`）。会话停止后，节点还保留它约 10 秒，因为还没收到下一个 `load` 的播放器可能还在取分片。之后，带这个 token 的请求返回 `410` 和 `X-Yolo-Error-Code: SESSION_EXPIRED`，播放器据此请求新的流。节点不认识的会话（例如节点重启过）也这样回答；伪造的 token 返回 `403`。

在家里的设备也可以改从节点的局域网监听端口取同样的 `/m/{token}/…` 路径，这是页面自身的源之外唯一提供媒体的源；token 在那里以同样的方式授权（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。

`/v1` 上的设备凭据是另一回事：每次请求都查 D1，所以撤销设备立即生效（[设备码配对](../feature/2026-10-07-device-code-pairing.zh.md)）。

## 曾考虑的替代方案

**单独开 `media.` 子域名，直接经 tunnel 提供。** 在 COOP/COEP 下跨源请求不带 cookie，所以它需要自己的凭据方案和 CORP 头，还会给家里的机器多开一个公网入口。媒体经 Worker 同源透传只保留一层认证，播放器代码也不用改。

**Cloudflare Access 加 cookie**（认证方案中媒体的那一半）。原生播放器、跨源请求和局域网直连都不会发送这个 cookie；签名 URL 对它们都适用。

**把 token 放在查询参数里。** HLS 清单用相对 URL 引用分片，相对解析会丢掉查询串；路径前缀在相对解析后仍然保留。

## 后果

经 tunnel 时，播放器、实时连接和每个媒体字节共用一个源，所以页面保持跨源隔离，媒体响应也不需要 CORP，`/m/*` 只由媒体 token 把守。因为媒体 URL 里没有任何东西依赖 Worker，节点的局域网监听端口提供同样的路径，并为页面带上 CORS 和 CORP（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。经 tunnel 的媒体要经过 Cloudflare，因此受 Cloudflare 视频条款的约束（[待定问题](../../proposed/process/2026-10-07-cloudflare-video-terms.zh.md)），在家却不走局域网路径的播放器也要多绕一跳。泄露的媒体 URL 在会话结束或 token 过期之前都能播放。
