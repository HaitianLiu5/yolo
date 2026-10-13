# Agent Note: Yolo Web：带设置页的浏览器客户端

Status: implemented

[English](2026-10-11-yolo-web-client.md) | 中文

## 问题

车上的播放器曾是 Yolo 唯一的屏幕。在电脑或手机上，用户本人无法浏览片库、在浏览器里播放，也不能把浏览器当作车上播放的遥控器。也没有设置页：撤销 agent（智能体）只能手动删除它在 `OAUTH_KV` 里的记录，passkey 和设备只能通过 `/v1` 和 MCP 管理；车的显示大小是首页最下面一排百分比按钮，在 Mac 上显示的档位毫无意义（100%、77%、68%……）。

## 决策

### 一个应用，两种 profile

车上的屏幕和 Yolo Web 是同一个应用，即播放器（[`clients/player`](../../../../clients/player)），在站点根路径下以一份打包提供，其中的 [`player.js`](../../../../clients/player/src/player.js) 驱动两个播放引擎（[两个引擎](../architecture/2026-10-12-two-playback-engines.zh.md)）。[`profile.js`](../../../../clients/player/src/profile.js) 选择 profile，并写到 `<html data-profile>` 上：

| | `car` | `web` |
|---|---|---|
| 何时 | 用户本人为这台设备选的类型是「car」；Yolo 还没告诉页面类型时，[特斯拉指纹](2026-10-07-device-code-pairing.zh.md)匹配 | 其他所有类型：电脑或手机的浏览器 |
| 显示大小 | 在设置里提供（[显示大小](2026-10-11-display-size.zh.md)） | 没有：用浏览器自己的缩放 |
| 引擎 | canvas 引擎 | 被特斯拉指纹认出的页面用 canvas 引擎；其他情况用浏览器的 `<video>` 元素，只能跑 canvas 引擎时用 canvas 引擎 |
| `hello` 里的能力描述 | `CAR_CANVAS_CAPABILITIES` | 被特斯拉指纹认出的页面为 `CAR_CANVAS_CAPABILITIES`；其他情况为带浏览器编码的 `WEB_NATIVE_CAPABILITIES`，`maxHeight` 按显示屏取 2160、1440 或 1080（`displayMaxHeight`）；用 canvas 引擎时为 `WEB_CANVAS_CAPABILITIES`；两个引擎都不能用时为 `REMOTE_CAPABILITIES`（[能力协商](../architecture/2026-10-07-capability-negotiation.zh.md)） |
| 点一个条目 | 在本机播放 | 在正在播放的地方播放（见下文） |
| 配对 | 二维码优先 | 用户本人的 passkey 优先，配对码作为从另一台设备批准的方式 |

用户本人选的类型（配对时选，或之后在设置里改）在 profile 上优先于指纹（布局、显示大小，以及点一下在哪里播放），并记住供下次打开使用；类型改变时，布局立即跟着变。被特斯拉指纹认出的页面，引擎不由类型决定：这样的页面总是用 canvas 引擎播放，并声明 `CAR_CANVAS_CAPABILITIES`，所以类型无法在这一点上纠正指纹的误判（[两个引擎](../architecture/2026-10-12-two-playback-engines.zh.md)）。其他页面上，类型改变后引擎从下一个流开始改变，能力描述从下一次连接开始生效。应用每个页面上的 COOP/COEP 和自动播放规则（浏览器不让出声时静音播放，并提示「Tap for sound」）在两种 profile 下都保持；canvas 渲染只属于车。

### 各种窗口尺寸下的布局

- **车上**，CSS 视口约 773×601、像素比 1.53，默认显示大小下页面按 946 像素宽排版。行的上方是一条细的页头（Yolo 标志、搜索、设置）；设置以面板形式盖住窗口右侧三分之二（`min(620px, 66cqw)`）。浏览器窗口在车机应用栏的上方结束，所以不需要避让它（[设计原则](../architecture/2026-07-13-in-car-design-principles.zh.md)）。
- **电脑上**是同样的行，边距更宽，搜索框居中、最宽 560 像素，设置是从右边缘滑出的面板（`clamp(380px, 42cqw, 560px)`），正在播放栏悬浮、最宽 960 像素。
- **手机上**（640 像素及以下）只显示标志不显示文字，设置铺满整个窗口，设备选择器是底部面板，正在播放栏只显示设备名；各行把操作放到文字下方，而不是挤压文字。

### 点一下在哪里播放

由 [`play-target.js`](../../../../clients/player/src/play-target.js) 决定。车在自己身上播放：它就是车里人面前的那块屏幕。Yolo Web 像 Spotify Connect 一样在正在播放的地方播放：如果正在播放或暂停的是另一台在线设备，就在那台设备上播，这样当遥控器用的手机或电脑不会意外把播放抢过来；别处没有在播时，在这个浏览器里播。不能播放的浏览器把这一下交给上一次播放的设备，或者唯一一台在线的其他设备；有好几台时，由用户本人选一台。

### 遥控器

另一台设备在播放时，首页显示正在播放栏（[`remote.js`](../../../../clients/player/src/remote.js)）：条目、「Playing on」哪台设备、根据 Hub 的 `position` 和 `positionAt` 推算的进度线、后退 10 秒、播放/暂停、队列下一项，以及用 `PUT /v1/playback/device` 切换播放设备的设备选择器；这个浏览器能播放时，也可以切到它自己。所有命令都用这台设备的凭据走 `/v1`；正在播放栏只读取 Hub 的 `state`、`queue` 和 `devices` 广播，从不回应它们（[Hub](../architecture/2026-10-07-hub-and-realtime-channel.zh.md)）。

