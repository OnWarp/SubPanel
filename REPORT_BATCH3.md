# Batch 3 报告：订阅与分享切 D1

分支 `task/d1-delivery-shares-grok`，基线 `f7226e2`。本批把 subscriptions、subscription_groups、shares、share settings 和分享序号的在线读写切到 D1。accounts、cron 自有状态仍在 KV。编译缓存 `compiled:*` 与 `compiled:share:*` 仍在 KV。加密材料仍走 `env.DATA` 的 `system:crypto`。catalog 与 apps 的 D1 行为未改。未对远程 D1 执行 wrangler 命令。

## 接口形状变化

读写订阅或分享状态的函数第一参数由 `KVNamespace` 改为 `DataEnv`（`DATA` + `DB`）。`Env` 满足该类型，路由传入 `c.env`。

- Delivery repository：`readDelivery`、`writeDelivery`
- Delivery service：`createSubscription`、`updateSubscription`、`setSubscriptionEnabled`、`resetSubscriptionToken`、`deleteSubscription`、`removeGroupReference`、`listSubscriptionsForUser`、`listAllSubscriptions`、`getSubscription`
- 读订阅快照的入口：`compileSubscription`、`compileAllSubscriptions`、`compileSubscriptionById`、公开订阅、用户节点、`worker/catalog/routes.ts` 删除分组前的 `readDelivery` 与之后的 `removeGroupReference`
- Shares repository：`readShareSettings`、`writeShareSettings`、`allocateShareId`、`readShare`、`writeShare`、`deleteShare`、`listIndexedShares`、`listAllShares`、`addIndexHash`、`removeIndexHash`、`replaceIndexHash`、`consumeVerifySlot`、`claimExportAccess`
- Shares service：`updateSettings`、`createShare`、`updateShare`、`changeOwnStatus`、`resetShareToken`、`removeShare`、`revealOriginalLink`、`readShareMeta`、`verifyShare`、`exportShare`、`listOwnShares`、`listAdminShares`、`adminChangeStatus`

仍以 `KVNamespace` 为参数的有 `readDeliveryKv`、`deleteCompiledArtifacts`、`compiledPrefix`、`compiledKey`、`decryptSubscriptionToken`、`readShareSettingsKv`、`readShareSeqKv`、`readShareValuesKv`、`deleteShareCompiled`，以及内部的 `sealToken` / `createToken`。分享会话仍读 `c.env.DATA` 上的密钥。

`POST /api/admin/migration/run` 的 body 枚举现为 `catalog | apps | delivery | shares`。校验失败仍返回 409。本批文案是「订阅快照无法读取」「订阅迁移校验未通过」「分享数据无法读取」「分享迁移校验未通过」，句末没有句号。

## 导入策略与幂等

入口仍是 `runModuleImport`。顺序：用 `*Kv` 读者读 KV → 第一批 `convertDelivery` / `convertShares` → persist → 回读并核对行数与快照 → 通过后才把 `delivery_d1_ready` 或 `shares_d1_ready` 写成 JSON `true`。完成标记不在数据 batch 里。校验失败时读者仍走 KV。导入不增加 revision，也不删除 KV。

幂等办法是按主键整模块替换：

- Delivery：`json_each` 删掉快照里已不存在的 subscription。保留的行按主键 upsert。这些订阅的 `subscription_groups` 先删再按 `groupIds` 下标插入，`position` 从 0 起。订阅数组顺序写入 `delivery_entity_order`。空 id 列表会删掉全部订阅。
- Shares：在线创建、更新、删除按 `token_hash` 单行 upsert 或删除。导入则删掉快照里已不存在的 id，再 upsert 保留行，并在同一 batch 写入 `share_settings` 与 `next_share_id`。`shareidx:*` 不入库，D1 按 `owner_user_id` / `subscription_id` 查询，所以标记置位后索引维护函数直接返回。令牌轮换是按 id 原地更新 `token_hash`，随后按旧哈希删除是空操作。
- 重复导入会再次从 KV 装载并覆盖 D1。标记已置位之后再导入，会丢掉其间只写在 D1 上的修改。

校验：delivery 比较订阅行数、`subscription_groups` 行数，以及回读快照与 KV 快照的 JSON。shares 比较分享行数、`share_settings` 是否恰好一行、按 id 排序后的记录、设置和 `next_share_id`。单条分享校验失败或 token / id 重复时，合法行会写入，但 `anomalies` 非空则不置位。设置或序号 JSON 损坏、订阅快照无法解析，在 persist 之前失败，文案走「无法读取」。缺省的分享设置使用 `DEFAULT_SHARE_SETTINGS`，缺省序号为 1，空模块可以置位。

