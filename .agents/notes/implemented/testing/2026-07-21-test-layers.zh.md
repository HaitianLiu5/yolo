# Agent Note: 三层测试与车上检查

Status: implemented

[English](2026-07-21-test-layers.md) | 中文

## 问题

Yolo 的行为横跨纯粹的策略（Hub、配对、清晰度决策）、真实的边界（HTTP 请求体、D1 schema、WebCodecs），以及经过 Worker、媒体节点、ffmpeg 和浏览器的完整流程。全靠端到端证明一切的测试集又慢又不稳定；只证明单元的测试集又会漏掉衔接处。测试还运行在用户本人家里的机器上，就在线上媒体节点旁边，绝不能碰它的状态、它的端口、Cloudflare、YouTube 或 Plex。有些条件——真实的特斯拉渲染器、移动网络、Cloudflare 路径——在本地根本无法复现。

## 决策

Yolo 有三层测试，各司其职：

- **单元测试**（`*/test/unit`、服务和插件 workspace 的 `test/*.test.js`，以及 `ops/test` 和 `scripts/provider-names.test.js`）：坏了也不会有人察觉的约定——认证、配对、媒体 token 和签名、迁移、片源插件的 `prepare()`、节点的监听端口，以及 AGENTS.md 里的规则，例如单飞的 HLS 预取。它们不依赖 ffmpeg、浏览器或网络。
- **集成测试**（`clients/player/test/integration`、`service/control/test/integration`）：每个测试一个真实边界，例如 HTTP 请求体、WebCodecs 编排，或基于真实服务层和 D1 schema 的 `/v1` API，外部依赖通过注入提供。
- **端到端测试**（`test/e2e`）：真实的整套系统——媒体节点，以及在 `wrangler dev --local` 下运行的控制面，使用生成的配置、本地 D1 和 KV，没有固定端口，不向 Cloudflare 发送任何东西——播放器作为 Worker 的静态资源提供。启动整套系统要花几秒，所以每个需要它的文件只启动一套，并在上面按顺序跑完自己的流程。`car-playback.test.js` 让 Chromium 以车的类型通过设备码流程配对，用 canvas 引擎经 `/m/*` 播放四种流类型（`direct`、`hls`、`dash_split`、`plex`），播放由 agent（智能体）通过 MCP 发起；它还检查车机的默认排版、控制、清晰度变化、恢复、队列、撤销、Plex 的字幕和字幕稿，一辆以浏览器类型配对的特斯拉仍然用 canvas 引擎播放、唤醒后在 welcome 之前先显示它保存的那个条目的加载屏幕，然后静音播放直到第一次点击，以及一个在条目中途失败的解码器不请求新流就地恢复，和一个反复失败的解码器逐级走到新的流（[canvas 引擎](../architecture/2026-04-04-canvas-playback-engine.zh.md)）。`web-playback.test.js` 通过浏览器的 `<video>` 元素播放同样四种流类型（[两个引擎](../architecture/2026-10-12-two-playback-engines.zh.md)），用返回离开一个条目，重新加载后在 welcome 和 Yolo 的历史到来之前先显示它保存的首页和正在播放栏，再从正在播放栏接着播放，用户本人的 passkey 配对，并把用户本人设置放在它之后。`media-paths.test.js` 先从回环地址上节点的局域网监听端口、再从远程监听端口播放，用的是 Chromium 映射到那里的域名，以及 openssl 为节点自己的证书请求签发的证书，并在同一位置依次退回下一条路径，最后退回中转（[媒体流离开 Worker](../architecture/2026-10-13-media-off-the-worker.zh.md)）。`ai-subtitles.test.js` 播放一个条目，它的 AI 字幕由官方语音插件经一个代替用户语音服务的替身生成；节点上需要用 ffmpeg 读声音的 AI 字幕检查也放在这里（[AI 字幕](../feature/2026-10-18-ai-subtitles.zh.md)）。`ask-voice.test.js` 用语音提问：用 Web Audio 做的麦克风代替浏览器的，因为 Chrome 自己的假麦克风在 macOS 上会卡在系统麦克风权限上；录音经官方语音插件交给一个替身语音服务，再交给一个复述所问内容的 agent 插件（[语音输入](../feature/2026-10-18-agent-from-the-screen.zh.md#voice-input)）；车机的麦克风在车里检查。媒体用 ffmpeg 生成；yt-dlp 和 Plex 是本地 fixture（测试前置数据，`test/e2e/fixtures.js`）。

一条断言应该放在能证明该行为的最低一层。端到端层只保留更低层证明不了的流程：每种流类型配每个引擎、车机布局、特斯拉无论类型如何都用 canvas 引擎、局域网直连播放及其回退、配对、passkey、MCP，以及返回后的续播。单元测试已经覆盖的规则不再有端到端副本。

**规模。**测试集刻意保持精简：2026-10-18 按 [`yolo-test-audit`](../../../skills/yolo-test-audit/SKILL.md) 删掉了 80% 以上，每条约定只在最强的边界上保留一个负责它的测试；[`yolo-testing`](../../../skills/yolo-testing/SKILL.md) 为一次改动挑选证明。新测试先扩充已保留的测试，再考虑新增文件；更强的测试替换更弱的。已保留的测试或车上检查已经覆盖的窄回归——实时连接的竞态、排版几何、节点的 ffmpeg 退路——没有单独的测试。流程等待它需要的事件，而不是等一段固定时间；必须走网络的跳转要越过浏览器已经缓冲的部分。

**隔离。**测试从不使用仓库的运行时状态：节点在临时目录下拿到 `YOLO_RUNTIME_DIR` 和自己的 socket，并设置 `YOLO_ENV_FILE=""`，不加载 `.env`。网络测试使用本地源或注入的传输。测试不共用端口，不访问 YouTube、Plex、Let's Encrypt 或 Cloudflare API，不依赖正在运行的 Yolo 节点，也从不针对线上节点的运行时目录或它的 9191 端口运行。测试会导入的 `service/control/src` 模块不导入 `cloudflare:workers`（只有 `index.js` 和 `hub/hub.js` 可以），所以它们在纯 Node 下也能测试。

**命令。**`npm run test:unit`、`npm run test:integration` 和 `npm run test:e2e`（缺少 `dist/` 时会先构建 `clients/player`）分别运行各层；`npm run check` 运行文档门禁，构建客户端和 Worker，再运行全部三层。端到端测试需要 ffmpeg 和能解码 H.264 的 Chrome：Google Chrome 或 Chrome for Testing，因为 Playwright 自带的 Chromium 播放不了车机的流。设置 `YOLO_E2E_WEBKIT=1` 后，`<video>` 引擎的流程还会在 Playwright 的 WebKit（Safari 的引擎）里运行；`PLAYWRIGHT_WEBKIT_EXECUTABLE` 指定 Playwright 自带版本以外的 WebKit。`PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定要启动的 Chromium 或 Chrome 程序（默认在装有 Google Chrome 的 Mac 上用它，否则用 Playwright 自带的 Chromium）；`YOLO_E2E_LOG` 设置端到端测试中媒体节点的日志级别（默认 `warn`）。

**CI** 在每次推送到 `main` 和每个 PR 上，用 Node 22 和 24 运行 `npm run check:core`。端到端测试在单独的 workflow 里跑，每个测试文件各占一台 runner 同时跑，用 runner 自带的 Google Chrome，ffmpeg 用固定版本、校验过哈希的静态二进制，不走 apt 镜像；只改碰不到整套服务的东西（Markdown、翻译记录、Agent Notes、skills、文档检查脚本、Apple 客户端、一致性测试套件或其他 workflow）的改动会跳过它们。事件循环清空时，如果某个测试的 promise 仍未完成，Yolo 支持的最低 Node 版本（22）的测试运行器会取消这个测试，连同同一文件里剩下的测试，所以测试不能依赖一个 unref 过的定时器来完成；要在本地复现 CI 最低版本的那个任务，就用 Node 22 运行该文件（例如 `npx -y node@22 --test <file>`）。

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
| 用 `?decodeErrorAt=<秒>` 打开播放器，时间略超前于要播到的位置，再加上 `&decodeErrorCount=4` 打开一次 | 一次：`decoder_recovery` 停在第 1 步，`outcome: "recovered"`，没有新的流，声音一直在播。四次：第 1 到 3 步 `failed`，第 4 步 `requested`，然后在当前位置有一条新的流 |

通过标准：没有任何状态无限循环（缓冲、断开、重连）；恢复按 1、3、10、30、之后 60 秒的退避进行，没有重试风暴；恢复后 HLS 预取的待处理工作清空，同时只有一个下载；只有至少两个吞吐样本支持时，才会上报 `bandwidth_insufficient`；清晰度变化遵循[自适应策略](../feature/2026-10-11-adaptive-quality.zh.md)；设备的事件里能看到 `stall_start`、恢复、一次新的流请求和 `playback_recovery_stable`（[设备埋点](../feature/2026-10-11-device-telemetry.zh.md)）。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 后果

大部分行为可以快速、确定地得到证明，端到端层则用真实媒体、真实的 Worker 运行时和真实的浏览器证明各部分的衔接，而且不需要凭据或网络。负载较高时，浏览器端到端测试仍是最慢、最不稳定的一层。精简后的测试集拦下的窄回归更少，更多要靠评审和车上检查。硬件、行驶中的车载网络，以及真实的 YouTube、Bilibili 和 Plex 账号仍需要车上检查；测试全部通过并不能证明它们。
