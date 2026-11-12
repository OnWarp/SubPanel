# D1 表结构映射

绑定名 `DB`，`database_name` 为 `subpanel`，迁移目录 `migrations/`。

`wrangler.jsonc` 里的 `database_id` 目前是占位符 `00000000-0000-0000-0000-000000000000`。远程库创建后要换成真实 UUID，再部署。本地 Miniflare 不使用这个远程 id。

KV 绑定 `DATA` 保持不动。本批不切换业务读写。

仓库里没有方案正文。表名单、唯一约束和“字段以当前 Zod 为准”来自本批任务。已经存在的实体按 Zod 字段逐列映射。名单里有、KV 里还没有的表，按名称和任务点名的唯一键做了最小预留，并在文末标出。

## 约定

- 主键沿用现有文本 id：`usr_N`、`src_N`、`node_N`、`grp_N`、`sub_N`、`app_N`、`plt_N`、`shr_N`。邀请主键是令牌哈希。
- 布尔值用 `INTEGER`，只允许 `0` 和 `1`。
- 业务时间用 ISO 8601 文本，与 `z.iso.datetime()` 的 `toISOString()` 一致。
- 订阅的 `startsAt` / `expiresAt` 是毫秒整数或 `NULL`，因为 Zod 里它们就是 epoch millis。
- 外键：行在写入时已经存在的引用使用外键。邀请预分配的 `user_id` 除外，兑换前用户行还不存在。
- 删除语义：聚合内部的子行 `ON DELETE CASCADE`（平台、原始变体、分组成员）。跨聚合引用 `ON DELETE RESTRICT`（订阅和分享指向用户，分享指向订阅）。定时运行的 `source_id`、审计的 `actor_user_id` 使用 `ON DELETE SET NULL`。
- 唯一约束覆盖 Zod 已经拒绝的重复项：用户名、节点指纹、订阅令牌哈希、分享令牌哈希，以及任务点名的 `email_normalized`、`token_hash`。
- 部分唯一索引 `users_single_admin` 保证最多一名管理员，对应账户快照的 superRefine。
- SQLite 的 `UNIQUE` 允许多个 `NULL`，所以未填写的 `email_normalized` 可以重复为空。
- 快照级的 `schemaVersion`、`revision`、`updatedAt`、`next*Id` 不放进每一行，进 `system_settings`。
- Wrangler 自己的 `d1_migrations` 记录 SQL 文件是否已执行。`migration_runs` 留给以后的 KV 数据搬迁，两者不要混用。

## 不进表的 KV

| KV | 原因 |
| --- | --- |
| `system:crypto` | 密钥来自环境变量，缺省时仍读 KV。不把密钥复制进 D1 |
| `compiled:{tokenHash}:{client}` | 可再编译的订阅缓存 |
| `compiled:share:{tokenHash}:{client}` | 可再编译的分享缓存 |
| `shareidx:user:{userId}` | `shares.owner_user_id` 索引 |
| `shareidx:sub:{subscriptionId}` | `shares.subscription_id` 索引 |

## 密钥编码

KV 的 `encryptionKey` 和 `sessionKey` 是 32 字节原始密钥的无填充 base64url，与 `toBase64Url` 一致。

`DATA_ENCRYPTION_KEY` 和 `SESSION_KEY` 接受同一种字符串，也接受标准 base64（`+`、`/`、`=`）。读取时去掉填充并把 `+/` 换成 `-_`，再交给现有的 base64url 解码。加解密算法和密文格式不变。两个都是空或未设置时走原来的 KV 读取。只设置其中一个视为损坏，不回退到另一套密钥。

从环境变量组装的材料没有自己的 `createdAt`，返回值里用 `1970-01-01T00:00:00.000Z` 占位，并且不会写回 KV。

## system_settings

`key` 主键，`value` 为 JSON 文本，`updated_at` 为 ISO 时间。

