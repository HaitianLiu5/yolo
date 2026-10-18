# Agent Note: 从被回收的 Plex 转码会话中恢复

Status: implemented

[English](2026-09-10-plex-session-recovery.md) | 中文

## 问题

Plex 在 HLS 转码会话空闲 180 秒后把它回收了，而最初只面向特斯拉的播放器还在继续请求它的分片 URL。每个上游 404 都会触发最多 15.75 秒的重试延迟，比浏览器 12 秒的不活动上限还长，所以界面报告的是网络问题，而上游其实在立即返回明确的 404。WebSocket 重连时，只要本地还有播放器就跳过恢复，所以失效的会话一直没有被替换。

## 决策

由转码器提供的流缺失分片时，变成一个带类型的过期，播放器用一个新的流来应对。这个设计横跨 Yolo 的媒体节点和 Plex 片源插件；它与具体片源无关，任何由转码器提供流的片源都可以使用。

- [`plugins/source-plex/src/playback.js`](../../../../plugins/source-plex/src/playback.js) 解读 Plex 的转码清单（`sessionHealth`），作为流描述的 `health()` 提供出来，并把它的 HLS Input 标记为 `transcoder: true`。
- [`service/node/src/media/pipeline.js`](../../../../service/node/src/media/pipeline.js) 负责 `transcoder` Input 缺失分片时的重试预算，在分片或播放列表缺失时询问 `health()`，并把已证实的缺失变成带类型的过期响应。代理从不重新开始播放。节点不持有的会话（节点重启后，或已停止的会话）也这样回答。
- 两个播放引擎都能发现过期（[两个引擎](../architecture/2026-10-12-two-playback-engines.zh.md)）。在 canvas 引擎里，`HlsSegmentPrefetcher` 停止请求已过期的播放列表，并保留带类型的错误；新的播放列表与旧的互不影响。`MediabunnyPlayer` 报告当前会话的过期；暂停时，后台的过期会推迟到请求播放时再处理。`<video>` 引擎（[`engine/native-video-player.js`](../../../../clients/player/src/engine/native-video-player.js)）把 hls.js 收到的 410 当作过期；由于 `<video>` 元素从不报告失败的状态码，元素出错后或等待 8 秒后，它会向节点发一个 `HEAD` 请求，查询这个流，原生 HLS 还会查询它的第一个变体播放列表。
- [`clients/player/src/player.js`](../../../../clients/player/src/player.js) 是重建新会话的唯一负责方：它向 Yolo 请求同一条目的新流（`POST /v1/playback/play`，带 `reason: "recovery"`、位置、播放意图和被替换的会话），由 Yolo 保留音轨选择。重连时，只有当 Hub 仍认为这台设备在播同一个会话，`clients/player/src/main.js` 才复用本地播放器。

### 约定与预算

- 清单或分片缺失，并且成功取得的转码清单证明它已不存在时，返回 HTTP 410、JSON `code: SESSION_EXPIRED`，并在 `X-Yolo-Error-Code` 里带上同样的码。该响应不缓存，控制面原样透传。
- 转码清单无法访问或格式错误时，结果是 `unknown`，而不是过期。一次探测最多 2 秒（算上管线自己的限制是 3 秒）。
- 缺失的分片最多尝试 4 次，延迟依次为 0、250、500 和 1000 毫秒。完整的响应头协商（含探测）有 8 秒预算；缓慢但仍在推进的响应体不会被切断。
- 客户端断开会取消分片请求。

### 测试

单元测试覆盖存活、过期和未知三种状态（`plugins/source-plex/test`）。端到端的 Plex 测试（`test/e2e/car-playback.test.js`）解码 Plex fixture（测试前置数据）提供的真实 HLS，丢掉 fixture 的转码会话，并检查播放器在已播放到的位置拿到新的流。真实 Plex 和特斯拉上的检查与 fixture 测试通过是两回事；已经打开的浏览器页面需要刷新才能拿到新的客户端代码。

## 曾考虑的替代方案

**推测超时时间，或强加一个自定义的会话寿命。** Plex 自己的清单才是权威：[python-plexapi](https://github.com/pkkid/python-plexapi/blob/master/plexapi/server.py) 用 `/transcode/sessions` 查询正在进行的转码，Yolo 复用这个 API，而不是去猜会话何时失效。

**修改 Plex 的全局设置。** 不改任何 Plex 设置；特别是，转码器的节流缓冲并不是会话租约。

**一直重试缺失的分片。** 重试一个明确的 404，只会把失败拖到超过浏览器的不活动上限，并把真正的原因藏在网络错误后面。

## 后果

被回收的转码会变成一次短暂、带类型的恢复，并从已播放到的位置继续，而不是一次被报告成网络不好的卡顿。恢复只有一个负责方，即播放器，所以代理和预取器从不争着重新开始播放。分片缺失时节点会探测 Plex 的转码清单，代价是一次有上限的请求；清单为 `unknown` 时有意继续重试，而不宣布过期。