在线 `writeDelivery` 仍先做 Zod 校验、revision + 1、`updatedAt` 与 20MB 上限，再按标记只写一个后端。没有双写。分享序号仍是后写覆盖，与 KV 的 `{ next }` 相同。

## 跨模块引用

- `subscription_groups.group_id` 仍引用 `groups(id)`，并 `ON DELETE CASCADE`。导入 delivery 时分组必须已经在 D1。分组不存在时 persist 失败，返回「订阅迁移校验未通过」，标记保持关闭，batch 回滚，读者继续读 KV。建议顺序是先 catalog，再 delivery，再 shares。
- `subscriptions.user_id` 与 `shares.owner_user_id` 仍 `ON DELETE RESTRICT` 指向 `users`。accounts 本批不入库。`worker/db/ensure-users.ts` 在写入订阅或分享时，若 D1 还没有该用户，用 `INSERT OR IGNORE` 从 KV 账户快照抄入一行（密码哈希保留，邮箱三列是 NULL）。不更新、不删除 `users`，也不写 accounts 的 KV。用户不在账户快照里时抛出 `Referenced user is missing`，导入把它当成校验失败并且不置位。以后的 accounts 导入不能假设 `users` 是空表。
- `migrations/0003_shares_subscription_fk.sql` 重建 `shares`，去掉 `subscription_id` 对 `subscriptions` 的外键，保留 `owner_user_id` 外键和原有索引。KV 删除订阅后分享行会留下并在访问时 404。`ON DELETE RESTRICT` 会让 D1 删除失败，`CASCADE` 会删掉分享并改变列表。重建表而不使用 `PRAGMA foreign_keys=OFF`。导入分享时不要求订阅行已经存在，悬空分享可以入库。
- 删除分组的路由顺序未改：先 `readDelivery` 确认订阅快照可读，再 `writeCatalog`，再 `removeGroupReference`。catalog 删除分组会级联删掉 `subscription_groups`。随后的 `removeGroupReference` 读到的 `groupIds` 里已经没有该分组，于是直接返回，订阅 `revision` 不会加一。分组关系与下发内容仍然一致：catalog revision 会增加，`recompileDelivery` 会按剩余分组重写编译缓存。catalog 仍在 KV、delivery 已在 D1 不是支持的稳态，因为新的 `subscription_groups` 会因分组外键失败。
- `sharelimit:*` 不导入。标记关闭时校验限流仍写 KV，TTL 11 分钟。标记打开后写入 `rate_limits`，bucket 为 `share_verify`，窗口 10 个，`expires_at <= now` 的窗口按 0 计，新窗口的过期时间是当前秒加 11 分钟。
- Cron 状态键 `state:cron` 仍在 KV。`runCron` 读 catalog（第二批已按标记选择后端），刷新源时经 `compileAllSubscriptions` 读订阅，因此标记打开后编译使用 D1 里的订阅和分组。

## grep 自证

命令：`rg env.DATA worker/delivery worker/shares`。订阅和分享状态的在线读写只出现在标记未置位的 KV 回退。其余命中是账户快照、密钥或编译缓存。

KV 回退（标记置位后不执行）：

- `worker/delivery/repository.ts`：`readDeliveryKv(env.DATA)`、`env.DATA.put(DELIVERY_KEY)`，键 `state:delivery`
- `worker/shares/repository.ts`：`readShareSettingsKv`、`writeShareSettingsKv`、`allocateShareIdKv`、`share:` 的 get/put/delete、`shareidx:*` 的读写、`listAllShares` 的 KV 列举、`consumeVerifySlot` 的 `sharelimit:*` get/put

编译缓存，仍在 KV：

- `worker/delivery/compiler.ts` 两处 `const kv = env.DATA`，写 `compiled:{tokenHash}:{client}`
- `worker/delivery/routes.ts`：`c.env.DATA.get(compiledKey(...))`
- `worker/delivery/service.ts`：`deleteCompiledArtifacts(env.DATA, ...)`
- `worker/shares/service.ts`：`deleteShareCompiled(env.DATA, ...)`，以及 `loadShareArtifact` 里对 `compiled:share:*` 和订阅编译缓存的 get/put

密钥与账户，路径未改。账户读取用来锚定 `users` 行，不写账户存储：

