# 权益与订阅合并交付报告

基线为 `8b52c572cb0852a591f18c454fd943e31ce9cd79`。交付前经 GitHub Compare 核实 `main` 仍为该提交。生产库和部署均未操作。交付提交保存在可写 Git 仓库的 `task/plan-entitlement-merge` 分支，通过 `/tmp/plan-entitlement-merge.bundle` 交接。原 worktree 的 Git 管理目录是只读的，原分支引用仍位于基线。

`plans` 和 `plan_groups` 是订阅计划目录。计划保留原字段语义。订阅记录承载归属、计划、流量额度、限速、设备数、时间窗、启用状态以及到期提醒记录。计划编辑同步订阅配额快照。原实现只有下发限速，没有流量计量或设备计量，合并后保持这项行为。到期继续走订阅禁用流程，保留订阅行。

## 迁移 0018

| 源记录 | 目标 | 取舍 |
| --- | --- | --- |
| 用户有现存订阅，且有 active 权益 | 该用户现存的每个订阅 | 旧下发按用户共用同一权益。把计划、配额和权益到期写到每条原订阅，原令牌、名称、分组、客户端、模板绑定和分享关系随原 ID 保留。原先禁用的订阅继续禁用。 |
| 用户有现存订阅，权益都已收回 | 该用户现存的每个订阅 | 用最新一条旧记录保留计划、配额和时间窗，禁用订阅并标记收回，避免恢复原本没有的访问。 |
| 用户没有现存订阅 | 新建已分配订阅 | 复制计划配额、时间窗、来源、备注和提醒记录。使用计划分组与默认 Mihomo 客户端。通过首次鉴权查看生成并保存常规加密令牌。 |
| 同用户其余历史行 | 每条历史行各新建一条禁用订阅 | 保留收回状态、旧时间窗、来源、备注和提醒记录，原始数据也随表保留。 |
| 没有旧权益覆盖的订阅或未分配订阅 | 原订阅 | 保留原窗口、启用状态和所有链接数据。计划可在管理端配置。 |
| 全部旧权益 | `user_entitlements_legacy` | 原表直接改名。运行时的可用性、配额、统计、注册和下发均读取或写入订阅。 |

SQLite 将旧 ISO 时间转换为 Unix 毫秒。已有订阅到期与权益不一致时，取权益到期。生效取原订阅与权益中较晚的时间，原生效晚于新到期时将生效钳到新到期，使窗口为空。逐条映射、原生效、原到期和原启用值记录在 `subscription_plan_migration`，原时间窗与权益文本均可复核。造数验证的冲突逐行如下。

| 旧行 | 目标行 | 原订阅到期 UTC | 最终到期 UTC | 状态取舍 |
| --- | --- | --- | --- | --- |
| `legacy_current` | `sub_3` | 2026-04-01 00:00:00.000 | 2026-02-01 00:00:00.456 | 保留启用 |
| `legacy_current` | `sub_4` | 2026-04-01 00:00:00.000 | 2026-02-01 00:00:00.456 | 保留禁用 |
| `legacy_past` | `sub_7` | 新行 | 2026-02-01 00:00:00.456 | 历史收回，禁用 |

生产行未读取。集成时先备份数据库与订阅 KV。在备份副本确认订阅已切到 D1。若订阅仍由 KV 提供，应在旧版本先完成订阅 D1 导入，再运行 0018。可在迁移副本中用以下查询逐条核对实际冲突。

```sql
SELECT m.legacy_id, m.subscription_id, m.previous_starts_at,
       m.previous_expires_at, m.previous_enabled,
       e.expires_at AS chosen_legacy_expiry_utc,
       s.starts_at AS chosen_starts_at, s.expires_at AS chosen_expires_at, s.enabled
FROM subscription_plan_migration m
JOIN user_entitlements_legacy e ON e.id = m.legacy_id
JOIN subscriptions s ON s.id = m.subscription_id
WHERE m.previous_enabled IS NOT NULL
  AND m.previous_expires_at IS NOT s.expires_at
ORDER BY m.legacy_id, m.subscription_id;
```

## 触点清单

