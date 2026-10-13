# Agent Note: 统一版本号、打标签发布和协议编号

Status: implemented

[English](2026-10-13-versions-and-releases.md) | 中文

## 问题

Yolo 过去直接从 `main` 持续发布，没有标签，没有变更日志，还有四个互相矛盾的版本号：各个包写着 0.1.0 或 0.2.0，节点上报写死的 0.3.0，README 写的是 0.4。没有任何东西告诉用户本人或替用户本人工作的 agent（智能体）一次升级意味着什么：要执行哪些 D1 迁移，需要哪些 secret 或配置项，节点是否必须重启，回退时是否需要恢复数据库。控制面和节点必须一起部署，但没有编号说明已部署的两半能否互相通信，所以每次升级在 `wrangler deploy` 和节点重启之间都有一段不匹配的窗口期。

## 决策

### 统一版本号

Yolo 只有一个版本号，即根目录 `package.json` 的版本号。每个 workspace 包都使用它，每个对 `@useyolo/*` 包的依赖都固定为它；否则 `ops/test/versions.test.js` 失败。节点在 `/internal/v1/health` 上报它，Worker 在 `/.well-known/yolo` 上报它，设置页面为播放器和节点显示它。`npm run yolo -- release prepare X.Y.Z` 在所有位置设置它并刷新 lockfile。

### 打标签发布和变更日志

一次发布是 `main` 上的一个附注标签 `vX.Y.Z`，外加一个 GitHub Release。[`CHANGELOG.md`](../../../../CHANGELOG.md) 每次发布一节，最新的在前，标题为 `## vX.Y.Z (YYYY-MM-DD)`。正文告诉用户本人改了什么；其中带围栏的 `yolo-upgrade` 块是 JSON，由 `npm run yolo -- upgrade` 读取（[`ops/lib/changelog.js`](../../../../ops/lib/changelog.js)）：

| 字段 | 含义 |
|---|---|
| `protocol` | 该发布的内部协议编号 |
| `migrations` | 该发布新增的 D1 迁移，按名称列出 |
| `secrets`、`settings` | 新的 Worker secret 和节点 `.env` 配置项：`[{ name, required, how }]`；缺少必需项时，升级会停下，直到用户本人提供 |
| `resources` | 新的 Cloudflare 资源或绑定，用文字描述 |
| `node` | 节点有改动时为 `restart`，否则为 `none` |
| `rollback` | `code`：上一个发布可以在本发布的数据库上运行；`restore`：回退时还要用升级前的备份恢复 D1 |
| `human` | 只有人能完成的操作，用文字描述 |

`npm run yolo -- release check` 把当前版本的条目和代码对照：协议编号等于 `NODE_PROTOCOL`，列出的迁移恰好是上一个标签之后新增的那些。维护者的流程在 [`.agents/skills/yolo-release`](../../../skills/yolo-release/SKILL.md)。

### 内部协议

[`service/core/src/protocol.js`](../../../../service/core/src/protocol.js) 里的 `NODE_PROTOCOL` 为[节点内部 API](../architecture/2026-10-07-node-internal-api.zh.md) 的约定编号。控制面在每个发往节点的请求里用 `x-yolo-protocol` 发送它；没有这个请求头的控制面讲的是协议 0。节点接受自己的编号和前一个编号，其他编号一律回答 `node_offline`，并说明双方各自的编号以及该升级哪一边。只有当上一个发布的另一半跟不上改动时，发布才提高编号，而节点在那一个发布期间继续接受前一个编号。

### 改名

跨越分别升级的部件之间边界的名字（请求头、播放列表标签、已安装服务设置的环境变量）分两个发布改名。改名的那个发布发出或写入新名字，同时仍然接受旧名字，或者同时发出旧名字，因为车上的标签页可能连着几天保留旧的播放器，已安装的服务也会保留自己的环境；下一个发布再去掉旧名字。保留旧名字的代码会在原地说明。从最初只给特斯拉用的播放器沿用下来的名字正处于这个状态：预读请求头 `X-Drive-In-Prefetch`（现为 `?prefetch=1`）、直播窗口标签 `#EXT-X-DRIVE-IN-*`（现为 `#EXT-X-YOLO-*`），以及 `DRIVEIN_ENV_FILE`（现为 `YOLO_ENV_FILE`）。

### 升级顺序

因为节点接受前一个协议，且每个迁移都能和上一个发布的代码一起工作（[D1 数据模型](../architecture/2026-10-07-d1-data-model.zh.md)里的规则），升级按这个顺序进行：备份 D1，执行迁移（旧 Worker 照常工作），重启节点（它接受旧 Worker），部署 Worker，运行 `doctor`。回退顺序相反：先 Worker，后节点；只有当某个发布标明 `rollback: restore` 时才恢复 D1，而且必须经过用户本人批准。`npm run yolo -- upgrade` 和 `npm run yolo -- rollback` 执行这些步骤，并先停下来等用户本人批准。

## 曾考虑的替代方案

**每个包一个版本号。** 插件、客户端和各个服务从同一个仓库一起发布，作为一个实例部署；分开的编号只会增加用户本人要对比的东西，四个编号互相矛盾就是这样来的。

**比较版本号而不是协议编号。** 大多数发布不改内部 API，要求版本号相等会禁止每次升级都存在的单边窗口期；协议编号只在兼容性改变时才变。

**接受所有更旧的协议。** 节点就得为过去每个发布保留兼容代码。一个发布的重叠期足以覆盖升级窗口，落后好几个发布的用户本人按变更日志所列逐个升级。

**把机器可读的升级事实放在单独的文件里。** 把这个块放在该发布的变更日志小节里，正文和 agent 据以行动的事实就在同一个经过评审的地方。

## 后果

用户本人的 agent 能从变更日志知道一次升级会做什么，带着事实请求批准；`doctor` 能说出哪一边落后。两半可以先后升级，中间不会出现互相拒绝的窗口期。代价是纪律：每次发布都需要变更日志条目，内部 API 发生不兼容改动时必须提高协议编号，迁移必须写成能和上一个发布的代码一起工作。
