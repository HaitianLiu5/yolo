# Agent Note: 三层测试与车上检查

Status: implemented

[English](2026-07-21-test-layers.md) | 中文

## 问题

Yolo 的行为横跨纯粹的策略（Hub、配对、清晰度决策）、真实的边界（HTTP 请求体、D1 schema、WebCodecs），以及经过 Worker、媒体节点、ffmpeg 和浏览器的完整流程。全靠端到端证明一切的测试集又慢又不稳定；只证明单元的测试集又会漏掉衔接处。测试还运行在用户本人家里的机器上，就在线上媒体节点旁边，绝不能碰它的状态、它的端口、Cloudflare、YouTube 或 Plex。有些条件——真实的特斯拉渲染器、移动网络、Cloudflare 路径——在本地根本无法复现。

## 决策

Yolo 有三层测试，各司其职：

- **单元测试**（`*/test/unit`、服务和插件 workspace 的 `test/*.test.js`，以及文档门禁自身的测试 `scripts/*.test.js`）：确定性的策略和状态转换——Hub、设备配对流程、片源插件的 `prepare()`、面对本地 HTTP 源的媒体管线。它们不依赖 ffmpeg、浏览器或网络。
- **集成测试**（`clients/player/test/integration`、`service/control/test/integration`）：每个测试一个真实边界，例如 HTTP 请求体、WebCodecs 编排，或基于真实服务层和 D1 schema 的 `/v1` API，外部依赖通过注入提供。
- **端到端测试**（`test/e2e`）：真实的整套系统——媒体节点，以及在 `wrangler dev --local` 下运行的控制面，使用生成的配置、本地 D1 和 KV，没有固定端口，不向 Cloudflare 发送任何东西——播放器作为 Worker 的静态资源提供。Chromium 通过设备码流程配对，并经 `/m/*` 播放四种流类型（`direct`、`hls`、`dash_split`、`plex`），播放由 agent（智能体）通过 MCP 发起，两个播放引擎都要覆盖：以车的类型配对时用 canvas 引擎，以 Yolo Web 配对时用浏览器的 `<video>` 元素（[两个引擎](../architecture/2026-10-12-two-playback-engines.zh.md)）。浏览器还从回环地址上节点的局域网监听端口播放，用的是 Chromium 映射到那里的域名，以及 openssl 为节点自己的证书请求签发的证书（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。媒体用 ffmpeg 生成；yt-dlp 和 Plex 是本地 fixture（测试前置数据，`test/e2e/fixtures.js`）。

一条断言应该放在能证明该行为的最低一层；端到端测试覆盖完整的流程，不重复单元测试的每个边界情况。

**隔离。**测试从不使用仓库的运行时状态：节点在临时目录下拿到 `YOLO_RUNTIME_DIR` 和自己的 socket，并设置 `DRIVEIN_ENV_FILE=""`，不加载 `.env`。网络测试使用本地源或注入的传输。测试不共用端口，不访问 YouTube、Plex、Let's Encrypt 或 Cloudflare API，不依赖正在运行的 Yolo 节点，也从不针对线上节点的运行时目录或它的 9191 端口运行。测试会导入的 `service/control/src` 模块不导入 `cloudflare:workers`（只有 `index.js` 和 `hub/hub.js` 可以），所以它们在纯 Node 下也能测试。

**命令。**`npm run test:unit`、`npm run test:integration` 和 `npm run test:e2e`（缺少 `dist/` 时会先构建 `clients/player`）分别运行各层；`npm run check` 运行文档门禁，构建客户端和 Worker，再运行全部三层。端到端测试需要 ffmpeg 和 Chromium（或 Google Chrome）。设置 `YOLO_E2E_WEBKIT=1` 后，`<video>` 引擎的流程还会在 Playwright 的 WebKit（Safari 的引擎）里运行；`PLAYWRIGHT_WEBKIT_EXECUTABLE` 指定 Playwright 自带版本以外的 WebKit。`PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定要启动的 Chromium 或 Chrome 程序（默认在装有 Google Chrome 的 Mac 上用它，否则用 Playwright 自带的 Chromium）；`YOLO_E2E_LOG` 设置端到端测试中媒体节点的日志级别（默认 `warn`）。

**CI** 在 Node 22 和 24 上运行 `npm run check:core`。事件循环清空时，如果某个测试的 promise 仍未完成，Yolo 支持的最低 Node 版本（22）的测试运行器会取消这个测试，连同同一文件里剩下的测试，所以测试不能依赖一个 unref 过的定时器来完成；要在本地复现 CI 最低版本的那个任务，就用 Node 22 运行该文件（例如 `npx -y node@22 --test <file>`）。

<a id="in-car-checks"></a>

### 车上检查

路由和播放相关的改动还要在车上用受影响的流类型检查一遍：`hls`、`direct`、`dash_split` 或 `plex`，确认播放器能加载和配对、跳转正常、音画保持同步。播放或网络相关的改动之后，再做一次故障检查，覆盖本地自动化无法复现的部分：真实的特斯拉渲染器、移动网络、Cloudflare 路径和家里的节点一起工作。先播放一个固定 720p60 的 YouTube 或 Bilibili 视频，然后逐个制造故障，每次等播放稳定后再做下一个：

| 故障 | 预期 |
|---|---|
| 让车断网 30 秒 | 已缓冲的视频尽量继续播放；恢复后在原位置附近接着播，不刷新页面 |
| 断网 60 秒 | 卡顿持续 8 秒后，设备的事件上报 `bandwidth_insufficient`（可用与所需的 kbps）或 `network_unstable`；重试间隔上限保持在 60 秒 |
| 断网 180 秒 | 页面保持响应，内存保持有界；网络恢复后重新解析片源 |
| 从 Wi-Fi 切换到 LTE 或另一个热点 | 丢弃旧的 CDN 和会话 URL，新的流从保存的位置续播 |
| 播放时重启媒体节点 | 过期的会话返回 `410`，播放器建立新的流，而不是对过期 URL 一直重试 |

通过标准：没有任何状态无限循环（缓冲、断开、重连）；恢复按 1、3、10、30、之后 60 秒的退避进行，没有重试风暴；恢复后 HLS 预取的待处理工作清空，同时只有一个下载；只有至少两个吞吐样本支持时，才会上报 `bandwidth_insufficient`；清晰度变化遵循[自适应策略](../feature/2026-10-11-adaptive-quality.zh.md)；设备的事件里能看到 `stall_start`、恢复、一次新的流请求和 `playback_recovery_stable`（[设备埋点](../feature/2026-10-11-device-telemetry.zh.md)）。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 后果

大部分行为可以快速、确定地得到证明，端到端层则用真实媒体、真实的 Worker 运行时和真实的浏览器证明各部分的衔接，而且不需要凭据或网络。负载较高时，浏览器端到端测试仍是最慢、最不稳定的一层。硬件、行驶中的车载网络，以及真实的 YouTube、Bilibili 和 Plex 账号仍需要车上检查；测试全部通过并不能证明它们。
