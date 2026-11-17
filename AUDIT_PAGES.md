# 页面功能审计（实施前）

依据 src/app/router.tsx 全部 Route，逐页追踪操作处理器、worker/app.ts 路由守卫、服务及 repository SQL/存储写入。结论是源码端到端审计，运行验证在交付报告另列，不将源码核对当作线上实测。没有发现纯壳页面。所有管理写路由统一挂 requireAuth/requireAdmin/auditAdminMutation，用户接口挂 requireAuth，沿用现有错误信封。

| 路由 | 页面证据（src/features/ 下，除重定向） | 结论 | 操作 → API/生效证据与缺失 |
|---|---|---|---|
| `/` | `RootRedirect.tsx` | 完整 | 会话/初始化状态重定向，无写操作 |
| `/s/:token` | `shares/SharePage.tsx` | 完整 | 分享元信息、密码验证、导出、复制和客户端导入 → worker/shares/routes.ts；session 与权限检查 |
| `/invite/:token` | `accounts/InvitePage.tsx` | 完整 | 邀请查询及密码兑换 → accounts/public-routes.ts，账户持久化 |
| `/setup` | `accounts/SetupPage.tsx` | 完整 | 初始化管理员 → POST /api/setup |
| `/register` | `accounts/RegisterPage.tsx` | 完整 | 注册配置、验证码、注册 → accounts/registration-routes.ts，原子试用发放 |
| `/login` | `accounts/LoginPage.tsx` | 完整 | session.login → /api/login，会话 cookie |
| `/audit-logs` | `admin/AuditLogsPage.tsx` | 完整 | 操作/人员/日期筛选、分页 → /api/admin/audit-logs，D1 查询 |
| `/dashboard` | `dashboard/DashboardPage.tsx` | 部分缺失 | G3：读取 stats 后仍逐页用户、逐用户权益请求；禁用用户权益与服务端 SQL 口径不同，需统一 |
| `/catalog/sources` | `catalog/SourcesPage.tsx` | 完整 | 预览、创建、编辑、刷新、开关、批量删除 → catalog/routes.ts；过滤和分页作用于完整目录 |
| `/catalog/apps` | `catalog/AppsPage.tsx` | 完整 | 复用管理员 Apps 管理，创建/编辑/下载项/排序/启停/删除 → apps/routes.ts，D1 |
| `/catalog/nodes` | `catalog/NodesPage.tsx` | 完整 | 节点搜索、过滤、分页、批量启停/删除、编辑 → catalog/routes.ts |
| `/catalog/groups` | `catalog/GroupsPage.tsx` | 完整 | 创建/编辑/删除、来源和节点多选、顺序 → catalog/routes.ts，plan/group 编译联动 |
| `/delivery/subscriptions` | `delivery/SubscriptionsPage.tsx` | 部分缺失 | G4：load 调用 /api/admin/users 无分页参数，只取默认20个用户，无法给其余用户创建订阅；其他创建/编辑/批量开关/删除/令牌/二维码接通 delivery/routes.ts |
| `/delivery/shares` | `delivery/AdminSharesPage.tsx` | 部分缺失 | G4：用户筛选选项同样只读取前20人；查询、状态筛选、禁用/撤销 → shares/routes.ts |
| `/plans` | `entitlements/PlansPage.tsx` | 完整 | 计划 CRUD、开关、排序、注册试用设置 → entitlements/routes.ts，D1 plans/plan_groups/settings |
| `/delivery/tickets` | `tickets/AdminTicketsPage.tsx` | 完整 | 状态筛选及分页 → GET /api/admin/tickets |
| `/delivery/tickets/:id` | `tickets/AdminTicketDetailPage.tsx` | 完整 | 详情、回复、关闭/重开 → tickets/routes.ts，D1 tickets/replies |
| `/kb/manage` | `kb/AdminKbPage.tsx` | 完整 | 分类、文章 CRUD、可见开关、排序 → kb/routes.ts，D1 |
| `/users` | `accounts/UsersPage.tsx` | 完整 | 服务端搜索/状态/分页，邀请/撤销、编辑/角色/开关、软删/恢复/清除、密码重置、批量、权益操作 → accounts/admin-routes.ts 与 entitlements/routes.ts |
| `/apps` | `apps/AppsPage.tsx` | 完整 | 平台过滤、客户端选择、下载/复制 → GET /api/apps，受下载设置控制 |
| `/home` | `user/HomePage.tsx` | 完整 | 权益/订阅/节点计数/公告真实查询；链接复制/导入、快捷入口、令牌重置 → delivery/routes.ts |
| `/entitlement` | `entitlements/MyEntitlementPage.tsx` | 完整 | EntitlementInfo 查询 /api/account/entitlement，支持链接至工单 |
| `/me` | `user/MinePage.tsx` | 完整 | 账户信息/改密/邮箱验证、退出所有设备、订阅重置 → AccountPage 与账户/订阅 API |
| `/subscriptions` | `delivery/MySubscriptionsPage.tsx` | 完整 | 订阅选择、平台、链接/二维码/导入/重置、分享抽屉 CRUD → delivery/routes.ts 与 shares/routes.ts |
| `/entitlements` | `entitlements/EntitlementsPage.tsx` | 部分缺失 | G1：计划墙仅渲染 current/latest.plan，无用户计划目录 API，未开通用户看不到任何计划 |
| `/nodes` | `user/MyNodesPage.tsx` | 完整 | 名称搜索、分组/订阅过滤、分页 → /api/user/nodes，权益与订阅范围服务端校验 |
| `/notices` | `notices/NoticesPage.tsx` | 部分缺失 | G2：/api/notices 全量返回；filter/slice 在前端实现搜索和分页，无服务端搜索/分页 |
| `/kb` | `kb/KbPage.tsx` | 完整 | 分类与文章列表、服务端搜索 → /api/kb 与 /api/kb/search |
| `/kb/:id` | `kb/KbArticlePage.tsx` | 完整 | 文章读取与安全 markdown → /api/kb/articles/:id，可见性校验 |
| `/tickets` | `tickets/TicketsPage.tsx` | 完整 | 列表、搜索/状态本地过滤完整个人列表、创建 → /api/tickets |
| `/tickets/:id` | `tickets/TicketDetailPage.tsx` | 完整 | 详情、回复、关闭 → /api/tickets/:id，所有权校验 |
| `/system` | `system/SystemPage.tsx` | 完整（平台例外） | 注册/邮箱域/邮件配置与测试/APP下载/域名验证与主域/分享/邀请码/模板/群发/提醒天数及手动发送 → system、domains、admin、registration routes，D1 settings 等；G5 自动提醒仅手动端点，cron 权限平台阻塞，按 brief 不修改 |
| `/account` | `accounts/AccountPage 或 user/MinePage.tsx` | 完整 | 按角色复用账户功能，密码修改、邮箱绑定/更换、注销所有会话 → accounts/account-routes.ts |
| `*` | `Navigate.tsx` | 完整 | 未知地址回角色首页，无独立操作 |

## 实施清单

- G1：增加鉴权只读公开计划目录（仅启用计划、显式公开字段白名单）并接入既有计划墙
- G2：公告增加数据库搜索、计数、分页，保留无参数完整列表兼容首页轮播；页面改用服务端结果
- G3：概览使用 stats 作为唯一用户/权益/工单统计源，移除逐用户查询；保留已有资源及诊断查询
- G4：两个管理页面用户选择器遍历服务端分页，避免20人截断
- G5：自动到期提醒平台权限阻塞，不属于本次代码修复；保留手动端点及页面提示，不改 cron

不改页面结构、样式、配色，不新增页面；以上补全无需数据库结构变更
