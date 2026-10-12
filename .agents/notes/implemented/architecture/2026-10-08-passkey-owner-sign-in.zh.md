# Agent Note: 用户本人用 passkey 和节点签发的配对码登录

Status: implemented

[English](2026-10-08-passkey-owner-sign-in.md) | 中文

## 问题

Yolo 只有一个人类用户，即用户本人；批准 agent（智能体）或配对屏幕之前，用户本人必须先登录。门槛要高：媒体节点在家庭网络里，能替控制 Yolo 的人抓取任意 URL。控制面的地址写在公开仓库里，谁都能找到登录页，并尝试猜出用来建立第一个凭据的那个秘密。passkey 全部丢失时也必须能找回，但不能有攻击者也能利用的网页找回流程。

## 决策

用户本人**只用 passkey** 登录。第一个 passkey，以及 passkey 全部丢失后的重置，都需要一个**家里节点签发的 6 位数字配对码**：

1. 在家里机器上，`npm run owner-code` 向运行中的节点申请一个码并打印出来。
2. 用户本人在 15 分钟内到 `/login` 输入它，创建 passkey。

配对码由节点签发和校验，只存在节点内存里；Cloudflare 从不保存它。码 15 分钟过期，错 5 次作废，只能用一次；重新申请会替换旧码，节点重启就没了。控制面用 `POST /internal/v1/owner-code/verify` 检查配对码（错了算一次尝试，但不消耗它），在 passkey 校验通过之后、保存之前用 `POST /internal/v1/owner-code/consume` 用掉它。

已有 passkey 时用配对码注册就是**重置**：新 passkey 保存后，删掉其他所有 passkey，撤销所有网页登录会话。没有网页找回，只能在家里机器上重置。已登录时添加 passkey 不需要配对码。节点离线时配对码用不了，`/login` 会提示先启动节点。

签发配对码只能在本机进行。`POST /local/v1/owner-code` 不在节点的 TCP 端口上：它挂在节点的 Unix socket 上（默认是仓库根目录的 `.yolo-node.sock`，权限 0600，可用 `NODE_LOCAL_SOCKET` 修改），请求同样要用 `nodeSecret` 签名（[`service/node/src/local.js`](../../../../service/node/src/local.js)、[`owner-code.js`](../../../../service/node/src/owner-code.js)）。签名区分不了请求来自用户本人还是控制面：控制面持有 `nodeSecret`，还会把公网上的 `/m/*` 请求转给节点；但 cloudflared 和 Workers VPC 只能连 TCP 地址，所以控制面和公网都没法签发配对码。

## 曾考虑的替代方案

**管理密码。** passkey 看一眼（Face ID）就能登录，抗钓鱼，也没有可以泄露的密码。

**Cloudflare Access。** 它需要 Zero Trust 后台配置，而 passkey 不需要。

**存在 Worker secret（`OWNER_INIT_CODE`）里的一次性长初始化码**，一直用到 2026-10-11。每次找回都要轮换这个 secret，而且码存在 Cloudflare 里。

**另开一个回环 TCP 端口签发配对码。** 只有在 tunnel 永远不指向它的前提下才同样安全；Unix socket 则根本无法通过 tunnel 访问。

**更长的码。** 6 位数字够用，就像微信输入法的配对码，因为唯一的暴露窗口是第一次注册前那一小段时间，而找回又必须在家里机器上做。正因为地址是公开的，过期、5 次上限和一次性这几条限制必须有。

## 后果

登录就是一次 passkey 验证，建立用户本人身份的秘密从不存放在 Cloudflare 或仓库里。找回需要能实际操作家里的机器，并且节点在运行。重置只撤销 passkey 和网页会话；agent 的 token 和设备凭据不受影响（[OAuth](2026-10-07-oauth-authorization-server.zh.md)）。passkey 绑定在 `PUBLIC_ORIGIN` 上，所以[迁移实例](../process/2026-10-07-yolo-name-and-addresses.zh.md)就意味着重新注册它们。
