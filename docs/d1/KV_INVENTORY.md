# KV 全量盘点

盘点范围是 `worker/` 里对绑定 `DATA` 的读写。生产数据仍在 KV。D1 表只是下一批迁移的目标，本批没有把业务读写切过去。

固定键和模板函数都来自代码检索：`state:`、`system:`、`invite:`、`compiled:`、`share`、`shareidx:`、`sharelimit:`。没有发现另外的 KV 前缀。

客户端后缀 `client` 取自 `clientIdSchema`：`mihomo`、`singbox`、`surge`、`loon`、`quantumultx`、`v2rayn`、`nekobox`、`shadowrocket`、`generic`。

## 总表

| 键 | 写入 | 读取 | 数据形状 | 迁移目标 |
| --- | --- | --- | --- | --- |
| `state:accounts` | `writeAccounts` | `readAccounts` | `accountsSnapshotSchema` | `users`；快照元数据进 `system_settings` |
| `invite:{tokenHash}` | 管理端创建邀请 | 管理端列表、公开邀请查询和兑换 | `inviteRecordSchema`，键本身是令牌哈希 | `invitations`；兑换记录进 `invitation_redemptions` |
| `system:crypto` | `getOrCreateCryptoMaterial` | `readCryptoMaterial`、`getOrCreateCryptoMaterial` | `cryptoMaterialSchema` | 不进 D1。优先 `DATA_ENCRYPTION_KEY` / `SESSION_KEY`，否则仍读此键 |
| `state:catalog` | `writeCatalog` | `readCatalog` | `catalogSnapshotSchema`（写入前升到 schemaVersion 2） | `sources`、`nodes`、`node_raw_variants`、`groups`、`group_sources`、`group_nodes`、`group_node_order`；计数器进 `system_settings` |
| `state:delivery` | `writeDelivery` | `readDelivery` | `deliverySnapshotSchema` | `subscriptions`、`subscription_groups`；计数器进 `system_settings` |
| `compiled:{tokenHash}:{client}` | `compileSubscription` | 公开订阅、管理端订阅视图、分享导出 | `compiledArtifactSchema` | 不进 D1。可再生成的缓存 |
| `state:apps` | `writeApps` | `readApps` | `appsSnapshotSchema` | `apps`、`app_platforms`；计数器进 `system_settings` |
| `state:share-settings` | `writeShareSettings` | `readShareSettings` | `shareSettingsSchema` | `system_settings` 键 `share_settings` |
| `state:share-seq` | `allocateShareId` | `allocateShareId` | `{ next: number }`，`next` 为正整数 | `system_settings` 键 `next_share_id` |
| `share:{tokenHash}` | `writeShare` | `readShare`、`listAllShares` | `shareRecordSchema` | `shares` |
| `shareidx:user:{userId}` | `writeIndex` | `readIndex`、`listIndexedShares` | `tokenHashSchema[]` | 不建表。由 `shares.owner_user_id` 索引代替 |
| `shareidx:sub:{subscriptionId}` | `writeIndex` | `readIndex`、`listIndexedShares` | `tokenHashSchema[]` | 不建表。由 `shares.subscription_id` 索引代替 |
| `sharelimit:{tokenHash}:{minuteWindow}` | `consumeVerifySlot` | `consumeVerifySlot` | 十进制计数字符串，TTL 11 分钟 | `rate_limits`，`bucket = share_verify` |
| `compiled:share:{tokenHash}:{client}` | `loadShareArtifact` | `loadShareArtifact` | `compiledArtifactSchema` | 不进 D1。可再生成的缓存 |
| `state:cron` | `writeCronStatus` | `readCronStatus` | `cronStatusSchema` | `cron_runs`。KV 只留最近一次，表按运行记录追加 |

## 模板函数

这些键由字符串拼接生成，检索时以函数为准。

| 函数 | 模板 | 文件 |
| --- | --- | --- |
| `INVITE_PREFIX` + id | `invite:{tokenHash}` | `worker/accounts/admin-routes.ts` |
| 内联 | `` `invite:${await hashToken(token)}` `` | `worker/accounts/public-routes.ts` |
| `compiledPrefix` / `compiledKey` | `compiled:{tokenHash}:` + `{client}` | `worker/delivery/repository.ts` |
| `shareEntityKey` | `share:{tokenHash}` | `worker/shares/repository.ts` |
| `userIndexKey` | `shareidx:user:{userId}` | `worker/shares/repository.ts` |
| `subscriptionIndexKey` | `shareidx:sub:{subscriptionId}` | `worker/shares/repository.ts` |
| `shareLimitKey` | `sharelimit:{tokenHash}:{minuteWindow}` | `worker/shares/repository.ts` |
| `shareCompiledPrefix` / `shareCompiledKey` | `compiled:share:{tokenHash}:{client}` | `worker/shares/repository.ts` |

