# SubPanel 统一订阅 PR6 准备报告

审计基底为 `origin/main` 的 `de7f7e6ff`，工作分支为 `task/sub-unified-pr6`。本次未删除任何东西、未动生产。仓库的表定义、迁移、Worker、旧链接和生产 D1 保持原状。下文的重建验证使用独立本地 D1 副本，副本中的原订阅行全部保存在归档表。生产切换仍为 **NO-GO**，部署 13425700 和生产已应用 0028 来自交接记录，本次未连生产核验。

## 外键与应用依赖

对基底应用全部迁移，枚举每张表的 `foreign_key_list`，再核对 `sqlite_schema` 的触发器、视图、索引和相关 Worker 读写。查到六条指向 `subscriptions(id)` 的外键。六张子表均无进一步的入向外键。父表通过 `user_id`、`plan_id` 引用 `users`、`plans`，均为 `RESTRICT`，归档保留这两条约束。

| 对象 | 实查结论 | 正式收缩前处理 |
| --- | --- | --- |
| `shares` | 外键已迁移干净。0003 删除了旧订阅外键，所有者仍引用 `users`。需人工处理应用依赖 | `worker/shares/service.ts` 仍按旧订阅 ID 查找授权、旧分享及原链接。复核历史分享的有效承诺、过期和兼容路径，再退役旧读写 |
| `redemption_records` | 仍依赖 `subscription_id`，`SET NULL`。另有无外键的 `issued_subscription_id` 和指向 `redemption_codes` 的外键 | 用归档外键保住完整历史 ID 和原回执。先停用旧发放路径，暂移并恢复 `all_redemption_records` 联合视图，核对回执及重放 |
| `compile_job_items` | 无旧订阅外键，`job_id` 引用 `compile_jobs`。仍有应用依赖 | `subscription_id` 在旧任务保存订阅 ID，在统一批任务保存用户 ID，`copy_id` 等历史字段也需保留。冻结旧入口、排空任务、保留任务与审计。统一操作在 `subscription-batch.ts` 自行写入用户审计 |
| `subscription_creation` | 仍依赖 `subscription_id`，`SET NULL` | 保留来源和请求幂等字段，迁移到归档外键。先退役旧创建和历史来源的实时读取 |
| `subscription_template_origins` | 仍依赖 `subscription_id`，`CASCADE`，另有权益版本 `RESTRICT` 外键 | 保留旧订阅到权益版本出处，更新归档外键。旧发放结束后退役相关触发器 |
| `subscription_nodes` | 仍依赖 `subscription_id`，`CASCADE`，另有指向 `nodes` 的延迟外键 | 保留节点关联及位置，迁移到归档外键。先迁移旧投递、账号与目录相关查询 |
| `subscription_groups` | 仍依赖 `subscription_id`，`CASCADE`，另有 `group_id` 的 `CASCADE` 外键 | 保留分组关联、顺序和索引，迁移到归档外键。重建期间暂移并恢复 `entitlement_group_in_use`，保留权益模板和历史分组保护 |
| `unified_subscription_mappings` | 0028 新增 `legacy_subscription_id` 的 `RESTRICT` 外键，另引用用户和权益模板 | 保留映射、源版本和原授权范围，迁移到归档外键。旧链接还会在兼容期读取此表和旧订阅，需待兼容窗口结束 |
| `unified_subscription_checkpoints` | 无旧订阅外键。触发器仍查询旧订阅快照 | 结束旧回填和暂缓项处理后退役守卫，保留检查点和用户、操作者外键 |
| `subscription_template_bindings`、`conversion_bindings` | 无旧订阅外键，仍以订阅 ID 查找转换覆盖 | 人工核对转换配置及发布版本。保留 `subscription_templates`、版本、默认指针、转换配置和视图，以及独立的 `entitlement_templates` 和版本 |
| `subscription_plan_migration`、`audit_logs` | 无旧订阅外键，保存旧 ID 的迁移历史或审计标识 | 保留记录。核验计划相关查询、限额等价性、审计和回放读取 |

`subscriptions` 自身无挂载触发器。旧写路径相关触发器包括 `entitlement_origin_can_issue`、`private_entitlement_legacy_origin`、`subscription_node_enabled` 和 `unified_subscription_checkpoint_guard`。`subscription_batch_item_audit` 把旧订阅 ID 写成审计目标，移除前需确认旧批任务已停。保留 `compile_job_created`、`compile_job_progress`、`compile_job_cleanup`，它们依赖任务和任务项。保留 `redemption_group_in_use`、权益版本不可变性、权益模板验证、统一绑定和兑换保护，以及转换同步触发器。四个视图中，需随重建暂移并恢复的是 `all_redemption_records`，三个转换视图保持原样。

代码下线的核对范围还包括 `worker/public-subscriptions.ts`、`worker/delivery/legacy-compatibility.ts`、投递 D1 仓储、计划和到期处理、账户、目录、管理端统计、转换查找、影子对账、KV 搬迁与系统入口。两项统一就绪开关无法覆盖这些存量调用。全量回归通过代表当前版本基线通过，当前 Worker 仍不能与收缩后的 schema 搭配上线。

## 经本地 D1 验证的删除顺序

