# Agent Note: Yolo 这个名字和它的地址

Status: implemented
Archived: 2026-10-13

[English](2026-10-07-yolo-name-and-addresses.md) | 中文

## 问题

Drive-In 成为一个更大服务的客户端之一后，这个服务需要自己的名字、npm scope、MCP 服务名，以及用户本人实例的地址。用户本人用中英文混说的方式通过语音和 agent（智能体）交流，所以名字必须经得住语音识别；地址也不只是门面：passkey 和 OAuth issuer 都绑定在它上面。

## 决策

服务叫 **Yolo**。官网是 `useyolo.app`，只做宣传；npm 包用 `@useyolo/*` scope；MCP 服务名和插件命名空间都叫 `yolo`。Claude Code 等 agent 工具把自动批准设置叫作「YOLO mode」，所以工具和服务的描述里写明 Yolo 是媒体服务。

用户本人的控制面部署在 **`yolo.haitian.site`**（MCP 地址 `https://yolo.haitian.site/mcp`），这是个人域名，和之前 Drive-In 的 `drivein.haitian.site` 一样。其他人运行 Yolo 时部署到各自的域名。`service/control/wrangler.jsonc` 里的 `PUBLIC_ORIGIN` 是 OAuth issuer、token 的 audience，也是 passkey 的 relying party；改了它，所有 passkey 都会失效。

`useyolo.app` 注册在用户本人的 Cloudflare 账号下，到期日 2027-10-10，没开自动续费。

### 命名标准

名字要比「drivein」短，一看就像科技产品，并且在中英文混说时能被可靠识别。为满足最后一条：没有常见的同音词（例如 Claude 被识别成 cloud）；至少两个音节，以元音结尾；不依赖很多南方口音分不清的 n/l；不能是用户本人下指令时会用到的词。Yolo 满足所有条件：所有语音识别器的词表里都有它，「人生只活一次」的意思也贴合娱乐服务。商标不在考虑范围内，因为这是私人服务。

## 曾考虑的替代方案

**Homecue 或 Cue。** cue 和 queue 同音，而「队列」是核心概念。

**Nod。** 和 not 几乎同音。

**Kudo、Remo、Beamo、Nemo、Dobby。** 都符合标准；名字定为 Yolo。

**其他域名。** 2026-10-08 通过 Cloudflare Registrar 查询：`heyyolo.app`、`yoloplay.app`、`yolotv.app` 可以注册，`yolo.app`、`yolo.ai`、`useyolo.com` 已被注册；npm 上 `@yolo` 已被占用，`@useyolo` 可用。

**把控制面放在 `useyolo.app`、`app.useyolo.app` 或 `api.useyolo.app` 上。** 用户本人把根域名留给宣传网站，把这个私人实例放在个人域名下，这样每个 Yolo 部署都在其主人自己的域名上。

## 后果

这个名字适合语音，但它和 agent 工具里的「YOLO mode」撞名，每个工具描述都要专门说明；它还和一个著名的目标检测模型同名，官网很难排上搜索结果。把用户本人的实例换到别的地址，就要重新注册所有 passkey，并重新授权所有 agent。除非用户本人续费，`useyolo.app` 会在 2027-10-10 过期。
