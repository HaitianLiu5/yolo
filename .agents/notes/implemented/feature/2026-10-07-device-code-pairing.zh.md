# Agent Note: 扫码配对屏幕

Status: implemented

[English](2026-10-07-device-code-pairing.md) | 中文

## 问题

车机屏幕需要自己的凭据，但在上面输密码不方便，车机没有摄像头，跨源隔离的播放器页面也用不了弹窗登录（[canvas 引擎](../architecture/2026-04-04-canvas-playback-engine.zh.md)）。任何基于码的配对都会招来设备码钓鱼：有人可能在自己的设备上发起配对，再骗用户本人批准。屏幕还必须能被立即移除，而特斯拉浏览器已经不再表明自己是特斯拉。

## 决策

新屏幕用 OAuth 2.0 设备授权流程（RFC 8628）配对。`workers-oauth-provider` 没有实现它，所以由控制面在 [`service/control/src/auth/device.js`](../../../../service/control/src/auth/device.js) 中实现，码和凭据存在 `store/pairing.js`，客户端一侧在 [`clients/tesla/src/pairing.js`](../../../../clients/tesla/src/pairing.js)：

1. 设备发送 `POST /oauth/device_authorization`（表单或 JSON；`client_id` 随意，另有 Yolo 的 `device_name` 和 `device_kind`），得到 `device_code`、`user_code`（`XXXX-XXXX`，只用辅音字母 `BCDFGHJKLMNPQRSTVWXZ`）、`verification_uri`、`verification_uri_complete`、`expires_in: 600` 和 `interval: 5`。它把 `verification_uri_complete` 显示成二维码，并显示短码作为备用。用户本人还没注册 passkey 时，请求被拒绝。
2. 用户本人用手机扫码，打开 `/device?code=…`，需要时先用 passkey 登录。确认页醒目显示设备自报的名称、类型、发起时间和短码；下面可以改这台设备在 Yolo 里的名称和类型（车、浏览器、手机、电视、其他，默认是设备自己猜的），并且必须点**允许**。确认只接受同源提交。
3. 设备按给定间隔轮询 `POST /oauth/token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`），按 RFC 8628 收到 `authorization_pending`、`slow_down`、`access_denied` 或 `expired_token`。批准后，它只收到一次自己的**设备凭据** `{ access_token: "ydt_…", token_type: "Bearer", device_id }`。码只能用一次，10 分钟过期。
4. 批准时就用用户本人选的名称和类型创建设备记录；之后的 `hello` 不会覆盖它们，改名用 `PATCH /v1/devices/:id` 或 `rename_device` 工具。凭据长期有效，D1 只存它的哈希（`device_tokens`），每次请求都查 D1（`resolveExternalToken`），所以撤销立即生效。它的权限是一台播放设备需要的：三个 `/v1` scope 和实时通道票据；它不能用 `/mcp`，也不能改名或删除设备。它的实时连接绑定到它自己的设备，`hello` 不能冒充别的设备。
5. 撤销：`DELETE /v1/devices/:id` 或 `remove_device` 工具删除设备和它的凭据，Hub 用关闭码 4003 断开它的连接，屏幕回到配对画面。

授权服务器元数据里写明了 `device_authorization_endpoint` 和设备码授权类型。

### 猜测设备名称和类型

设备自己猜的结果只是确认页上的默认值。从软件 2026.26 起，特斯拉浏览器发送的是 Linux 桌面 Chrome 的 user agent，不带「Tesla」，请求来自「Cisco IoT」网络，所以单看 user agent 认不出车。[`clients/tesla/src/device-fingerprint.js`](../../../../clients/tesla/src/device-fingerprint.js) 先看 user agent（旧软件带 `Tesla`、`QtWebEngine` 或 `QtCarBrowser`），否则按屏幕打分：`devicePixelRatio` 在 1.45–1.65（2 分）、`innerWidth` 700–850（2）、`innerHeight` 520–680（2）、`screen.width` 1150–1400（1）、`screen.height` 700–870（1）、`visualViewport.scale` 约等于 1（1）、`innerWidth / screen.width` 在 0.55–0.68（2；特斯拉自己的界面占了约 38% 的宽度）、屏幕宽高比 1.50–1.68（2），以及桌面 Chrome（1）。满分 14 分，9 分以上算车（「Tesla」，`car`），否则是「Browser」/`browser`。阈值和信号参考了社区项目 teodorstavrov/Tesla-Waze-4（`src/lib/browser.ts`）。用户本人的车上测得 `innerWidth` 773、`innerHeight` 601、DPR 1.53、屏幕 1254×784，得满分。全屏模式下宽度和宽度比都对不上，得分可能低于阈值；得分明细在 `env` 事件里上报（[设备埋点](2026-10-11-device-telemetry.zh.md)），以便按真实数据调整规则（[提案](../../proposed/feature/2026-10-11-tesla-detection-from-car-telemetry.zh.md)）。

## 曾考虑的替代方案

**只显示短码、手动输入。** 扫码在任何设备上都省去了打字；车机没有摄像头，所以由车上显示、手机来扫。短码仍作为在 `/device` 手动输入的备用方式。

**在车机屏幕上登录。** 在那里输密码不方便，播放器页面也用不了弹窗登录。

## 后果

配对只需扫一次码、点一下，防钓鱼靠的就是确认页本身：醒目显示设备信息、10 分钟有效且只能用一次的码，以及明确的「允许」。设备凭据不会过期，也不轮换，只能通过移除设备来撤销，这对只有一个用户、几台自己设备的场景够用。认车靠启发式规则，可能把屏幕标错，所以名称和类型由用户本人在批准时决定。
