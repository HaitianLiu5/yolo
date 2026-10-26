# Agent Note: Yolo 的客户端协议

Status: implemented

[English](2026-10-19-client-protocol.md) | 中文

## 问题

一块屏幕要做什么才算 Yolo 的屏幕，过去是由它唯一的实现——浏览器播放器——定义的。各个部分记在几篇 note 里（[/v1](../../implemented/architecture/2026-10-07-v1-http-api.zh.md)、[Hub 和实时通道](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md)、[设备码配对](../../implemented/feature/2026-10-07-device-code-pairing.zh.md)、[能力协商](../../implemented/architecture/2026-10-07-capability-negotiation.zh.md)、[媒体流离开 Worker](../../implemented/architecture/2026-10-13-media-off-the-worker.zh.md)），但没有地方说明过客户端必须实现哪些、可以省掉哪些、怎么找到服务器、怎么知道服务器已经往前走了。播放器和 Worker 一起发布，所以从来不需要知道这些。原生客户端按自己的节奏发布（[Apple TV 客户端](../../proposed/feature/2026-10-19-apple-tv-client.zh.md)），而第三方协议不是答案（[Jellyfin 插件，已否决](../../rejected/feature/2026-10-11-jellyfin-protocol-plugin.zh.md)）。

## 决策

Yolo 的**客户端协议**是一份公开、带版本的约定，每块屏幕都实现它，包括浏览器播放器。各部分仍归各自的 note；这篇 note 负责部分清单、版本、客户端可以省掉什么、发现服务器，以及一致性测试套件。

### 各个部分

| 部分 | 客户端做什么 | 归属 |
|---|---|---|
| 发现 | 找到服务器地址，用 `GET /.well-known/yolo` 确认 | 见下文 |
| 配对 | OAuth 设备授权：显示配对码，轮询拿到设备凭据，遇到 `4003` 或凭据被拒时忘掉它 | [设备码配对](../../implemented/feature/2026-10-07-device-code-pairing.zh.md) |
| HTTP | 设备凭据能调用的 `/v1` 路由，以及错误格式 | [/v1](../../implemented/architecture/2026-10-07-v1-http-api.zh.md) |
| 实时 | 一张票据、一条 WebSocket、带能力的 `hello`、报告、`ended`、`error`、`network` 和心跳 | [Hub 和实时通道](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md) |
| 媒体 | `load` 里的流描述，每个 URL 都相对它的 `origin` 解析；welcome 列出的媒体路径，按顺序探测，并以服务器的源地址作为 `Origin`：浏览器自己会带，原生客户端要自己设置，因为以 IP 地址相称的媒体源只对这个源地址回答探测 | [媒体流离开 Worker](../../implemented/architecture/2026-10-13-media-off-the-worker.zh.md) |