| 文件、路由或页面 | 处理 |
| --- | --- |
| `migrations/0018_subscription_plans.sql` | 增加订阅计划和配额字段，逐行迁移、记录冲突并改名留档。 |
| `worker/entitlements/{routes,service}.ts` | 目录移除，计划与过渡接口收编进 `worker/delivery/{plans,plan-routes}.ts`。 |
| `worker/app.ts`、`/api/admin/plans`、`/api/account/plans` | 从订阅域挂载原计划目录管理接口和原只读目录接口。 |
| `/api/admin/subscriptions/trial`、`/api/admin/users/:id/subscription-plan` | 新调用路径。用户目录操作直接变更订阅。换计划保留订阅 ID。续期叠加计划天数，已到期订阅续期后恢复启用。收回禁用订阅。 |
| `/api/admin/entitlements/trial`、`/api/admin/users/:id/entitlement`、`/api/account/entitlement` | 薄兼容。前两个路径挂到同一处理器。账户摘要和旧用户详情字段由订阅计算。旧用户级操作仍选择一条订阅，独立管理多条订阅可在订阅页按 ID 操作。无双写。 |
| `worker/delivery/{schema,d1-repository,service,routes}.ts`、`worker/migration/{delivery,run}.ts` | 订阅读写与迁移支持计划配额。管理员的订阅新建、修改、转移、回池、重置令牌保留正常入口。既有 KV 导入入口保护已包含计划的 D1 订阅。 |
| `worker/delivery/{compiler,user-nodes}.ts`、`worker/public-subscriptions.ts`、`worker/shares/service.ts` | 下载、编译、模板预览、分享导出、节点列表按实际订阅计划和时间窗检查，取订阅分组与计划分组交集。原行缺少可用计划时的诊断码为 `noPlan`。 |
| `worker/accounts/{registration,admin-routes,d1-repository}.ts` | 邮件注册及邀请兑换在原注册事务中创建带计划订阅。用户详情的订阅项返回计划和限额，旧摘要字段兼容。 |
| `worker/admin/{service,audit,templates}.ts` | 概览按有效及将到期订阅计数。广播按用户去重，提醒按订阅记录。旧及新路径统一记作 `post.subscriptions.<action>` 或 `put.subscriptions.trial`。默认提醒文本用订阅措辞，存量自定义模板继续使用。 |
| `src/app/{api,AppShell,navigation,router}.tsx/.ts` | 新订阅字段与诊断类型，账户菜单指向我的订阅，管理导航使用订阅计划。旧用户页 `/entitlement` 和 `/entitlements` 跳转 `/subscriptions`。 |
| `src/features/entitlements/{MyEntitlementPage,EntitlementsPage,EntitlementInfo}.tsx` | 删除独立权益页面与展示组件。 |
| `src/features/delivery/{MySubscriptionsPage,SubscriptionsPage,PlansPage,UserSubscriptionPlan}.tsx`、`plan-types.ts` | 用户在当前订阅中查看计划、配额、状态和到期。管理端支持在订阅表单选择计划及在详情查看配额。计划目录和试用配置移至订阅域。 |
| `src/features/accounts/UsersPage.tsx`、`src/features/dashboard/DashboardPage.tsx` | 用户行操作打开订阅计划管理抽屉，成功后刷新订阅数。概览区分有效订阅、近七日到期订阅和订阅总数。 |
| `src/features/user/{HomePage,MyNodesPage,MinePage}.tsx` | 首页合并原权益、订阅卡片与提醒文案。节点页消费订阅生效门槛。个人页保留到期通知设置，取消重复的权益展示和入口。 |
| `src/features/system/{AdminMailSection,TemplatePreview}.tsx` | 更新广播收件人和模板预览文案。 |
| `development/test-plan-migration.mjs`、`development/test-{entitlements,invite-registration,pages,stage3}-offline.mjs` | 新增迁移测试，更新本地 SQLite HTTP、注册、审计和统计覆盖。 |
| `development/tests/worker/{d1,d1-foundation,d1-admin-users,d1-delivery-shares,delivery-api,entitlements,helpers,shares-api,user-nodes}*.ts` | 纳入 0018，更新逐订阅计划夹具，新增同用户不同订阅独立下发且旧表不参与判断的案例。 |
| `development/tests/{browser,node,ui}`、`development/test-{nav-structure,ui-content}.mjs` | 更新计划字段、订阅页配额、旧路由跳转与节点门槛的测试或夹具。 |

兼容路径保留给现有调用者。当前前端使用订阅路径和订阅字段。DeliverySection 结构和共享按钮样式均沿用基线。

## 验收结果

| 命令或范围 | 结果 |
| --- | --- |
| `npm run check` | 通过，使用可写的 `XDG_CONFIG_HOME`。 |
| `npm run build` | 通过，Worker 和客户端均构建。Vite 报告超过 500 kB 的分块。 |
| Vitest 页面配置 `development/vitest-pages-node.config.ts` | 189/189 通过，基线 189。 |
| Vitest 订阅、控件、模板配置 | 分别 14/14、32/32、93/93 通过，均与基线计数一致。配置之间有重叠。 |
| SQLite 与 HTTP 脚本 | 迁移 3/3，新订阅语义 12/12，邀请 7/7，审计与提醒 7/7，页面后端 3/3，邮件 1/1。迁移覆盖空库、已有订阅冲突、无订阅新建。 |
| `npm test` 全量 Worker Vitest | 基线与交付版均因 `listen EPERM 127.0.0.1` 在执行前中止。现有案例保留并新增一个 Worker 回归，实际全量运行计数需集成复跑。 |
| `npm run test:e2e` | Vite dev 的本机网络枚举被沙箱拦截，`uv_interface_addresses` 返回权限错误。Playwright 列表基线和交付均为 48 个。 |
| `node development/test-ui-content.mjs`、`node development/test-nav-structure.mjs` | Chromium 因 `setsockopt: Operation not permitted` 在启动时退出。页面浏览器断言需集成复跑。 |

验收使用依赖目录的临时本地副本，以便 Wrangler、TypeScript 和 Vite 写缓存。依赖未纳入提交。