1. 正式收缩先完成观察期、90 天兼容窗口及应用依赖迁移，冻结旧写入并排空任务，建立和演练新恢复点，取得 Roye 明确批准。核对当前 schema 与基线，确认归档保留政策及其对用户、计划、节点和分组删除的影响。
2. 保持外键启用。在单个原子 D1 批次中建立 `legacy_subscriptions_archive`，复制原订阅所有列，保留约束及对应索引。
3. 退役旧回填、旧发放、旧节点写入和旧批任务审计触发器。暂移 `all_redemption_records` 和 `entitlement_group_in_use`，避免表重建的中间状态引用暂时不存在的表。
4. 依次重建 `redemption_records`、`subscription_creation`、`unified_subscription_mappings`、`subscription_template_origins`、`subscription_nodes`、`subscription_groups`。这六张表互无外键依赖。每张创建新表并把旧订阅外键指向归档，复制行，再替换原表、恢复索引。恢复兑换联合视图和分组保护触发器。
5. 最后删除旧业务父表。复核前后行数、回执、全部入向外键和归档关联。正式收缩成功后，若需回退，在隔离库恢复收缩前 D1、KV 和配置或执行验证过的反向迁移，重放恢复点后的权威写入，按用户对账后再切流。已切换环境禁止直接部署旧 Worker。

本地 Wrangler D1 使用单独的演练 SQL 副本验证上述顺序。缺少有效切换时间时，批次以约束错误中止并回滚。先删父表的反向用例以外键约束失败，父表仍有 4 行。正向演练在还原库的独立副本补了映射、节点、权益出处测试行，并确保兑换外键非空。重建前后各 72 张表、700 行，逐表逐行一致。六条外键全部指向归档，兑换视图结果 1 行且一致，完整性为 `ok`，外键违规 0。

## PR5 生产备份本地恢复

输入保存在 `/data/tmp/pr6-rehearsal/subpanel-d1-backup-20261124-unified-pr5.sql`，259 KB，SHA-256 为 `1a15f002bc224866e030e029c6024dbae95677a1611fead99ca147ad686b4aaf`。移动的是本机输入副本，hwsg 原件未动。向空 SQLite 导入后重新开启外键检查，`integrity_check` 返回 `ok`，`foreign_key_check` 返回 0 条。导出中的 694 条顶层行插入与 26 张非空表逐表计数一致。

| 关键项 | 原状恢复 | 隔离副本应用 0028 后 |
| --- | ---: | ---: |
| 表数（含 `d1_migrations`，不含 SQLite 内部表） | 70 | 72 |
| 总行数 | 694 | 694 |
| 用户 / 旧订阅 / 旧分组关联 | 2 / 4 / 9 | 2 / 4 / 9 |
| 旧创建记录 / 旧节点关联 / 权益出处 | 3 / 0 / 0 | 3 / 0 / 0 |
| 目录节点 / 分组 / 来源 | 69 / 8 / 4 | 69 / 8 / 4 |
| 权益模板 / 权益版本 / 用户模板绑定 | 2 / 2 / 0 | 2 / 2 / 0 |
| 旧兑换批次 / 旧兑换码 / 旧兑换回执 | 1 / 1 / 1 | 1 / 1 / 1 |
| 分享 / 统一分享 / 绑定兑换回执 | 0 / 0 / 0 | 0 / 0 / 0 |
| 统一访问 / 映射 / 检查点 | 0 / 表不存在 / 表不存在 | 0 / 0 / 0 |
| 审计 / 迁移台账 | 42 / 0 | 42 / 0 |
| 显式索引 / 触发器 / 视图 | 82 / 24 / 4 | 83 / 25 / 4 |
| 外键违规 | 0 | 0 |

补 0028 后逐行核对 70 张既有表，数据一致。表、索引、触发器和视图名称及类型与全量本地 D1 一致。备份反映的是 0028 之前的结构，交接所述 72 张生产表对应补 0028 后的结构。该输入仅覆盖 D1 SQL 数据。切换后的权威写入重放及 KV/配置恢复需纳入正式收缩前的新演练。

## 本地复验

| 项目 | 结果 |
| --- | --- |
| `npm run check` | 退出 0，66 条 lint 警告，无错误 |
| `npm run build` | 退出 0，构建成功，有既有分包体积提示 |
| `CI=1 npm test` | 退出 0，68 个测试文件通过，591 条通过，4 条跳过 |
| 空 D1 全量迁移 | Wrangler 4.166.0，27 个实际迁移文件至 0028，72 张应用及台账表，7 个本地就绪标志，完整性 `ok`，外键违规 0 |
| 本地 D1 增量重应用 0028 | 独立持久化库先应用 26 条至 0027，再单独应用 0028。哨兵行保留，累计 27 条，72 张应用及台账表，7 个本地就绪标志，完整性 `ok`，外键违规 0 |

共享依赖初次构建通过，但首次检查因 Wrangler 版本造成类型生成校验失败，首次测试因缺少插件而未启动。移出当前工作树的共享依赖链接后用 `npm ci` 安装本分支锁定版本，复验以重跑结果为准。迁移编号跳过 0013，因此实际迁移文件是 27 条。复验使用全新的本地持久化目录。

## 交付文件

- [待批准、未执行的删除 SQL](docs/unified-subscription-pr6-delete-PENDING-APPROVAL-NOT-EXECUTED.sql) 位于 `docs/`。交付路径下的 SQL 未作为迁移提交或执行。演练使用独立本地副本。
- [统一订阅迁移与回滚](docs/unified-subscription-migration.md) 补充收缩门槛、顺序、恢复数据和回滚步骤。
- [D1 结构与 bootstrap](docs/d1/SCHEMA.md) 补充 0028 当前初始化、就绪标志及未来收缩后的检测和夹具更新要求。

SUB_UNIFIED_PR6_PREP_DONE