`compiled:{tokenHash}:` 与 `compiled:share:{tokenHash}:` 不重叠。订阅令牌哈希是 43 位 base64url，不会等于字面量 `share`。`list({ prefix: 'share:' })` 也不会扫到 `shareidx:` 或 `sharelimit:`。

## 键说明

### `state:accounts`

- 常量：`ACCOUNTS_KEY`。
- 写入调用：`worker/accounts/public-routes.ts` 初始化、`worker/accounts/admin-routes.ts` 停用用户、重置密码、创建邀请时递增 `nextUserId`、`worker/accounts/account-routes.ts` 修改自己的密码。
- 读取调用：上述写入路径，以及 `worker/accounts/auth.ts`、`worker/app.ts` 健康检查、`worker/shares/service.ts` 校验分享所有者。
- 快照字段：`schemaVersion`、`revision`、`updatedAt`、`nextUserId`、`users[]`。
- 用户字段见 `userSchema`：`id`、`username`、`role`、`enabled`、`password`、`sessionVersion`、`createdAt`、`updatedAt`。当前没有 email。

### `invite:{tokenHash}`

- 写入：`adminAccountRoutes.post('/invites')`，`expirationTtl` 为 24 小时，与 `expiresAt` 一致。
- 列表：`listInvites` 使用前缀 `invite:`，并丢掉已过期记录。
- 单键读取和删除：`publicAccountRoutes` 的 `GET/POST /invites/:token`。过期、用户名冲突、兑换成功都会删除键。管理端 `DELETE /invites/:id` 按哈希删除。
- 明文邀请令牌只出现在创建响应的链接里，KV 不保存明文。
- `userId` 在创建邀请时预分配。对应 `users` 行要等兑换才出现，所以 `invitations.user_id` 不做外键。
- 兑换成功后 KV 直接删键，没有历史表。`invitation_redemptions` 是 D1 侧新增的一次性兑换记录。

### `system:crypto`

- 值：`schemaVersion`、`encryptionKey`、`sessionKey`、`createdAt`。
- 两个密钥都是 32 字节的无填充 base64url，正则 `^[A-Za-z0-9_-]{43}$`。
- 读取调用会继续把 `KVNamespace` 传进来。未显式传入密钥时，函数再看 Worker `env` 上的 `DATA_ENCRYPTION_KEY` 和 `SESSION_KEY`。两个都缺失才读 KV。
- 调用链包括 `worker/accounts/auth.ts`、`worker/accounts/public-routes.ts`、`worker/accounts/account-routes.ts`、`worker/shares/session.ts`、`worker/delivery/service.ts`、`worker/catalog/import-service.ts`、`worker/shares/service.ts`。

### `state:catalog`

- 常量：`CATALOG_KEY`。大小上限 `MAX_CATALOG_BYTES`。
- 直接读写只在 `worker/catalog/repository.ts`。调用方包括目录路由、导入服务、分组解析、订阅编译、定时刷新、公开订阅和用户节点。
- 快照字段：`schemaVersion`、`revision`、`updatedAt`、`nextSourceId`、`nextNodeId`、`nextGroupId`、`sources[]`、`nodes[]`、`groups[]`。
- `sourceSchema`、`nodeSchema`、`groupSchema`、`rawVariantSchema` 的字段拆到对应表。`nodes.sourceIds` 仍是有序 JSON，因为表名单里没有 `node_sources`，而顺序决定分组里的来源优先级。
- `groups.sourceIds`、`includedNodeIds`、`excludedNodeIds`、`nodeOrder` 拆进关联表，并保留 `position`。

### `state:delivery`

- 常量：`DELIVERY_KEY`。大小上限 `MAX_DELIVERY_BYTES`。
- 读写在 `worker/delivery/repository.ts`。调用方包括订阅服务、编译、公开订阅、目录删除分组后的 `removeGroupReference`、分享服务。
- 订阅字段见 `subscriptionSchema`。`groupIds` 的数组顺序写入 `subscription_groups.position`。
- `startsAt` / `expiresAt` 是毫秒时间戳或 `null`，与目录、分享里的 ISO 时间不是同一种表示。

