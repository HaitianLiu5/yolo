# Agent Note: 确认 Cloudflare 对代理视频的条款

Status: proposed

[English](2026-10-07-cloudflare-video-terms.md) | 中文

## 问题

不在家时，Yolo 播放的每个媒体字节都经过 Cloudflare：节点经 cloudflared tunnel 和 Workers VPC 把它送到 Worker，再由 Worker 转发（[同源透传](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.zh.md)、[Workers VPC](../../implemented/architecture/2026-10-08-workers-vpc-node-access.zh.md)）。在家时，[局域网直连播放](../../implemented/feature/2026-10-12-lan-direct-play.zh.md)从节点的局域网源提供媒体，这个源的名字是一条 Cloudflare 不代理的仅 DNS 记录；屏幕在家里只有在这条路径关闭或失败时才走 tunnel。所以待定的问题只涉及不在家时的媒体。

Cloudflare 的 CDN 条款要求通过它的付费服务（Developer Platform、Stream 等）提供视频。按字面理解，经付费 Worker 代理比直接走 Tunnel 更站得住，但没有找到针对 Tunnel 的官方说明，2026-09 版条款对经 Worker 代理视频也没有写清楚。现在用着没问题，不代表条款允许。

## 提案

在 Yolo 1.0 公开并推荐给其他用户之前，用户本人确认条款是否允许经 Worker 代理视频。如果不允许，不在家时的媒体需要一个 Cloudflare 不代理的公网源，就像在家时的局域网源那样；具体用哪个源仍然待定。媒体 URL 是可以替换的：路径里的媒体 token 授权请求，不依赖 Worker，所以同一个 URL 可以由另一个源提供，局域网源提供的就是同样的 `/m/{token}/…` 路径。

## 曾考虑的替代方案

**因为现在能用就继续依赖它。** 能用不等于允许；条款需要用户本人确认。

## 验收标准

用户本人根据 Cloudflare 的条款或 Cloudflare 的答复记录一个决定，相关记录和 README 随之更新。如果不允许经 Worker 代理，在 1.0 公开之前，一条 Cloudflare 不代理的、不在家时使用的媒体路径要能在车上播放全部四种流类型。

## 风险

局域网直连播放只覆盖家庭网络。不经 Cloudflare 为不在家时的播放提供媒体，需要另一个公网源，而那又会带回家里机器对外暴露的问题。条款在决定之后可能变化，所以 Cloudflare 每次更新条款时都需要重新审视。
