# 统一订阅 PR3

分支 `task/sub-unified-pr3`，基底 `origin/main` 的 `cbd3465`。生产切换结论为 **NO-GO**。`unified_subscription_ready` 和 `unified_subscription_public_ready` 默认关闭。仅隔离的本地测试夹具开启了两个开关，旧表和旧发行记录均保留。

工作授权已记录。Roye 于 2026-11-24 15:56 自批运行和推送代码，21:19 要求实施完整方案，21:31 确认执行，21:44 要求继续且无需重复确认。本次交付使用本地 Git bundle。数据库删除、账号更换及生产数据操作仍在授权范围之外。

## 实现与文件

| 文件 | 变更 |
|---|---|
| `migrations/0027_unified_subscription_operations.sql` | 扩展兑换批次和回执，新增计划关联、用户提醒及独立分享表。旧兑换回执通过兼容视图读取 |
| `worker/redemption/service.ts`、`routes.ts` | 新批次关联当前模板并保存发行承诺时长，兼容旧版本选择器。新兑换以绑定为授权对象，支持永久、过期续期、并发重试和原回执重放 |
| `worker/delivery/bindings.ts`、`user-access.ts` | 复用用户级 revision 比较与绑定事务，允许兑换和批量把额外写入放进同一批次。两开关同时开启才允许面向用户的统一变更 |
| `worker/delivery/plans.ts`、`plan-routes.ts`、`aggregate.ts` | 提供计划到共享授权模板的关联，试用使用注册事务创建凭据和绑定，旧计划接口适配到绑定。解析器按授权执行额度资格和限制检查 |
| `worker/shares/schema.ts`、`repository.ts`、`service.ts`、`routes.ts`、`worker/migration/shares.ts` | 支持用户范围与单模板范围，沿用登录、密码、截止时间、次数和开关，保留独立分享凭据，事务化次数与撤销及审计。旧分享在原路径保留历史范围，统一公开路径开启时暂停旧分享 |
| `worker/delivery/subscription-batch.ts`、`compile-jobs.ts` | 按用户预检、绑定、续期、暂停和撤销，复用任务租约、分项记录、失败重试及幂等。历史复制或转移任务无法执行 |
| `worker/delivery/unified-routes.ts`、`fetch-stats.ts`、`shadow.ts`、`worker/admin/service.ts`、`worker/accounts/admin-routes.ts` | 按用户汇总获取统计并保留旧订阅统计键，提醒基于当前有效授权最远到期，增加影子操作计数及分享待核对原因。回收和恢复沿用用户状态过滤，有绑定历史时永久清理请求返回明确冲突 |
| `src/features/delivery/MySubscriptionsPage.tsx`、`SubscriptionBatchJobs.tsx`、`src/features/redemption/PersonalRedemptions.tsx`、`api.ts`、`src/features/shares/ShareDrawer.tsx`、`api.ts` | 在原布局中复用兑换回执、分享表单和任务对话框，提供统一分享及全部撤销操作 |
| `development/tests/worker/d1.ts`、`d1-foundation.test.ts`、`subscription-v2-p3.test.ts`、`unified-subscription.test.ts`、`development/test-unified-operations.mjs` | 更新迁移夹具，验证同码抢占、多码续期、重复请求、回滚、额度过滤与真实浏览器用户流程 |

统一兑换保留 12 位、4-4-4 三组格式。续期事务以单调的用户 revision 作比较条件。竞争失败时重新读取当前到期时间并重算，在同一 D1 原子批次内写入绑定、核销计数、回执、审计和新 revision。核销条件不成立时触发约束回滚。旧码按发行时承诺继续读取原版本，兑换回执保持原形状。

## 迁移、风险与回滚

