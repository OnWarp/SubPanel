# SubPanel PR6 全量收缩报告

开发分支为 `task/sub-unified-pr6-full`，基底为 `c57d6778d`。交接记录显示生产于 2026-11-25 19:36:52（UTC+8）切换，两个统一就绪开关均为 true。本线只在本地隔离 D1 执行 SQL，生产 D1、部署和 main 均未操作。旧链接兼容窗口的 90 天等待已获授权豁免。回归状态见下文，当前分支仍有发布前待解决项。

## 外键与应用依赖复核

从指定的 275 KB 预切换备份恢复到隔离库。SHA-256 为 `22b52f8f5cf811da899804661e2ac3b96a7f9c8977435522c7fa8857f66290c7`。备份有四条已回填映射、四条绑定及一个检查点，缺少切换后的两项就绪标志。按交接值在隔离副本补入就绪标志，原备份未改动。准备报告中的切换前 NO-GO 和等待 90 天的判断已由生产切换记录和明确豁免更新。

| 准备报告审计项 | 隔离备份实测与处理 |
| --- | --- |
| `subscriptions` | 4 行。归档逐行复制，保留用户与计划的 RESTRICT 外键 |
| `shares` | 0 行，无订阅外键。旧订阅 ID 的访问、创建与原链接停止，统一分享使用用户及绑定范围 |
| `redemption_records` | 1 行，订阅外键仍为 SET NULL，重建改指归档。原回执字段、兑换码外键和联合视图保留 |
| `compile_job_items` | 0 行，只引用编译任务。历史任务与审计仍可查询，旧编译入口停用，统一授权任务沿用现有表 |
| `subscription_creation` | 3 行，SET NULL 改指归档，保留幂等和来源 |
| `subscription_template_origins` | 0 行，CASCADE 改指归档，仍引用现行权益版本 |
| `subscription_nodes` | 0 行，CASCADE 改指归档，保留节点的延迟外键 |
| `subscription_groups` | 9 行，CASCADE 改指归档，保留分组关联、顺序和约束 |
| `unified_subscription_mappings` | 4 行，RESTRICT 改指归档，保留用户与模板外键以及迁移时节点范围 |
| `unified_subscription_checkpoints` | 1 行，无旧订阅外键，保留历史和用户、操作者约束，退役查询旧快照的守卫 |
| `subscription_plan_migration` / `audit_logs` | 0 / 44 行，均无旧订阅外键，逐行保留 |
| `subscription_template_bindings` / `conversion_bindings` | 各 0 行，均无旧订阅外键。订阅 ID 的转换覆盖随旧模型退役 |

六张子表没有额外入向外键。退役 `unified_subscription_checkpoint_guard`、`subscription_batch_item_audit`、`entitlement_origin_can_issue`、`private_entitlement_legacy_origin` 和 `subscription_node_enabled`。重建期间暂移并恢复 `all_redemption_records` 及 `entitlement_group_in_use`，保留任务进度和清理触发器、兑换与权益约束。

## 旧模板与转换影响

| 旧模板表 | 备份行数 | 读取方、外键及处理 |
| --- | ---: | --- |
| `subscription_templates` | 0 | 模板 API、仓储、批处理及规则用量查询。版本、默认、绑定及 `conversion_profiles.legacy_template_id` 引用它。撤下 API 与 UI，移除转换目录视图和插入同步触发器 |
| `subscription_template_versions` | 0 | 模板 API 与仓储、规则用量、发布版本及转换输出。转换版本和规则快照引用它，撤下输出视图、同步触发器和空依赖表 |
| `subscription_template_default` | 1 | 单例指针为 NULL。模板仓储、批处理、投递及旧模板 API 曾读取默认配置，统一输出使用内置渲染 |
| `subscription_template_bindings` | 0 | 旧投递、模板仓储、批处理、迁移回填、影子对账和账户清理曾读写。删除统一转换绑定视图后移除 |