**必须和可选。** 客户端必须处理 `welcome`、`load`、`pause`、`resume`、`seek`、`stop`、`tracks`、`deactivate`、`media`（重新探测自己的路径，路径变了就报告 `network`），在用的路径上播放失败（换到下一条能用的路径，在同一位置重建，如[媒体流离开 Worker](../../implemented/architecture/2026-10-13-media-off-the-worker.zh.md)所要求），以及它要显示的广播，必须遵守保护 Hub 的实时规则（`HEARTBEAT_PING` 一字不差、不回应广播、被限流后至少退避 30 秒），还必须在 welcome 之后补上断掉的连接吞掉的东西：welcome 的 `commands` 点名的暂停、继续和跳转，屏幕上的流能就地切换时 welcome 的 `state.tracks` 里的字幕，以及自己没被听到的 `ended` 和 `idle`（[失效的连接吞掉的消息](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md#what-a-dead-connection-takes)）。不这样做，agent（智能体）发进一条死连接的暂停就丢了，agent 却被告知成功，屏幕的下一次报告还会把它覆盖掉。客户端可以省掉 `danmaku`、`keep`、`/v1/agent` 和遥测；Hub 本来就能服务忽略它们的客户端。

### 版本

`@useyolo/core` 里的 `CLIENT_PROTOCOL`（`service/core/src/protocol.js`）是一个整数，客户端在 `hello` 里以 `protocol` 发送。`/.well-known/yolo` 提供 `clientProtocols`（`CLIENT_PROTOCOLS`），即 Hub 服务的每个版本号，客户端在配对前检查它。上一版客户端跟不上的改动会让它升一级，就像节点的 `NODE_PROTOCOL`（[版本和发布](../../implemented/process/2026-10-13-versions-and-releases.zh.md)）；Hub 同时服务当前和前一个版本号。服务一个版本号就要保留它的形状：Hub 记下每条实时连接的 `hello` 所给的版本号，按它和这条连接说话；客户端在每个 `/v1` 请求里用 `Yolo-Protocol` 头（`CLIENT_PROTOCOL_HEADER`，播放器的 `api.js` 会加上）带上自己的版本号，形状变了的路由对给出前一个版本号的客户端用旧形状回答（没有这个头的请求算作第一个版本号）。还没有形状变过，所以 Worker 还不读这个头。所以升一级时，旧形状和新形状并存一个版本，之后才去掉。每个客户端都发送 `protocol`，包括浏览器播放器。`clientProtocols` 和客户端没有共同的版本号时，客户端立即说明，在配对前或下次启动时：比所有版本号都旧的客户端告诉用户本人去哪里更新，比所有版本号都新的客户端说明服务器需要升级。Hub 不再服务的已配对客户端会收到一个只带 `upgrade: true` 和 `clientProtocols` 的 welcome，随后连接关闭；原生客户端显示同样的提示，而不是播到一半出错，升级前打开的浏览器标签页则重新加载，最多一分钟一次（`main.js`），并且一分钟内不再重连（`realtime.js`），这样重新加载被推迟的标签页不会耗掉 Hub 的连接额度。没有 `protocol` 的 `hello` 来自早于这套协议的页面，算作它的第一个版本号。那个页面不认识 `upgrade: true`，所以 Hub 不再服务第一个版本号后，会用 1008 关闭这种连接（一个 hello 得到这三种处理中的哪一种，由 `helloProtocolAction()` 决定），也就是那个页面本来就遵守的限流关闭：它等 30 秒再试，而不是在一条它跟不上的通道上继续播放，直到用户本人重新加载它。

### 发现

用户本人只用一个地址给客户端配对，别的都不需要：实例的域名，没有域名时就是它的 workers.dev 主机名。客户端读取 `https://<地址>/.well-known/yolo`，确认 JSON 回答里的 `name` 是 `"Yolo"`（`/.well-known/yolo` 现在就这样回答），并且 `clientProtocols` 里有自己能讲的版本，然后在那里开始配对。在家里的网络上，媒体节点用 Bonjour 广播 `_yolo._tcp`，TXT 记录只有一个键 `origin`，值是 UTF-8 编码的控制面源地址（`origin=https://yolo.example.com`，不带路径和末尾斜杠）：`PUBLIC_ORIGIN`，没有时就是它的局域网或远程监听允许的页面源地址。由操作系统的响应程序发布（`service/node/src/bonjour.js`）：macOS 上是 `dns-sd`，Linux 上是 `avahi-publish`；其他系统上或没有这个命令时，节点什么都不广播，`BONJOUR=0` 则关掉它。节点每分钟检查一次源地址，变了或命令退出了就重新发布。客户端像检查输入的地址那样检查它，所以家里的电视不用打字就能找到地址。网络上任何人都能广播 `_yolo._tcp`，别人运行的服务器也可以不经用户本人就批准自己的配对码，所以客户端只有在用户本人看到完整显示的主机名并按一下确认之后，才用发现的地址开始配对；配对界面在二维码旁边再显示一次主机名。用户本人的 passkey 只在用户本人自己的域名上登录，所以别人广播的服务器永远拿不到用户本人的批准。除了设备凭据，客户端只保存这个地址。

### 客户端不带任何内容

客户端不带片源、不带目录，也不带任何提供方的名字、标志或 URL：它显示的每个标题、图片和流都来自它配对的服务器，就像禁止提供方名字的规则让 `service/` 保持中立一样。这样客户端就是用户本人自己服务器的播放器，和其他媒体服务器的客户端一样。

### 一致性测试套件

一致性测试套件（[`test/conformance/`](../../../../test/conformance/)）是一个用 Node 写的脚本化控制面，通过真实协议对真实客户端运行一组场景，用 `npm run test:conformance` 运行。它像 Yolo 那样回应屏幕会调用的接口（`/.well-known/yolo`、设备授权、实时通道的 ticket 和通道本身、`POST /v1/playback/play`），像 Hub 的自动回复那样回应精确的心跳，并像节点的 LAN 监听那样从第二个源提供一段短片，探测只回应服务器自己的源。因为它就是服务器，它能按需做真实 Hub 永远不会做的事：把一条命令记为已发送却丢掉它（就像死掉的连接吞掉它那样），然后掐断连接；用 `1008` 关闭或回答 `429`；撤销设备。每条必须的消息和规则各有一个场景（每个命令、各种广播、客户端该发的报告、心跳和退避），播放器里出过问题的情况也各有一个：配对、点名要恢复的流的 welcome、随断掉的连接丢失的暂停、跳转和字幕、`load`、`deactivate`、拿走正在用的路径的 `media` 消息、播放中途断掉的路径、限流、`4003` 关闭，以及服务器已不再服务的客户端协议版本。针对客户端选做部分（比如弹幕和自适应码率）的场景，只证明它把选做的部分做对了。

它检查客户端发出的消息；对于不需要回应的消息（`stop`、`deactivate`、广播），检查客户端显示了什么：被测客户端回答套件的状态查询，只有调试构建才带这个钩子。调试构建在启动时拿到套件的地址，在实时通道之外单独和它的 `/debug` 保持一条 WebSocket，这样配对之前和 `4003` 关闭之后查询都能到达客户端；套件在那里发送 `{ "v": 1, "type": "debug_state" }`，客户端在这条连接上回答 `{ v: 1, type: "debug_state", screen, sessionId, paused, position, subtitles, active, shown }`：`screen`，即它显示的是 `"pairing"`、`"update-client"`、`"update-server"` 还是 `"ready"`，正在播的流的 `sessionId`（没有则为 null）、是否暂停、以秒计的位置、屏幕上每条字幕轨的 id（没有则为空数组）、是不是当前设备，以及 `shown`，即它显示的 `state`、队列、播放列表和设备，保持 Hub 发来时的形状。客户端可以为自己的选做部分加字段，比如 Apple TV App 加了 `danmaku: { enabled, available, onScreen }`。发布构建不打开调试连接。套件在每个场景开始时用 `YOLO_CONFORMANCE_LAUNCH` 里的命令重新启动客户端，`{url}` 替换为套件的地址；这条命令要先结束客户端的上一个进程。没有设置它时场景会被跳过，所以在没有客户端的机器上 `npm run check` 照样通过。`YOLO_CONFORMANCE_KIND` 是客户端配对时的设备类型，不设置时是 `tv`（[iPhone 和 iPad 客户端](../../proposed/feature/2026-10-23-iphone-and-ipad-client.zh.md)用 `phone`）。Apple TV App 通过 `-YoloConformanceURL` 拿到这个地址，并把这次配对只放在内存里（[Apple TV 客户端](../../proposed/feature/2026-10-19-apple-tv-client.zh.md)）。

## 推迟的部分

**让浏览器播放器接受套件的检查。** 播放器还没有调试连接，所以套件现在只能对原生客户端运行，在一台带模拟器的 Mac 上手动运行；等播放器的调试构建带上这个连接，浏览器播放器会在 `npm run check` 里跑它，原生客户端则在自己的 CI 里跑它。

## 曾考虑的替代方案

**把播放器当参考实现。** 第二个客户端要去逆向 `player.js` 和它的测试，而且一个客户端的假设变了，另一个也无从得知。

**第三方协议**，例如 Jellyfin 的（[已否决](../../rejected/feature/2026-10-11-jellyfin-protocol-plugin.zh.md)）。它的客户端永远显示不了 Yolo 与众不同的东西，agent（智能体）对它们的控制也只到每个 App 肯听的程度。

**由 schema 生成的协议（OpenAPI、Protocol Buffers）。** 对一个只有几十个路由、大约二十种消息的 API，它给每个客户端都加了生成器和构建步骤；各归属 note 里的 JSON 形状加上一致性测试套件，检查的是同样的东西。

## 后果

- **原生客户端能在配对前检查服务器，也能知道服务器什么时候往前走了**，不必和 Worker 一起发布。一致性测试套件用必须的部分来检验一个客户端；在浏览器播放器接入它之前，播放器由它自己的测试来证明。
- **公开的约定会拖慢播放器。** 上一版跟不上的实时改动，现在要升协议版本、所有原生客户端都要更新；所以大多数改动改为只做新增。
- **套件只证明它写进脚本的东西。** 断线后的恢复在播放器里修了很多次，套件漏掉的场景，在其他每个客户端里都没有测试。
- **Bonjour 只到得了家里的网络**，有些网络还会屏蔽组播；离家时由用户本人输入地址。它还依赖系统的响应程序：没有 Avahi 的 Linux 节点什么都不广播。

core 的测试固定了 Hub 对哪些 hello 服务、要求升级或关闭；节点的测试固定了广播；端到端测试从 `/.well-known/yolo` 读取 `clientProtocols`。