### 搜索

页头的搜索框在用户本人输入时查询 `/v1/library/search`（停顿 300 毫秒后、从两个字符起）；粘贴一个 http(s) 链接时提供 **Play link** 和 **Add to queue**，播放时由片源插件认领它。

### 设置

设置是 `/settings` 上的模态面板（[`settings.js`](../../../../clients/player/src/settings.js)），从首页页头的齿轮打开，分三组：

- **This screen（这块屏幕）**：Yolo 给这台设备的名称和类型、显示大小（仅车上）、**Play over the home network**（通过家庭网络播放）及这块屏幕最近一次探测的结果（[局域网直连播放](2026-10-12-lan-direct-play.zh.md)），以及 **Forget this screen**（`DELETE /v1/devices/self`），解除它的配对。这几项用设备凭据就够了。
- **Your Yolo（你的 Yolo）**：设备（改名，类型用带图标的分段选择；移除）、已连接的 agent（每个 OAuth 客户端一行，可撤销）、passkey（列出、再添加一个、除最后一个外都可移除）、家庭网络的状态（节点的局域网域名、地址和证书，可以立即检查），以及退出登录。它们使用需要用户本人 passkey 会话的[用户本人的路由](../architecture/2026-10-07-v1-http-api.zh.md#owner-routes)，从不使用设备凭据。登录在页面里用现有的 `/auth/passkey/*` 接口跑 WebAuthn，所以播放不会中断；车的浏览器可能用不了 passkey，所以车上还会显示一个二维码，用手机扫码即可在手机上打开这些设置。
- **About（关于）**：版本和提交、媒体节点的状态和版本，以及 `/diag`。

这个面板触屏和键盘都能用：48 px 的触控目标，没有需要悬停的操作，焦点留在面板里，用 Escape、明显的 Close（以及点面板旁边）离开，返回键也会关闭它。破坏性的操作在原地再问一次（「Remove?」），而不是再弹出一个对话框。

### 配对浏览器

浏览器和车一样用设备授权配对（[设备码配对](2026-10-07-device-code-pairing.zh.md)）。在 web profile 下，配对屏幕以用户本人的 passkey 为先：在这个浏览器上已登录（或者在这里登录之后），按一下就能通过 `POST /v1/owner/pairing/approve` 批准这个页面自己的配对码。它仍是同一个只能用一次、10 分钟有效的配对码和同样明确的批准，只是不需要第二台设备；其他网站发不出这个请求（用户本人路由的同源检查）。

### 测试

[`test/e2e/yolo-web.test.js`](../../../../test/e2e/yolo-web.test.js) 覆盖：需要 passkey 会话的用户本人设置（设备凭据和跨站请求都被拒绝；改名、撤销一个 agent、保留最后一个 passkey、退出登录），一个浏览器暂停车上的播放、接过播放再交还，以及用 passkey 配对并在 1440×900 和手机的 390×844 下播放。[`test/e2e/web-playback.test.js`](../../../../test/e2e/web-playback.test.js) 覆盖通过 `<video>` 引擎播放。[`test/e2e/display-scale.test.js`](../../../../test/e2e/display-scale.test.js) 覆盖车机 profile 下的设置和显示大小，以及电脑上没有显示大小。单元测试覆盖 profile、点一下在哪里播放，以及用户本人的路由。

## 曾考虑的替代方案

**为网页客户端做一个设备插件。** 一阶段的两个客户端都是 Yolo 自己的，讲同一套协议，所以实时通道留在核心里；只有一个实现的接口设计不好。

**单独做一个网页应用。** 从 2026.26 版软件起，车的浏览器自称桌面版 Chrome，所以服务器无法把车和电脑分别引到不同的应用；两个应用还会重复外壳、配对和实时通道的代码，并且越走越远。所以改为同一个应用在设备上选择自己的 profile。

**让 `/v1` 认 cookie，这样已登录的浏览器无需配对。** 这会让每个 `/v1` 路由都暴露在跨站请求之下，也打破 [OAuth 服务器](../architecture/2026-10-07-oauth-authorization-server.zh.md)「一种 token」的模型。改为每个浏览器都是一台已配对的设备；用户本人的会话只用于用户本人的设置，以及批准浏览器自己的配对码。

**把用户本人的设置放在服务器渲染的 `/account` 页面上。** 设置必须能在车上作为首页之上的触屏面板使用，而且不离开播放；它们还要显示只有客户端知道的东西（这台设备、它的显示大小）。服务器渲染的页面保留那些必须在设备配对之前就能用的流程：登录、批准配对，以及 agent 的授权确认（[用户本人的网页](../architecture/2026-10-12-owner-web-pages.zh.md)）。

**点一下总是在本机播放。** 当遥控器用的手机只要有人在上面浏览，就会把播放从车上抢走。

## 后果

用户本人可以在电脑或手机上浏览、搜索、播放并控制任何一块屏幕，不碰 `OAUTH_KV` 就能管理设备、agent 和 passkey，只用 passkey 就能配对一个浏览器。车的行为不变：它在自己身上播放，保留 canvas 渲染，显示大小改在设置里。跑不了 canvas 引擎的 iPhone 和 iPad 上的 Safari，用它自己的 `<video>` 元素播放；只有两个引擎都不能用的浏览器才是遥控器。profile 跟随用户本人为设备选的类型，所以被配对成浏览器的车会失去显示大小，直到在设置里把类型改成车；它仍用 canvas 引擎播放（[两个引擎](../architecture/2026-10-12-two-playback-engines.zh.md)）。片源和插件还不能在设置里管理，它们仍在节点上的 `yolo.config.json` 里。
