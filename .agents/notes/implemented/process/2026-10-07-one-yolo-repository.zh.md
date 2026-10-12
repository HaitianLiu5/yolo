# Agent Note: 一个仓库，一次性重写

Status: implemented

[English](2026-10-07-one-yolo-repository.md) | 中文

## 问题

把 Drive-In 变成 Yolo，意味着要给项目改名，并把一个服务进程、它的 CLI 和播放器拆成服务、插件和客户端。播放引擎的历史很重要：很多特斯拉相关的细节只因为过去的某次故障才存在，原因只记录在旧提交里。迁移过程中还不能让用户本人在车上没有能用的播放器。

## 决策

- **先拆成服务和客户端。** 协议从一开始就按多台设备、多个客户端设计，早于任何 MCP 工作落地，所以之后改名只是换名字。
- **一次性重写，然后迁仓库。** 代码在 drive-in 仓库里按模块一次性重写到 0.2。从 2026-10-11 起，开发转到公开仓库 [`HaitianLiu5/yolo`](https://github.com/HaitianLiu5/yolo) 继续，它保留了 Drive-In 完整的 Git 历史；drive-in 仓库已归档。
- **一个仓库放下整个 Yolo。** npm workspaces 把服务放在 `service/`（`core`、`plugin-api`、`control`、`node`），官方插件放在 `plugins/`，客户端放在 `clients/`。Drive-In 是 Yolo 的特斯拉客户端（`clients/tesla`），不再是单独的产品或仓库。
- **旧服务最后删除。** 旧的 Drive-In 服务（`server/`）、它的 CLI（`cli/`）以及节点到它的桥接（`node:legacy` 渲染器），已经删除；合并这次删除的条件是新架构通过 `npm run check`，并且四种流类型（`hls`、`direct`、`dash_split`、`plex`）在车上检查过。删除时还把 CLI 从 workspaces、CI、发布工作流、`CODEOWNERS`、PR 模板、README 和 `.env.example` 中去掉，并把 [`skills/drive-in/SKILL.md`](../../../../skills/drive-in/SKILL.md) 改写成 MCP 服务的用法。

### 推迟的事项

`@drive-in/cli` 仍在 npm 上发布，没有弃用说明；用 `npm deprecate @drive-in/cli "Use the Yolo MCP server"` 把它标记为弃用（绝不 `unpublish`）需要用户本人手动执行。删除 `drivein.haitian.site` 的路由和旧服务的 launchd 服务（`com.haitian.drivein.server`）也在仓库之外进行。

## 曾考虑的替代方案

**先只为 Drive-In 做 MCP，以后再拆服务。** 那样到拆分时还要再重写一遍。

**渐进替换（strangler 模式）。** 用户本人选择一次性重写；删除旧服务之前在车上做的检查取代了长期并存。

**等到 1.0 改名时再拆仓库，或让新仓库从干净的初始提交开始。** 从零开始会丢掉 Git 历史里记录的、引擎各种特斯拉专属行为的来由。

**按运行时分目录，或让 Drive-In 留在自己的仓库里作为独立客户端。** 服务、插件和客户端一起演进，放在一个仓库里，一个提交就能同时改好协议的两端；用户本人在 2026-10-11 决定把 Drive-In 并入 Yolo。

## 后果

协议改动、它的服务端、客户端和测试可以在一个提交、一次 `npm run check` 里完成。对任何引擎文件，`git log --follow` 都能追溯到 Drive-In 的历史。仓库是公开的，所以配置示例和记录里绝不能出现密钥。一次性重写把风险集中在一次切换上，车上检查降低了这个风险；剩下的下线步骤取决于用户本人。
