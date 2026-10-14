# Agent Note: D1 数据模型

Status: implemented

[English](2026-10-07-d1-data-model.md) | 中文

## 问题

Yolo 的持久状态——设备、队列、播放列表、历史、音轨偏好——从之前单进程服务的本地 SQLite 数据库和 JSON 文件搬到了 Cloudflare D1。Yolo 现在只服务一个用户本人，但以后可能有家庭成员或其他用户，事后再给每张表加归属列，就意味着迁移每一行数据。在之前的服务里，历史还会无限增长。

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
| `media_settings` | 用户本人的媒体路径开关：`relay`、`relay_accepted_at`（用户本人接受中转警告的时间）和 `remote`；没有这一行表示两个都关（迁移 `0006`，它让迁移之前已有的用户保持中转打开；[媒体流离开 Worker](2026-10-13-media-off-the-worker.zh.md)） |
| `image_links` | agent 拿到的封面图片链接所用的密钥版本，以及上次重置的时间 `reset_at`；没有这一行表示版本 1（迁移 `0007`；[封面图片](../feature/2026-10-07-remote-mcp-server.zh.md#cover-images)） |

OAuth 客户端、授权和 token 不在 D1 里：`@cloudflare/workers-oauth-provider` 把它们存在 `OAUTH_KV`，token 和密钥只存哈希，`props` 加密存储。播放状态存在 Hub Durable Object 自己的存储里。局域网直连播放的状态（节点的域名和地址记录、证书的日期，以及 ACME 账号私钥）是一个 KV 值 `yolo:lan`（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。用户本人的配对码只在节点内存里；迁移 `0002` 删掉了以前的 `init_codes_used` 表。迁移 `0003` 把 0.1 的数据行改写成插件的 Source（例如 `url:<规范化后的 URL>` 键变成 `ytdlp:<规范化后的 URL>`）。

### 跨发布的迁移

**每个迁移都必须能和上一个发布的代码一起工作。** 迁移可以新增表、带默认值的列或索引；删除或改写上一个发布仍在读取的内容的步骤，要等代码不再读取它之后，再晚一个发布交付。因此升级先执行迁移，再重启节点、部署 Worker，中间旧 Worker 在新 schema 上运行，回退回到上一个发布的代码时不动 D1。迁移做不到这一点的发布，在变更日志条目里标明 `rollback: restore`，回退它时经用户本人批准，用升级前的备份恢复 D1（[版本与发布](../process/2026-10-13-versions-and-releases.zh.md)）。`npm run yolo -- migrate` 在执行任何迁移之前，先把数据库导出到 `.yolo/backups/`，并记录一个 Time Travel 书签。

## 曾考虑的替代方案

**只按单用户设计，不带 `user_id`。** 现在加一列几乎没有成本；以后再补，就是对每张表做一次数据迁移。

**历史不设上限。** 500 条足够找回最近看过的内容，又不会无限增长。

## 后果

以后支持多用户不需要迁移 schema，历史也保持小巧。每个查询都必须按 `user_id` 过滤，每次 schema 变更都是一个新迁移，写成能和上一个发布的代码一起工作，并在依赖它的代码部署之前用 `npm run yolo -- migrate` 应用。把状态分在 D1（持久记录）、KV（OAuth）、Hub 的存储（播放状态）和节点内存（配对码）四处，能让每类数据待在符合其生命周期和访问方式的地方，代价是要到四个地方去找。
