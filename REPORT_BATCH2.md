# Batch 2 报告：Catalog 与应用目录切 D1

分支 `task/d1-catalog-grok`，基线 `c76b3b1`。本批把 sources、nodes、groups（含 sourceIds、included/excluded、nodeOrder、rawVariants）和 apps、app_platforms 的在线读写切到 D1。accounts、delivery、shares、cron 的自有存储仍在 KV。加密材料仍走 `env.DATA` 的 `system:crypto` 路径，算法与密文格式未改。未对远程 D1 执行 wrangler 命令，也未改名为 `subpanel` 的另一套库。

## 接口形状变化

读写 catalog / apps 的函数第一参数由 `KVNamespace` 改为 `DataEnv`（`DATA` + `DB`）。`Env` 满足该类型，路由传入 `c.env`。

- Catalog：`readCatalog`、`writeCatalog`、`summarizeSources`、`createSource`、`replaceSourceContent`、`updateSource`、`refreshSource`、`deleteSource`、`recompileDelivery`
- Apps：`readApps`、`writeApps`、`readAppsState`、`createApp`、`updateApp`、`deleteApp`、`createPlatform`、`updatePlatform`、`deletePlatform`
- 编译与投递中读 catalog 的入口：`compileSubscription`、`compileAllSubscriptions`、`compileSubscriptionById`、`recompileAfterCatalogChange`、`createSubscription`、`updateSubscription`、`setSubscriptionEnabled`
- Cron：`runCron`
- 分享里读 catalog 并编译的入口：`readShareMeta`、`exportShare`（内部 `loadShareArtifact`）

仍以 `KVNamespace` 读写的有 delivery 快照、编译缓存、分享记录、账户、cron 状态，以及导入时的 `readCatalogKv` / `readAppsKv`。新增管理员接口 `POST /api/admin/migration/run`，body `{ module: "catalog" | "apps" }`，挂在既有 admin 中间件下。校验失败返回 409，文案为「Catalog 快照无法读取」「Catalog 迁移校验未通过」「应用快照无法读取」「应用迁移校验未通过」，句末没有句号。

## 导入策略与幂等

入口是 `runModuleImport`。顺序：读当前 KV 快照 → 第一批 `convertCatalog` / `convertApps` → `persistCatalogSnapshot` / `persistAppsSnapshot` 写入 D1 → 回读快照并核对行数 → 通过后才把 `catalog_d1_ready` 或 `apps_d1_ready` 写成 JSON `true`。完成标记不在数据 batch 里，校验失败时读者仍走 KV。

幂等办法是按模块整表替换，主键不会重复：

- Catalog：关联表与 `nodes` 先清空再插入。`sources` 与 `groups` 按主键 upsert，再用 `json_each` 删掉快照里已不存在的 id，避免每次保存清空 `cron_runs.source_id`，也避免把仍然存在的 group 上未来的 `subscription_groups` 整表级联删掉。被快照移除的 group 仍会级联删除对应 `subscription_groups`。
- Apps：`app_platforms` 与 `apps` 先清空再插入。应用目录没有外部外键。
- 父数组顺序（sources、nodes、groups、apps、platforms）写入 `catalog_entity_order` 与 `apps_entity_order`。关联数组的 `position` 仍在关系表，从 0 起，与数组下标一致。

重复导入会再次从 KV 装载并覆盖 D1。标记已置位之后再导入，会丢掉其间只写在 D1 上的修改。导入不增加 revision，也不删除 KV。KV 在标记置位后不再被在线读写。

在线 `writeCatalog` / `writeApps` 仍先做 Zod 校验、revision + 1、`updatedAt` 与体积上限，再按标记只写一个后端。标记缺失，或 `system_settings` 表还不存在，走 KV。标记存在但 JSON 不是 `true`，抛出 `Setting value is corrupt`。没有双写。

## grep 自证

`worker/catalog` 与 `worker/apps` 里 `env.DATA` 只出现在下面三处。

标记未置位时的 KV 回退（置位后这两支不执行）：

- `worker/catalog/repository.ts`：`readCatalogKv(env.DATA)`、`writeCatalogKv(env.DATA, …)`，键 `state:catalog`
- `worker/apps/repository.ts`：`readAppsKv(env.DATA)`、`env.DATA.put(APPS_KEY, …)`，键 `state:apps`（常量定义在 `worker/apps/schema.ts`）

加密材料，路径未改：

- `worker/catalog/import-service.ts` 七处 `readCryptoMaterial(env.DATA)` / `getOrCreateCryptoMaterial(env.DATA)`

delivery 仍在 KV，这两处不是 catalog 状态：

- `worker/catalog/routes.ts`：`readDelivery(c.env.DATA)`、`removeGroupReference(c.env.DATA, id.data)`

`worker/apps` 下没有第三处 `env.DATA`。service、routes、cron 刷新与手动同步都经 repository。

## 与 SCHEMA.md 的偏差

未改 `docs/d1/SCHEMA.md`。

- 绑定按本批补充：`database_name` 为 `subpanel-d1`，`database_id` 为 `d8360141-8f44-4550-8656-5931231bb020`。SCHEMA 写的是 `subpanel` 与全零占位 id。`wrangler.jsonc` 与 `wrangler.test.jsonc` 都指向该 id。测试池使用本地 D1。
- 新增完成标记 `catalog_d1_ready`、`apps_d1_ready`，值为 JSON `true`。
- 新增 `catalog_entity_order`、`apps_entity_order`。sources、nodes、groups、apps、platforms 没有父级 position 列，数组顺序放在 system_settings。关系表的 position 与 SCHEMA 一致。
- 导入完成标记是上述 ready 键。本批不写 `migration_runs`。
- SCHEMA 文首「本批不切换业务读写」是第一批范围。本批切换 catalog 与 apps。`DATA` 绑定保留给其余模块和密钥。
- 从 catalog 快照中删除的 group 会级联删除 `subscription_groups`。delivery 本批仍不入库。

## 测试与构建

`npm test`：40 个文件、272 条通过。新增 `development/tests/worker/d1-catalog-apps.test.ts` 覆盖 KV/D1 两态、快照深比较、行数与分组顺序、重复导入、create/delete 后 KV 不被在线写入、管理员接口 401/403/200。既有 catalog、apps、cron、delivery、shares、user-nodes 测试在 D1 标记打开后跑过，断言未放宽。`catalog-migration.test.ts` 保持标记关闭，继续验证 KV 上的 v1→v2。

`npm run check` 通过：`wrangler types --check`、`tsc -b`、oxlint 0 warning。`npm run build` 通过。

`development/tests/worker/smoke.test.ts` 在收集阶段失败，3 条用例没有执行。错误是 `ENOENT: open '../../public/_headers'`，栈落在 `node_modules/@cloudflare/vitest-pool-workers`。本工作树的 `node_modules` 是指向 `/data/workspace/subpanel-integ/node_modules` 的符号链接。`public/_headers` 在本仓库和该目录都存在。这是 brief 允许单独说明的 smoke `_headers` 环境问题，与本次存储切换无关，没有改这条测试。