三个转换视图是 `conversion_profile_catalog`、`conversion_profile_outputs`、`conversion_effective_bindings`。它们和两条同步触发器均随旧模板退役。隔离备份中 `conversion_profiles`、`conversion_profile_versions`、`conversion_rule_version_snapshots` 和 `conversion_bindings` 均为 0 行。SQL 对每张待删除的配置及转换依赖检查空状态，遇到新增配置即中止。独立规则源和本地规则集表保留。

## Worker 与管理端

- 撤下旧订阅增删改查、旧公开兼容入口、旧模板管理、影子对账、回填和订阅 KV 导入入口，移除管理端对应入口
- 统一预览、下载与分享采用内置渲染，旧分享仅保留管理记录，停止访问和创建。统一令牌使用自己的唯一约束
- 计划分配、试用、续期、撤销、到期提醒和管理端统计读取统一绑定。账户列表使用统一绑定计数，保留归档外键约束下的账户与计划历史
- 目录预览按权益模板引用报告影响，目录写入不查询旧订阅。我的节点从统一授权计算，保留搜索、分页及授权与分组筛选
- 兑换保留历史回执和幂等重放。新的兑换只走统一模板绑定。备份中旧批次没有尚可核销的兑换码。批量授权保留，提交后留在进度窗口以便执行，旧编译和旧批任务无法重新执行
- 用户请求统计从归档查找历史计数键，同时保留统一统计。生产运行入口不再装载旧公开路由。旧实现模块仍可在源码中供历史测试及维护参考

## SQL 和回滚

[收缩 SQL](docs/unified-subscription-pr6-full-NOT-EXECUTED.sql) 保留两项就绪标志和无 queued/running 编译任务的守卫，移除 90 天门槛。它只作为受控发布批次交付。完整空库迁移至 0028 后，在同一隔离库中单独执行收缩。缺少就绪标志、存在排队任务、存在转换记录三种负向用例均中止，四条旧数据保留，未遗留守卫或归档表。

[回滚方案](docs/unified-subscription-pr6-full-rollback.md) 以执行前的 D1、KV 与配置恢复点为基准，重放恢复点后的权威写入并逐用户对账。本次验证了 D1 备份可恢复以及收缩批次的成功和失败路径。真实生产 KV、密钥版本恢复及切换后写入重放仍待发布方独立验证。

冻结范围外的 `entitlement_templates`、`entitlement_template_versions`、`private_entitlement_templates`、`user_template_bindings`、`plans`、`mail_templates`、`users`、`nodes`、`groups`、`audit_logs` 和 `subscription_plan_migration` 在 SQL 前后逐行一致。

## 隔离复验

| 项目 | 结果 |
| --- | --- |
| `npm run check` | 退出 0，Wrangler 4.166.0，66 条 lint 警告。共享依赖为 Wrangler 4.114.0，改用锁文件安装后复验通过 |
| `npm run build` | 退出 0，Vite 产生既有分包大小提示 |
| `CI=1 npm test` | 52 文件通过、16 文件失败，501 通过、90 失败、4 跳过。基底报告为 591 通过、4 跳过。旧订阅、模板、分享、编译与兼容期断言，以及仍使用 0028 未收缩 schema 的部分夹具失败，旧测试未被删减 |
| D1 空库全量 | Wrangler 本地应用 27 条迁移至 0028 后执行 PR6，完整性 ok，外键违规 0 |
| D1 存量增量 | 应用至 0027，插入哨兵，再单独应用 0028 和 PR6。哨兵保留，完整性 ok，外键违规 0 |
| D1 备份收缩 | 使用 Wrangler 单次本地批次，72 张表变为 64 张，六条改指归档的外键均存在，兑换联合视图逐行一致，完整性 ok，外键违规 0 |
| 快照 Worker 与 Chromium | 在收缩后的备份副本使用隔离凭据，管理员登录与用户详情成功，四条绑定可读。目录有 69 条物理记录，统一摘要经授权筛选与连接去重后为 63 条。Generic、Mihomo、sing-box 均返回 200，输出约 21 KB、20 KB、31 KB。旧 `/sub` 对 HTML 与订阅客户端均返回 404 |
| 空库收缩后的 Chromium 业务回归 | 1440 和 390 两种视口均通过。验证注册试用、统一兑换、分享创建和导出及撤销、在管理端预览和执行批量续期 |
| Playwright 全量浏览器套件 | 122 个用例中 66 通过、35 失败、21 在串行前置用例失败后未运行。失败包含已退役转换页面、缺少初始化密钥输入的旧夹具和旧订阅页面断言。全量回归未通过 |