- 0027 扩展兼容 schema。新的兑换回执使用 `(user_id, template_id)` 标识绑定并保存前后到期时间。历史发行 ID 保持在旧回执。先备份并验证可恢复，再单独应用 0027，之后部署消费者
- 有可用授权时，同一节点只输出一次。额度受限的授权在缺少真实计量时不提供节点。设备或旧计划速度策略无法证明实施语义时拒绝输出。流量保持未知，旧统计数据与原 ID 保持。订阅到期限制再次获取配置，已下载的共享节点凭据仍由节点端管理
- 旧分享在原路径保持历史订阅范围。打开统一开关后，旧分享暂停并提示重新创建，新分享使用明确的范围。影子发现存在活跃旧分享时要求人工核查。有效旧链接、分享或兑换承诺无法安全兼容的用户继续暂缓，保留 90 天兼容期安排
- 历史版本、重复或无归属记录逐项确认，能够无损表达的使用独立专属兼容模板。节点组删除继续受当前模板及尚有效的旧发行引用保护
- 两开关保持关闭时，可直接回退 Worker 并保留新增数据表。若将来打开开关并产生统一侧写入，先关开关隔离入口，核对新回执、用户授权、分享及审计后再决定前向修复或按演练恢复。增量迁移、对账或恢复失败时保留旧权威路径

## 验证记录

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过，0 错误。前端仍有 lint 警告 |
| `npm run build` | 通过。Vite 报告客户端入口分块大于 500 KB |
| `CI=1 npm test` | 68 个文件通过，586 个测试通过，4 个测试按配置跳过 |
| D1 全量 | 从空状态运行 `npx wrangler d1 migrations apply subpanel-d1 --local`，应用至 0027，再设置五个 D1 模块标志。环境拦截了递归删除命令，实际将旧本地状态移出后从空状态重建 |
| D1 增量与恢复 | 在有既存模板的独立 0026 夹具单独应用 0027。原记录保留，完整性及外键检查通过。在浏览器夹具另做 SQLite 备份及恢复，核对 2 条绑定、2 条兑换回执、2 条分享、1 条计划关联及 4 条绑定请求 |
| Chromium 1440 / 390 | 使用 `npx vite preview --port 4179 --strictPort --host 127.0.0.1`。两档通过邀请码注册后的试用时长验证、兑换、分享页面与配置导出、原始链接导出拒绝、全部撤销和批量续期。结束后移除本地两个统一开关 |
| 截图 | `development/screenshots/sub-unified-pr3/`，兑换、分享和批量各两张，共 284 KB |

首次浏览器尝试跟随迁移预置的外部域名打开本地生成的分享地址，得到 404。该次导航使用一次性本地夹具标识，无生产登录或写入操作。之后清除本地预置主域名，浏览器用例拒绝非本地源的请求。

## 影子验证

| 范围 | 一致 | 不一致 | 可切 | 暂缓 |
|---|---:|---:|---:|---:|
| 本地自动化三种场景 | 1 | 2 | 1 个等价夹具 | 2 个夹具 |
| 本地浏览器同一用户三次观察 | 1 | 2 | 初始试用兼容基线一致 | 两轮兑换及续期后到期窗口不同，该用户最终暂缓 |
| 生产 | 未测 | 未测 | 0 | 全部等待逐户核验 |

- 等价夹具的动态组节点、时效窗口和各格式输出一致。旧方案限制场景检测到 `PLAN_POLICY_UNVERIFIED`，受限授权未提供节点，也未生成流量用量。活跃旧分享场景检测到 `LEGACY_SHARE_SCOPE_REVIEW_REQUIRED`
- 浏览器初始试用与同窗口旧发行一致。两轮均完成兑换、分享导出及撤销、批量续期。影子结果观察到新增授权带来的 `WINDOW_DIFFERS`，结束时该用户有两条兑换回执和两条批量绑定请求
- 生产限额等价性仍需实际计量、节点侧速度与设备策略及历史授权范围的核验。没有取得生产快照，兼容期尚未开始

SUB_UNIFIED_PR3_DONE