| 键 | JSON 形状 | KV 来源 |
| --- | --- | --- |
| `registration_mode` | `"closed"`、`"invite"` 或 `"open"` | 无。缺省 `invite`，对应当前只有邀请注册 |
| `share_settings` | `shareSettingsSchema` 对象 | `state:share-settings` |
| `accounts_schema_version` | `1` | `state:accounts.schemaVersion` |
| `accounts_revision` | 非负整数 | `state:accounts.revision` |
| `accounts_updated_at` | ISO 时间 | `state:accounts.updatedAt` |
| `next_user_id` | 正整数 | `state:accounts.nextUserId` |
| `catalog_schema_version` | `2` | `state:catalog.schemaVersion` |
| `catalog_revision` | 非负整数 | `state:catalog.revision` |
| `catalog_updated_at` | ISO 时间 | `state:catalog.updatedAt` |
| `next_source_id` | 正整数 | `state:catalog.nextSourceId` |
| `next_node_id` | 正整数 | `state:catalog.nextNodeId` |
| `next_group_id` | 正整数 | `state:catalog.nextGroupId` |
| `delivery_schema_version` | `1` | `state:delivery.schemaVersion` |
| `delivery_revision` | 非负整数 | `state:delivery.revision` |
| `delivery_updated_at` | ISO 时间 | `state:delivery.updatedAt` |
| `next_subscription_id` | 正整数 | `state:delivery.nextSubscriptionId` |
| `apps_schema_version` | `1` | `state:apps.schemaVersion` |
| `apps_revision` | 非负整数 | `state:apps.revision` |
| `apps_updated_at` | ISO 时间 | `state:apps.updatedAt` |
| `next_app_id` | 正整数 | `state:apps.nextAppId` |
| `next_platform_id` | 正整数 | `state:apps.nextPlatformId` |
| `next_share_id` | 正整数 | `state:share-seq.next` |

本批代码只给 `registration_mode` 和 `share_settings` 做了带类型的读写。其余键名在这里固定，供后续迁移使用。

## 字段对照

### users ← `userSchema`

| KV / Zod | 列 | 说明 |
| --- | --- | --- |
| `id` | `id` | 主键 |
| `username` | `username` | 唯一 |
| `role` | `role` | `admin` 或 `user` |
| `enabled` | `enabled` | |
| `password.algorithm` | `password_algorithm` | 只能是 `PBKDF2-SHA-256` |
| `password.iterations` | `password_iterations` | |
| `password.salt` | `password_salt` | |
| `password.hash` | `password_hash` | |
| `sessionVersion` | `session_version` | |
| `createdAt` | `created_at` | |
| `updatedAt` | `updated_at` | |
| 无 | `email` | 预留 |
| 无 | `email_normalized` | 预留，非空时唯一 |
| 无 | `email_verified_at` | 预留 |

### invitations ← `inviteRecordSchema`

| KV / Zod | 列 | 说明 |
| --- | --- | --- |
| 键后缀 | `id` | 令牌哈希，明文不入库 |
| `schemaVersion` | `schema_version` | 固定 `1` |
| `userId` | `user_id` | 预分配 id，无外键 |
| `username` | `username` | 有索引。过期邀请仍可能留着同名行，所以不是全局唯一 |
| `createdAt` | `created_at` | |
| `expiresAt` | `expires_at` | KV 另有 24 小时 TTL，D1 靠这一列判断过期 |

### invitation_redemptions

KV 兑换成功后删除邀请键，没有独立记录。

| 列 | 说明 |
| --- | --- |
| `id` | 自增主键 |
| `invitation_id` | 外键，唯一，一张邀请只能兑换一次 |
| `user_id` | 外键，指向兑换后创建的用户 |
| `redeemed_at` | ISO 时间 |

### email_verifications、email_change_requests、allowed_email_domains

当前用户模型没有邮箱。这三张表只预留迁移目标。

`email_verifications`：`user_id`、`email`、`email_normalized`、`token_hash` 唯一、`expires_at`、`consumed_at`、`created_at`。

`email_change_requests`：在上面的基础上增加 `current_email_normalized`（可空）和 `new_email` / `new_email_normalized`，`token_hash` 唯一。

`allowed_email_domains`：`domain` 主键，必须等于自身的小写形式，另有 `created_at`。

### rate_limits ← `sharelimit:{tokenHash}:{minuteWindow}`

| KV | 列 |
| --- | --- |
| 固定语义 `share_verify` | `bucket` |
| `tokenHash` | `subject` |
| 分钟窗口整数 | `window_start` |
| 计数字符串 | `count` |
| 键的 TTL，值里没有 | `expires_at`，可空的 Unix 秒 |

主键是 `(bucket, subject, window_start)`。以后别的限流可以复用 `bucket`。

### sources ← `sourceSchema`

