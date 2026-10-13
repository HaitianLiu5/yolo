# Agent Note: D1 数据模型

Status: implemented

[English](2026-10-07-d1-data-model.md) | 中文

## 问题

Yolo 的持久状态——设备、队列、播放列表、历史、音轨偏好——从 Drive-In 的本地 SQLite 数据库和 JSON 文件搬到了 Cloudflare D1。Yolo 现在只服务一个用户本人，但以后可能有家庭成员或其他用户，事后再给每张表加归属列，就意味着迁移每一行数据。Drive-In 的历史还会无限增长，已有数据也必须一起带过来。

## 决策

控制面的 D1 数据库（`yolo`，binding `DB`）保存 Yolo 的持久状态，并且**每张表都带 `user_id`**，尽管 v1 只有一个用户。schema 在 [`service/control/migrations/`](../../../../service/control/migrations/) 里；已应用的迁移从不修改，改动就加一个编号递增的新文件。

| 表 | 内容 |
|---|---|
| `users`、`passkeys` | 用户 id 和显示名；passkey 凭证（credential id、公钥、签名计数） |
| `devices` | id、`user_id`、名称、类型（`car`、`browser`、`phone`、`tv`、`other`；迁移 `0005` 加了 `other`）、能力描述、最后在线时间 |
| `device_codes` | 配对中的码（只存设备码的哈希）、短码、设备名称和类型、状态（`pending`、`approved`、`denied`、`consumed`）、发起和过期时间（迁移 `0004`） |
| `device_tokens` | 配对过的设备凭据（只存哈希）、所属设备、创建和最后使用时间；随设备一起删除（迁移 `0004`） |
| `nodes` | id、`user_id`、地址、密钥哈希、版本 |
| `queue_items` | 队列条目，`source` 存为 JSON |
| `playlists`、`playlist_items` | 播放列表及其条目，`source` 存为 JSON |
| `history` | source key、标题、进度、时长、播放次数、更新时间；只保留最近 500 条 |
| `track_preferences` | source key 和选中的音轨；`default` 行记录最近一次的选择 |

OAuth 客户端、授权和 token 不在 D1 里：`@cloudflare/workers-oauth-provider` 把它们存在 `OAUTH_KV`，token 和密钥只存哈希，`props` 加密存储。播放状态存在 Hub Durable Object 自己的存储里。局域网直连播放的状态（节点的域名和地址记录、证书的日期，以及 ACME 账号私钥）是一个 KV 值 `yolo:lan`（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。用户本人的配对码只在节点内存里；迁移 `0002` 删掉了以前的 `init_codes_used` 表。迁移 `0003` 把 0.1 的数据行改写成插件的 Source（例如 `url:<规范化后的 URL>` 键变成 `ytdlp:<规范化后的 URL>`）。

### 导入 Drive-In 的数据

[`scripts/drive-in-export`](../../../../scripts/drive-in-export/export.js)（`npm run export:drive-in`）把 Drive-In 的 SQLite 数据库（只读打开）和历史 JSON 导出成插件 Source 格式的 SQL，再用 `wrangler d1 execute` 导入。`export.js` 开头的注释给出了三条命令：在 D1 里查出用户 id，在家里机器上导出，用 `wrangler d1 execute yolo --remote --file …` 导入。导入不会丢掉 Yolo 自己的数据：历史按更新时间保留较新的一行，Yolo 自己的音轨选择优先，队列和播放列表沿用 Drive-In 的 id，重复导入不会多出行。Drive-In 不记录 Plex 条目的进度（它交给 Plex 记），所以导入后这些条目从 Plex 自己的 `viewOffset` 续播。

## 曾考虑的替代方案

**只按单用户设计，不带 `user_id`。** 现在加一列几乎没有成本；以后再补，就是对每张表做一次数据迁移。

**历史不设上限。** 500 条足够找回最近看过的内容，又不会无限增长。

## 后果

以后支持多用户不需要迁移 schema，历史也保持小巧。每个查询都必须按 `user_id` 过滤，每次 schema 变更都是一个新迁移，要在依赖它的代码部署之前用 `wrangler d1 migrations apply` 应用。把状态分在 D1（持久记录）、KV（OAuth）、Hub 的存储（播放状态）和节点内存（配对码）四处，能让每类数据待在符合其生命周期和访问方式的地方，代价是要到四个地方去找。
