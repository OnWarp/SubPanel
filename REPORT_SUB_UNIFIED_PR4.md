# 统一订阅 PR4

交付分支为 `task/sub-unified-pr4`。完工前重新获取 `origin/main`，基底仍为 `3e6b01f`。本阶段仅在隔离的本地环境启用统一订阅，生产切换结论为 **NO-GO**。

## 实际变更

| 文件 | 变更 |
|---|---|
| `src/features/delivery/MySubscriptionsPage.tsx`、`LegacySubscriptionsPage.tsx`、`unified-subscription.ts` | 统一详情显示状态、最远到期、脱敏链接、导入、分享、重置及兑换。统一入口清除旧选择参数；开关关闭时继续提供旧用户界面 |
| `src/features/user/HomePage.tsx`、`MinePage.tsx`、`MyNodesPage.tsx`、`reminder.ts`、`client-import.ts`、`src/features/redemption/PersonalRedemptions.tsx` | 首页、个人中心、节点和到期提醒使用同一摘要和聚合结果。统一视图隐藏未知流量；旧视图保留既有流量格式。兑换后刷新详情，节点页进入时重新获取聚合结果。导入复用五种现有 scheme 和复制入口，各平台共享账户凭据 |
| `src/features/accounts/UserDetailPage.tsx`、`UserManagementPage.tsx`、`UsersPage.tsx`、`src/features/delivery/UserSubscriptionPlan.tsx`、`SubscriptionDetailRows.tsx` | 用户详情提供基本信息、订阅授权和操作日志。绑定窗口支持搜索、期限、追加或更新、指定或整体替换、影响预览及冲突恢复。节点预览、统一链接、危险操作确认和批量任务从用户管理进入 |
| `src/features/delivery/EntitlementTemplatesPanel.tsx`、`entitlement-types.ts`、`plan-types.ts` | 权益模板列表显示资源数、绑定用户数、默认期限和状态。发布提示影响人数，支持从用户详情创建专属模板。模板使用共享 Dialog |
| `src/app/navigation.ts`、`router.tsx`，移除 `src/features/delivery/PlansPage.tsx`、`SubscriptionsPage.tsx` | 桌面、顶栏和手机导航复用同一配置。旧订阅管理路径转到用户管理，旧计划路径转到权益模板。独立发行 UI 已移除，转换模板仍有原入口 |
| `worker/delivery/unified-routes.ts`、`entitlement-templates.ts`、`shadow.ts` | 摘要在已启用的路径下为无绑定账户初始化凭据；绑定前后保持同一链接。新增节点展示字段与管理员摘要，扩展模板统计和影子比对 |
| `development/tests/worker/unified-subscription.test.ts`、`development/tests/controls/`、`development/tests/ui/`、`development/test-sub-unified-pr4.mjs` | 覆盖空授权关联账户链接、展示字段边界、过期预览修订冲突、导航与真实浏览器交互 |
| `development/screenshots/sub-unified-pr4/` | 16 张本地截图，约 620 KB |

## 验证

| 项目 | 实跑结果 |
|---|---|
| `npm run check` | 退出码 0，Wrangler 类型检查及 TypeScript 通过，Oxlint 0 错误，有 React 规则警告 |
| `npm run build` | 退出码 0，Worker 与客户端通过。Vite 有客户端入口超过 500 KB 的警告 |
| `CI=1 npm test` | 68 个文件通过，588 个用例通过，4 个按配置跳过 |
| 前端静态回归 | 页面配置 15 个文件、235 个用例通过。控件配置 8 个文件、36 个用例通过 |
| 本地 D1 全量 | 归档之前的本地状态，从空目录用 Wrangler 应用至 0027。补齐五个模块标志和更新时间，单独开启两个统一订阅标志，清除预置主订阅域名，完整性检查通过 |
| 本地 D1 增量 | 隔离 SQLite 夹具先应用至 0026，写入已有设置，再应用 0027。原设置保留，新增回执表存在，外键与完整性检查通过 |
| PR4 Chromium | 使用 `wrangler dev --local --port 4180 --ip 127.0.0.1 --infer-origin-from-routes=false --assets dist/client`。1440、1024、390 均通过单一详情、脱敏复制、浏览器导入、旧路径重定向、键盘关闭及焦点恢复、绑定预览和保存、空态和错误重试。390 额外验证五种 scheme、复制入口、格式响应、429、409 和深色视图。停用与轮换后携带旧 ETag 返回 404，正常条件请求返回 304，旧 `/sub` 夹具仍返回 200 |
| 旧包级浏览器回归 | 执行 `npm run test:e2e -- auth.spec.ts user-subscriptions.spec.ts`。2 项失败，6 项因串行测试中止。主题用例未读到其预期的本地存储值；旧订阅用例的初始化表单缺少必填初始化密钥，未进入登录页。上述命令与通过的 PR4 Wrangler 套件分别记录 |

## 影子验证

| 范围 | 一致 | 不一致 | 可切 | 暂缓 |
|---|---:|---:|---|---|
| 本地 PR4 浏览器，同一用户两次观察 | 1 | 1 | 永久授权、同节点夹具是等价示例 | 仅有旧发行且统一侧无绑定的观察暂缓 |
| 生产 | 未测 | 未测 | 0 | 全部待逐户核验 |

影子报告继续核对连接标识、格式诊断、状态、最远到期及未来时间边界，并新增展示节点名称和协议、已过期摘要时间的对照。浏览器同时读取统一摘要的节点数和实际节点页。现有 Worker 夹具通过额度不等价、共享节点去重、版本和缓存失效测试。生产限额等价性、历史有效链接及分享和兑换承诺仍需逐户核验。

## 迁移、风险和回滚

- 无新增迁移。依赖已存在的 0026、0027 表和五个模块就绪标志。两个统一订阅开关默认关闭。旧订阅、旧回执和转换模板数据保留
- 统一用户摘要在开关启用后为尚无绑定的可用账号创建账户级凭据。该写入复用现有原子插入和冲突保护，凭据经摘要读取并在轮换时失效
- 当限额、速度或设备策略缺少等价证据时继续暂缓；无归属、重复授权和历史版本差异逐项核验。无法兼容历史承诺的用户延后，90 天兼容期尚未开始
- 开关关闭时可回退本次代码提交并保留扩展表。若以后开启后已有写入，先关闭公开访问及绑定入口，再对账凭据、授权、兑换和分享操作；通过演练后恢复或前向修复。增量迁移、对账或恢复失败时以旧路径为权威
- 本次通过本地 Git bundle 交付，未推送或部署

SUB_UNIFIED_PR4_DONE
