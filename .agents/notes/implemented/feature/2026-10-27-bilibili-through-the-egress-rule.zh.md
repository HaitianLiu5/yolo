# Agent Note: B 站页面走出口规则，媒体走 upos

Status: implemented

[English](2026-10-27-bilibili-through-the-egress-rule.md) | 中文

## 问题

有些 B 站番剧只在中国大陆播放，用户的付费账号也一样。从节点所在的网络访问，这类剧集的页面和 B 站的播放信息接口都会拒绝（`-10403`，“抱歉您所在地区不可观看”）。[出口代理层](../architecture/2026-10-13-node-egress-proxy.zh.md)可以把 `www.bilibili.com` 经中国的代理发出，这样能通过页面的地区检查，yt-dlp 接着读取页面里内嵌的播放信息。

可是 B 站给中国观众内嵌的播放信息里，很多文件的地址是大陆的 CDN 节点：`*.mcdn.bilivideo.cn:8082` 和 `*.edge.mountaintoys.cn:4483` 上的 P2P CDN 节点。按出口层的设计，节点直接下载媒体，而这些节点在国外不给首字节或者超时。2026-10-27 这条规则生效时，不只番剧，所有热门 B 站视频在 Apple TV 和 Chrome 上都卡住了，于是规则被删掉，番剧仍然受地区限制。

当天从家里的节点测得：

- 经中国线路取得的 9 个热门视频的播放信息里，所有主地址都在大陆 CDN 节点上，每个文件都附带一个 B 站 upos CDN（`upos-sz-*.bilivideo.com`）上的备用地址。
- upos 备用地址从美国访问返回 `206`。在中国签发的地址放到插件本来就在测速的 upos 镜像（`upos-sz-mirrorcosov`、`-mirrorali`、`-mirrorhw`）上也能下载，`mountaintoys` 的地址换到 upos 主机上同样能下载。
- `mcdn` 的地址是为它自己的主机签名的（查询参数里写着 `os=mcdn`），换到 upos 主机上返回 `403`，留在原处则很慢或者没有响应。
- yt-dlp 只保留每个文件的主地址，丢掉备用地址，所以插件从来拿不到一个可达的地址。

## 决策

yt-dlp 插件带上第二个 yt-dlp 扩展 [`yt-dlp/yolo/yt_dlp_plugins/extractor/yolo_bilibili.py`](../../../../plugins/source-ytdlp/yt-dlp/yolo/yt_dlp_plugins/extractor/yolo_bilibili.py)，和让腾讯视频给 H.264 的那个一样，每次运行都以 `--plugin-dirs` 加载（[腾讯体育回放](2026-10-26-tencent-sports-replays.zh.md)）。它只在一处覆盖 yt-dlp 的 B 站视频和番剧解析器：在 yt-dlp 把播放信息变成格式之前，主地址不在 upos 主机上的文件，改用它的第一个 upos 备用地址作主地址。于是 yt-dlp 的格式都是 upos 地址，插件的镜像测速像对待任何 B 站视频一样给 upos 镜像排序（[`mirrors.js`](../../../../plugins/source-ytdlp/src/mirrors.js)）。

- **它对每个 B 站页面都生效，不论是否经代理。** 从节点自己的网络访问，主地址本来就是 upos 或 Akamai 主机，所以那里什么都不变；没有 upos 备用地址的文件保留原来的主地址。
- **用户的规则只写 `www.bilibili.com`。** 这个主机只提供页面，从不提供媒体；B 站的接口（`api.bilibili.com`）、upos CDN 和插件读取的剧集列表都直连（[接下来播放](2026-10-23-up-next.zh.md)）。

## 曾考虑的替代方案

**把大陆 CDN 节点也经代理发出。** 这样每个文件都能按 B 站给的地址播放，但每个 B 站视频的每个字节都要经过代理，又慢，又可能占用付费流量，而这正是出口层要避免的绕路。

**由插件把每个大陆 CDN 地址换到 upos 主机上。** 这对 `mountaintoys` 的地址有效，它们的路径和签名就是 upos 的；但 `mcdn` 的地址是为它自己的主机签名的，换到别处会被拒绝。只有 B 站自己给的备用地址靠得住，而只有 yt-dlp 能看到它们。

**用 JavaScript 读取 B 站的播放信息，不经 yt-dlp。** 这样不用 Python 也能保留备用地址，但要移植 yt-dlp 的 B 站解析器（登录、番剧和视频两类、它们的格式），并独自跟着更新。

## 后果

用户的出口规则里有 `www.bilibili.com` 时，受地区限制的番剧可以按账号的最高画质从 upos 镜像播放，其他 B 站视频照常播放，只是页面改经代理读取。

代价：

- yt-dlp 读取的每个 B 站页面都经过代理，稍慢一些，而且依赖代理可用：代理没有可用地址时，所有 B 站视频都解析不了。
- 扩展依赖 yt-dlp 的 B 站解析器用保留着 `backupUrl` 或 `backup_url` 的播放信息调用 `extract_formats`，所以升级 yt-dlp 时如果这一点变了，开着规则就可能再次卡住。插件的测试检查的是扩展每次运行都被加载，而不是 B 站返回什么。
- 播放信息里没有 upos 备用地址的文件，仍会卡在大陆 CDN 节点上。