| KV / Zod | 列 |
| --- | --- |
| `id` | `id` |
| `name` | `name` |
| `type` | `type` |
| `enabled` | `enabled` |
| `encryptedContent` | `encrypted_content` |
| `encryptedUrl` | `encrypted_url` |
| `encryptedHeaders` | `encrypted_headers` |
| `refreshIntervalMinutes` | `refresh_interval_minutes` |
| `detectedFormat` | `detected_format` |
| `warnings` | `warnings` |
| `lastAttemptAt` | `last_attempt_at` |
| `lastSuccessAt` | `last_success_at` |
| `lastErrorCode` | `last_error_code` |
| `createdAt` | `created_at` |
| `updatedAt` | `updated_at` |

远程来源必须同时有 URL、请求头和 15 分钟整数倍的刷新间隔。手动和文件来源这三列必须为空。这是 `sourceSchema` 的 superRefine。

### nodes ← `nodeSchema`

| KV / Zod | 列 |
| --- | --- |
| `id` | `id` |
| `protocol` | `protocol` |
| `displayName` | `display_name` |
| `server` | `server` |
| `port` | `port` |
| `credentials` | `credentials` |
| `tls` | `tls` |
| `transport` | `transport` |
| `plugin` | `plugin` |
| `extensions` | `extensions` |
| `fingerprint` | `fingerprint`，唯一 |
| `sourceIds` | `source_ids` |
| `enabled` | `enabled` |
| `retained` | `retained` |
| `order` | `sort_order` |
| `createdAt` | `created_at` |
| `updatedAt` | `updated_at` |

`rawVariants` 不留在 `nodes` 上。

### node_raw_variants ← `rawVariantSchema`

| KV / Zod | 列 |
| --- | --- |
| 无 | `id` 自增主键 |
| 所属节点 | `node_id` |
| `sourceId` | `source_id` |
| `format` | `format` |
| `raw` | `raw` |
| `extensions` | `extensions` |

同一节点、同一来源、同一格式是否重复，Zod 没有禁止，所以这里不加这三列的唯一约束。

### groups、group_sources、group_nodes、group_node_order ← `groupSchema`

`groups` 只留 `id`、`name`、`created_at`、`updated_at`。

| 数组 | 表 | 列 |
| --- | --- | --- |
| `sourceIds` | `group_sources` | `group_id`、`source_id`、`position` |
| `includedNodeIds` | `group_nodes` | `relation = included`，另有 `position` |
| `excludedNodeIds` | `group_nodes` | `relation = excluded`，另有 `position` |
| `nodeOrder` | `group_node_order` | `group_id`、`node_id`、`position` |

`group_nodes` 的主键是 `(group_id, node_id)`，因此一个节点不能同时被包含和排除。`position` 从 0 开始，保留数组顺序。`sourceIds` 的顺序会参与 `resolveGroupNodes` 的来源优先级，所以 `group_sources.position` 必须保留。

### subscriptions、subscription_groups ← `subscriptionSchema`

| KV / Zod | 列 |
| --- | --- |
| `id` | `id` |
| `userId` | `user_id` |
| `name` | `name` |
| `groupIds` | `subscription_groups` |
| `tokenHash` | `token_hash`，唯一 |
| `tokenPrefix` | `token_prefix` |
| `encryptedToken` | `encrypted_token` |
| `enabled` | `enabled` |
| `defaultClient` | `default_client` |
| `revision` | `revision` |
| `startsAt` | `starts_at` |
| `expiresAt` | `expires_at` |
| `createdAt` | `created_at` |
| `updatedAt` | `updated_at` |

`subscription_groups.position` 对应 `groupIds` 的下标。`starts_at <= expires_at` 在两者都有值时成立。

### apps、app_platforms ← `appSchema`、`platformSchema`

应用：`id`、`name`、`icon`、`summary`、`description`、`category`、`official_website`、`developer`、`sort_order`、`created_at`、`updated_at`。

`flags.isRecommended`、`isOfficial`、`isPopular`、`isEnabled`、`isPublic` 分别是 `is_recommended`、`is_official`、`is_popular`、`is_enabled`、`is_public`。

平台：`id`、`app_id`、`platform`、`version`、`download_url`、`download_type`、`file_size_kb`、`official_store_url`、`official_download_url`、`update_notes`、`import_supported`、`import_protocol`、`import_url_template`、`import_instructions`、`is_enabled`、`created_at`、`updated_at`。

同一应用可以有多行相同 `platform`，服务层没有禁止，所以 `(app_id, platform)` 不是唯一键。删除应用时服务会删掉它的平台，外键用 `ON DELETE CASCADE`。