### `compiled:{tokenHash}:{client}`

- 写入和清理过期键：`compileSubscription`、`compileAllSubscriptions`。
- 按订阅删除：`deleteCompiledArtifacts`，调用方是重置令牌和删除订阅。
- 读取：`worker/public-subscriptions.ts` 的公开分发，`worker/delivery/routes.ts` 的订阅视图，`loadShareArtifact` 在分享缓存未命中时回读。
- 这是派生产物。订阅或目录版本变化后会重新编译。表名单没有缓存表。

### `state:apps`

- 常量：`APPS_KEY`。大小上限 `MAX_APPS_BYTES`。
- 读写在 `worker/apps/repository.ts`，经 `worker/apps/service.ts` 给管理端和用户端路由。
- `flags` 的五个布尔量在 D1 里拆成列。平台行在 `platforms[]`，删除应用时服务会同时去掉它的平台。

### `state:share-settings`

- 缺键时读端返回 `DEFAULT_SHARE_SETTINGS`。
- 存储前会把 `publicBaseUrl` 收成源站 origin，空字符串保留。
- D1 的 `getShareSettings` 沿用同一套缺省合并，避免以后切换时语义变化。

### `state:share-seq`

- 缺键时从 `1` 起分配，返回 `shr_{next}`，并把 `next` 加一后写回。
- 后写胜出。D1 里用 `system_settings.next_share_id` 保存同一个计数，本批还不切换分配函数。

### `share:{tokenHash}`

- 实体键是令牌哈希，记录内部还有 `id`（`shr_N`）。
- 写入：`writeShare`。删除：`deleteShare`。全量列举用前缀 `share:`，并用 `^share:[A-Za-z0-9_-]{43}$` 过滤。
- 分享服务通过这两个函数创建、更新、停用、重置令牌、删除、校验和导出。
- `accessControl` 是 `{ mode: 'none' }` 或 `{ mode: 'password', passwordHash }`。D1 把 `mode` 做成列，密码哈希拆成与用户密码相同的四列。

### `shareidx:user:{userId}` 与 `shareidx:sub:{subscriptionId}`

- 值是去重后的 `tokenHash` 数组。空数组会删除键。
- 维护函数：`addIndexHash`、`removeIndexHash`、`replaceIndexHash`。
- 读取函数：`listIndexedShares`，用于用户自己的分享列表和每用户、每订阅的数量限制。
- 这是派生索引。D1 用 `shares` 上的 `owner_user_id`、`subscription_id` 查询，迁移时不复制这两类键。

### `sharelimit:{tokenHash}:{minuteWindow}`

- `minuteWindow` 是 `Math.floor(nowMs / 60_000)`。
- 读最近 10 个分钟桶，合计达到 10 次则拒绝。当前桶的值加一，并设置 `expirationTtl: 11 * 60`。
- 值是数字字符串，不是 JSON。非法或缺失按 0。
- 映射到 `rate_limits`：`bucket = 'share_verify'`，`subject = tokenHash`，`window_start = minuteWindow`，`count` 为整数。KV 的过期时间在值里不存在，`expires_at` 留给以后写入 TTL。

### `compiled:share:{tokenHash}:{client}`

- 读写集中在 `loadShareArtifact`。
- 删除前缀：`deleteShareCompiled`，分享删除或令牌轮换时调用。
- 与订阅缓存一样，不进入 D1。

### `state:cron`

- 常量：`CRON_KEY`。每次 `runCron` 覆盖这一键，健康检查读取它。
- 字段：`schemaVersion`、`status`、`ranAt`、`finishedAt`、可选 `sourceId`、`errorCode`、`catalogRevision`。
- `cron_runs` 按行追加，便于留下历史。迁移现有 KV 时，这一键最多变成一行。

## 没有 KV 来源的表

下面这些表在表名单里，当前代码没有对应键。结构按名称和已有唯一约束预留，字段说明见 `docs/d1/SCHEMA.md`。

- `email_verifications`
- `email_change_requests`
- `allowed_email_domains`
- `invitation_redemptions`（兑换今天是删掉 `invite:*`）
- `audit_logs`（`shareRecordSchema` 只在 `lastOriginalRevealAt` 上留了审计占位）
- `migration_runs`（应用数据迁移记录，不是 Wrangler 的 `d1_migrations`）
- `users.email`、`users.email_normalized`、`users.email_verified_at`
- `system_settings.registration_mode`（当前产品只有邀请注册，缺省值为 `invite`）
