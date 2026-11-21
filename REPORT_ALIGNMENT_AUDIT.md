# SubPanel 全站对齐审计

在 `task/alignment-audit` 从 `ac7b4ba` 接续，修复前以 `a4fabff3` 为基底。Chromium 使用 1440 × 900 和 390 × 844 两档视口，基底和修复版共用本地样例数据。逐页检查 36 个路由视图及 4 个管理端重定向入口，核对标题、页签、筛选项高度、首列与行操作、列表页脚，以及有代表性的表单和状态视图

## 管理端

| 页面 | 两档宽度的结论 |
| --- | --- |
| `/dashboard` 概览 | 已修。页头与指标、快捷入口同线，侧栏收起控件可点击 |
| `/catalog/nodes` 节点 | 已修。筛选、首列及分页共用内容边界，移动端保留按列优先级隐藏低优先级信息 |
| `/catalog/sources` 来源 | 已修。工具栏和首列同线。移动端紧凑工具栏保留选择器与添加按钮，新建抽屉沿用共享尺寸 |
| `/catalog/groups` 分组 | 已修。搜索、表格与页脚同线，新建分组抽屉沿用共享尺寸 |
| `/catalog/apps` 客户端下载 | 已修。搜索和状态使用共享筛选栏，用户端入口和新增按钮并入标题行，复核新增抽屉 |
| `/delivery/subscriptions` 订阅 | 已修。补齐共享页头，筛选、选择列、页脚采用同一内容边界，添加订阅保留表单字段宽度 |
| `/delivery/shares` 分享管理 | 已修。补齐共享页头，对齐筛选、首列与总数，移动端筛选项自然换行 |
| `/plans` 订阅计划 | 已修。标题、列表、页脚采用相同边界，检查新增计划抽屉 |
| `/delivery/tickets` 工单 | 已修。工单状态标签与选择器同排，复核标题、页签、首列、分页与状态视图 |
| `/delivery/tickets/:id` 工单详情 | 已修。线程摘要、消息及回复编辑区统一外侧边界。保留左右区分发送方的消息布局 |
| `/operations/notices` 公告 | 已修。刷新并入标题操作区，列表、页脚和内嵌表单同线，表单保持原有字段宽度 |
| `/kb/manage` 知识库管理 | 已修。分类与发布状态改用共享筛选栏，对齐分类表格、页脚与内嵌分类表单，复核文章新建抽屉 |
| `/users` 用户管理 | 已修。状态和搜索使用共享筛选栏，检查批量区、首列与分页，移动端保留带标签的用户条目 |
| `/users/recycle-bin` 回收站 | 已修。沿用用户目录的筛选与页脚对齐，复核空态 |
| `/invites` 邀请 | 已修。标题、用户管理页签与邀请码卡片、表单采用同一边界 |
| `/system/registration` 注册设置 | 已修。页签、设置标题、字段同线，表单保留列宽规则 |
| `/system/mail` 邮件设置 | 已修。设置、模板与群发各区复用设置间距 |
| `/system/distribution` 订阅分发 | 已修。域名、分享设置和模板区对齐，保留可展开的配置区 |
| `/system/status` 运行状态 | 已修。健康与状态区标题及正文采用相同边界 |
| `/audit-logs` 审计日志 | 已修。操作、管理员 ID、起止时间同高。移动端标签与控件分别同列，长详情可断行 |
| `/account` 账户安全 | 已修。页头、资料及账户安全表单采用同一外侧边界 |

## 用户端与公共入口

| 页面 | 两档宽度的结论 |
| --- | --- |
| `/home` 首页 | 对齐。保留流量卡、公告和快捷入口的各自布局 |
| `/me`、用户端 `/account` 个人中心 | 对齐。保留行式账户设置、值与操作的对齐布局 |
| `/subscriptions` 我的订阅 | 对齐。保留订阅选择、链接与分享操作布局 |
| `/nodes` 我的节点 | 已修。搜索、选择器与更多筛选按钮使用同一高度。验证可用节点列表与订阅门槛状态 |
| `/notices` 公告 | 已修。共享页头与搜索栏从相同边界起排，保留公告卡片内边距 |
| `/kb` 知识库 | 已修。切换至用户端共享内容页头，与搜索栏同线，分类卡片保留阅读内边距 |
| `/kb/:id` 文章 | 已修。页头与内容边界一致，返回操作随页头排列，保留正文阅读内边距 |
| `/tickets` 我的工单 | 已修。共享页头和工单列表外沿同线，检查新建工单弹窗 |
| `/tickets/:id` 工单详情 | 已修。共享页头和线程外沿同线，消息和编辑控件沿用已有布局 |
| `/apps` 客户端下载 | 已修。共享页头与平台栏、卡片网格外沿同线 |
| `/login`、`/register`、`/setup` | 对齐。保留独立居中表单布局，标题与输入列共用表单边界 |
| `/invite/:token` | 对齐。使用带邀请码的注册页，沿用注册表单布局 |
| `/s/:token` | 保留公开分享的独立表单布局 |
| `/`、`/entitlement`、`/entitlements`、`/system` 及历史路径别名 | 保留重定向，布局由目标页提供 |

## 改动文件

- 筛选与页头组件用法采用 `AuditLogsPage.tsx`、`AdminTicketsPage.tsx`、`AppsPage.tsx`（管理端）、`AdminKbPage.tsx`、`UsersPage.tsx`、`SubscriptionsPage.tsx`（管理端）、`AdminSharesPage.tsx`、`KbPage.tsx`、`KbArticlePage.tsx`、`NoticesSection.tsx`
- 对齐规则位于 `resource-card.css`、`admin-navigation.css`、`app.css`、`components.css`、`pages-admin-ops.css`、`pages-apps.css`、`pages-catalog.css`、`pages-kb.css`、`pages-system.css`、`pages-tickets.css`、`pages-user-d.css`、`pages-users.css`
- 更新 `development/tests/ui/navigation-structure.test.ts` 的审计日志断言，覆盖共享筛选栏、四个标签和分页总数
- 对照截图在 `development/screenshots/alignment-audit/`，文件名含 `before` / `after`、角色、页面和视口宽度，共 190 张，包含代表性抽屉、表单及工单的空态、加载态和错误态

## 验收

| 检查 | 实测 |
| --- | --- |
| `npm run check` | 0 错 |
| `npm run build` | 通过 |
| Worker | 518 / 518 |
| 页面 | 228 / 228 |
| Controls | 36 / 36 |
| Subscriptions | 14 / 14 |
| Templates | 93 / 93 |
| `test-mobile-bar-inset`、`test-layout-switch-split`、`test-design-v2-p3`、`test-home-traffic` | 全部通过，Vite preview 4182 |

工单页在两档宽度的标题、首个页签、卡片标题、筛选标签、首列和页脚分别共用 262px 与 25px 的左边界。审计日志四个输入在桌面均为 36px 高，移动端均为 44px 高，且与其标签保持同行

## 未做项

- 覆盖 Chromium 的两档验收宽度及既有脚本覆盖的额外尺寸。业务写入和异常组合沿用既有测试覆盖，本轮浏览器检查使用本地示例记录与代表性状态

GROK_ALIGNMENT_AUDIT_DONE