- `worker/delivery/service.ts`：`readAccounts(env.DATA)`、`createToken(env.DATA)`、`decryptSubscriptionToken` 的调用方传入 `c.env.DATA`
- `worker/delivery/repository.ts`：D1 写入前 `readAccounts(env.DATA)`
- `worker/shares/service.ts`：`readAccounts(env.DATA)`、`sealToken(env.DATA)`、`decryptSubscriptionToken(env.DATA, ...)`
- `worker/shares/repository.ts`：D1 写入前 `readAccounts(env.DATA)`
- `worker/shares/session.ts`：两处 `readCryptoMaterial(c.env.DATA)`

导入专用的 KV 读者在 `worker/migration/run.ts`：`readDeliveryKv`、`readShareValuesKv`、`readShareSettingsKv`、`readShareSeqKv`，以及两处 `readAccounts`。service 与 routes 的创建、更新、启停、删除都经上述 repository。

## 与 SCHEMA.md 的偏差

未改 `docs/d1/SCHEMA.md`。

- 新增完成标记 `delivery_d1_ready`、`shares_d1_ready`，值为 JSON `true`。
- 新增 `delivery_entity_order`。subscriptions 没有父级 position 列，数组顺序放在 system_settings。`subscription_groups.position` 仍从 0 起，与 `groupIds` 下标一致。
- `0003_shares_subscription_fk.sql` 去掉 `shares.subscription_id` 对 `subscriptions(id)` 的外键。SCHEMA 约定里「分享指向订阅」是 `ON DELETE RESTRICT`。这一处外键如果保留，就无法保持 KV 的悬空分享和删除订阅行为。`owner_user_id` 外键保留。
- 为满足用户外键，delivery 与 shares 写入可能预先 `INSERT OR IGNORE` 用户行。这些行的邮箱列为空。accounts 导入不能把 `users` 当成空表，也不能覆盖这些锚点行上的密码。
- 任务书写「expiresAt 可空即永久」。现行 `shareRecordSchema` 要求 `z.iso.datetime()`，`shares.expires_at` 是 `TEXT NOT NULL`。创建分享时缺省值为当前时间加上 `maxValidityDays`。本批按现行代码和 SCHEMA 保存必填时间。
- `sharelimit:*` 不导入。标记打开后的新限流写入已有的 `rate_limits` 表。`shareidx:*` 与两种 compiled 缓存按 SCHEMA「不进表」处理。
- 导入完成标记是上述 ready 键。本批不写 `migration_runs`。
- SCHEMA 文首「本批不切换业务读写」、库名 `subpanel` 与全零 `database_id` 是第一批范围。第二批已把绑定改为 `subpanel-d1` / `d8360141-8f44-4550-8656-5931231bb020`。本批切换 delivery 与 shares，没有改 wrangler 绑定。`DATA` 绑定留给 accounts、cron、密钥和编译缓存。

## 测试与构建

`npm test`：41 个文件通过，282 条通过。新增 `development/tests/worker/d1-delivery-shares.test.ts` 10 条，覆盖 KV/D1 深比较、分组 position、token 字段、起止时间为空、重复导入、损坏快照不置位、分组不在 D1 时不置位、分享设置规范化、密码与无密码、序号、token_hash 唯一、悬空订阅、无效记录不置位、标记两态、D1 限流不写 `sharelimit:*`、九个客户端的编译产物一致，以及管理员接口对 delivery 与 shares 的 401、403、200 和重复 200。

`enableD1Modules` 在清空 shares、delivery、catalog、apps 之后置位四个 ready 键。既有 delivery、shares、user-nodes、cron、catalog API 测试因此在 D1 标记打开后跑过。断言未放宽。原先直接写 `state:delivery` 或分享过期字段的用例，改为写当前生效的存储：catalog 用非法的 `delivery_revision`，delivery 把 `starts_at` / `expires_at` 更新为 NULL，shares 更新 `expires_at`。`delivery-repository.test.ts` 不打开标记，继续覆盖 KV 上的损坏快照。`catalog-migration.test.ts` 仍关闭标记。

`npm run check` 通过：`wrangler types --check`、`tsc -b`、oxlint 0 warning。`npm run build` 通过。

`development/tests/worker/smoke.test.ts` 在收集阶段失败，3 条用例没有执行。错误是 `ENOENT: open '../../public/_headers'`，栈落在 `node_modules/@cloudflare/vitest-pool-workers`。本工作树的 `node_modules` 指向 `/data/workspace/subpanel-integ/node_modules`。`public/_headers` 存在。这是 brief 允许单独说明的 smoke `_headers` 环境问题，与本次存储切换无关