空字符串在 Zod 里是合法的可选 URL 或文案，列用 `TEXT NOT NULL` 保存空字符串。真正可缺省的是 `developer` 和 `file_size_kb`，用 `NULL`。

### shares ← `shareRecordSchema`

| KV / Zod | 列 |
| --- | --- |
| `id` | `id` |
| `schemaVersion` | `schema_version` |
| `ownerUserId` | `owner_user_id` |
| `subscriptionId` | `subscription_id` |
| `tokenHash` | `token_hash`，唯一 |
| `tokenPrefix` | `token_prefix` |
| `tokenEncrypted` | `token_encrypted` |
| `remark` | `remark` |
| `status` | `status` |
| `accessControl.mode` | `access_mode` |
| `accessControl.passwordHash.*` | `access_password_algorithm`、`access_password_iterations`、`access_password_salt`、`access_password_hash` |
| `expiresAt` | `expires_at` |
| `allowOriginalLink` | `allow_original_link` |
| `showSubscriptionName` | `show_subscription_name` |
| `showGroups` | `show_groups` |
| `showExpiry` | `show_expiry` |
| `showNodeNames` | `show_node_names` |
| `requireLogin` | `require_login` |
| `maxAccessCount` | `max_access_count` |
| `accessCount` | `access_count` |
| `lastAccessedAt` | `last_accessed_at` |
| `lastOriginalRevealAt` | `last_original_reveal_at` |
| `createdAt` | `created_at` |
| `updatedAt` | `updated_at` |

`access_mode = none` 时四列密码必须全空。`password` 时算法固定为 `PBKDF2-SHA-256`，其余三列必填。

索引覆盖现在的 KV 前缀查询：所有者、订阅、状态、到期时间。

### cron_runs ← `cronStatusSchema`

| KV / Zod | 列 |
| --- | --- |
| 无 | `id` |
| `schemaVersion` | `schema_version` |
| `status` | `status` |
| `ranAt` | `ran_at` |
| `finishedAt` | `finished_at` |
| `sourceId` | `source_id` |
| `errorCode` | `error_code` |
| `catalogRevision` | `catalog_revision` |

### audit_logs

当前没有审计事件流。列：`created_at`、`actor_user_id`、`action`、`entity_type`、`entity_id`、`detail`。`detail` 是 JSON 对象。

### migration_runs

列：`name` 唯一、`status`（`running`、`succeeded`、`failed`）、`started_at`、`finished_at`、`error`、`detail`。

## JSON 列

做成列，而不是 JSON：

- 用户密码和分享密码哈希。字段集合是封闭的，算法和迭代次数可以加 `CHECK`。
- 应用 `flags`、节点和来源上的布尔与枚举。后面的列表和筛选会直接用到。
- 分组和订阅里的 id 数组。它们是关系，而且顺序有意义，所以用带 `position` 的关联表。
- 分享 `accessControl.mode`。状态和模式都要筛选。

保留 JSON：

- `encryptedContent`、`encryptedUrl`、`encryptedHeaders`、`encryptedToken`、`tokenEncrypted`。这是 `encryptedValueSchema` 的原样信封，查询不会拆开 `iv` 和 `ciphertext`。
- `credentials`、`tls`、`transport`、`plugin`、`extensions`。协议扩展是开放对象，按列展开会丢字段。
- `warnings`。诊断数组长度和 `line` 都不确定，不是实体关系。
- `nodes.source_ids`。表名单没有 `node_sources`，而数组顺序决定来源优先级。关联表表达不了这份名单里的这个字段，所以保留有序 JSON 数组。
- `system_settings.value`。不同键的形状不同，注册模式是 JSON 字符串，分享设置是 JSON 对象。
- `audit_logs.detail`、`migration_runs.detail`。事件附加信息没有固定字段。

`node_raw_variants.raw` 是原始文本，不是 JSON。

## 与任务表名单的差异

- 表名单上的 23 张表都在 `migrations/0001_init.sql`，没有另加表。
- `database_id` 仍是占位符。
- 邮箱、域名白名单、审计、数据迁移运行记录在现网 KV 中不存在。列是按表名和 `email_normalized`、`token_hash` 这两类唯一键预留的，后续如果方案正文给出不同字段，应改迁移而不是在业务里临时加列。
- `cron_runs` 设计成多行历史。KV 的 `state:cron` 只有最新一条。
- 编译缓存和 `shareidx:*` 不建表。
- `invitations.user_id` 没有外键。
- 节点的 `sourceIds` 留在 JSON 列，没有拆成 `node_sources`。