## 备份逐表核对

除旧模板及其转换表的退役、旧订阅更名归档外，以下存续表在收缩前后逐行一致。39 项设置含隔离副本补入的两项就绪标志。

| 表 | 行数 | 表 | 行数 |
| --- | ---: | --- | ---: |
| `allowed_email_domains` | 0 | `node_raw_variants` | 76 |
| `app_platforms` | 0 | `nodes` | 69 |
| `apps` | 1 | `notices` | 0 |
| `audit_logs` | 44 | `panel_domains` | 1 |
| `binding_redemption_records` | 0 | `plan_groups` | 1 |
| `catalog_sync_leases` | 0 | `plans` | 1 |
| `catalog_sync_runs` | 0 | `private_entitlement_templates` | 4 |
| `compile_job_items` | 0 | `rate_limits` | 11 |
| `compile_jobs` | 0 | `redemption_batches` | 1 |
| `conversion_local_rule_sets` | 0 | `redemption_codes` | 1 |
| `conversion_rule_sources` | 0 | `redemption_records` | 1 |
| `cron_runs` | 1 | `shares` | 0 |
| `d1_migrations` | 0 | `sources` | 4 |
| `email_change_requests` | 0 | `subscription_creation` | 3 |
| `email_verifications` | 0 | `subscription_domains` | 2 |
| `entitlement_plan_policies` | 0 | `subscription_groups` | 9 |
| `entitlement_template_versions` | 6 | `subscription_nodes` | 0 |
| `entitlement_templates` | 6 | `subscription_plan_migration` | 0 |
| `group_node_order` | 334 | `subscription_platform_settings` | 13 |
| `group_nodes` | 67 | `subscription_template_origins` | 0 |
| `group_sources` | 0 | `system_settings` | 39 |
| `groups` | 8 | `ticket_replies` | 0 |
| `invitation_redemptions` | 0 | `tickets` | 0 |
| `invitations` | 0 | `unified_subscription_checkpoints` | 1 |
| `invite_code_redemptions` | 0 | `unified_subscription_mappings` | 4 |
| `invite_codes` | 0 | `user_binding_requests` | 0 |
| `kb_articles` | 0 | `user_entitlements_legacy` | 0 |
| `kb_categories` | 0 | `user_subscription_access` | 1 |
| `legacy_subscriptions_archive` | 4 | `user_subscription_reminders` | 0 |
| `mail_broadcasts` | 0 | `user_subscription_shares` | 0 |
| `mail_templates` | 0 | `user_template_bindings` | 4 |
| `migration_runs` | 0 | `users` | 2 |

## 已知遗留

旧测试夹具和部分历史用例仍绑定旧模型及旧界面。完整回归结果是发布前待解决项。需要补齐收缩版夹具、更新已退役行为的断言，并区分仍适用的业务回归。单独隔离验证使用临时凭据和本地 KV，未使用生产密钥。一次本地运行日志记录了合成订阅令牌，已清理该日志与隔离库。归档保留原外键，因此引用历史的用户和计划仍受到永久删除限制。

## 交付

实现提交 `1a955716e055a1c25604b5b8a33ac6a437fe6ca6` 已推送至 GitHub 的 `task/sub-unified-pr6-full`。完整历史 bundle 包含这个分支引用及实现提交。本报告是后续交付记录，单独随分支提交与传输，便于记录 bundle 自身的校验和。

| 位置 | SHA-256 |
| --- | --- |
| 本机 `/data/tmp/sub-unified-pr6-full.bundle` | `a11ad50656e3839dc2864ad8570cf89d921b41bc64b89b41809b1eaa4d7b39d8` |
| hwsg `/root/xfer/sub-unified-pr6-full.bundle` | `a11ad50656e3839dc2864ad8570cf89d921b41bc64b89b41809b1eaa4d7b39d8` |

SUB_UNIFIED_PR6_FULL_DONE
