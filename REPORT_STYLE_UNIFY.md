# SubPanel 风格统一交付报告

基线为 `80642fbb`。实现与提交在该基线的可写副本 `task/style-unify` 上完成。原工作树的 Git 元数据和 `/data` 根目录在会话中以只读方式挂载。补丁同步至原工作树，交付包在工作区内生成并验证。

## 门槛

| 门槛 | 基线 | 最终 |
|---|---:|---:|
| `npm run check`（类型生成校验、TypeScript、Oxlint） | 通过 | 通过 |
| `npm test`（Worker 全量 Vitest） | 0 收集，启动受阻 | 0 收集，启动受阻 |
| 页面 Node Vitest（`development/vitest-pages-node.config.ts`） | 14 文件，189 通过 | 14 文件，189 通过 |
| `node development/test-pages-offline.mjs` | 3 通过 | 3 通过 |
| `npm run build` | 通过 | 通过 |
| Playwright（后台、域名、移动导航、按钮） | 未执行 | 服务未启动，0 执行 |

全量 Worker Vitest 启动时监听 `127.0.0.1` 返回 `EPERM`。Playwright 的 WebServer 初次启动遇到相对路径错误，修复临时副本的依赖解析后仍然无法启动。直接启动 Vite 时 Cloudflare 插件枚举网卡返回 `EPERM`。独立启动 Chromium 时 crashpad 的 `setsockopt` 也返回 `EPERM`。集成环境需重跑 Worker 全量、Playwright 和截图。

## 逐项文件清单

### style: 序 4 / B7 unify empty states（`019d98a`）

- `src/features/catalog/GroupsPage.tsx`
- `src/features/catalog/NodesPage.tsx`
- `src/features/catalog/SourcesPage.tsx`
- `src/features/delivery/MySubscriptionsPage.tsx`
- `src/features/system/DomainSettingsSection.tsx`
- `src/features/system/TemplateList.tsx`
- `src/styles/app.css`
- `src/styles/components.css`
- `src/styles/pages-admin-ops.css`
- `src/styles/pages-catalog.css`
- `src/styles/pages-user-d.css`
- `src/ui/EmptyState.tsx`

### style: 序 5 / B8 align section and dialog titles（`de448f3`）

- `src/styles/app.css`
- `src/styles/components.css`
- `src/styles/pages-admin-ops.css`
- `src/styles/pages-delivery.css`
- `src/styles/pages-users.css`

### style: 序 6 / B2 set content card padding to 16px（`3c995e4`）

- `src/styles/app.css`
- `src/styles/components.css`
- `src/styles/pages-admin-ops.css`
- `src/styles/pages-tickets.css`

### style: 序 7 / B5 reuse StatCard across the dashboard（`0de97d1`）

- `src/features/dashboard/DashboardPage.tsx`
- `src/styles/components.css`
- `src/styles/pages-admin-ops.css`
- `src/styles/pages-admin.css`
- `src/styles/pages-tickets.css`
- `src/ui/StatCard.tsx`

### style: 序 9 / B6 apply the shared object card to ticket lists（`b5f58cf`）

- `src/features/tickets/TicketsPage.tsx`
- `src/styles/app.css`
- `src/styles/pages-tickets.css`

### style: 序 10 / B9 use shared settings sections（`87d4d5a`）

- `src/features/system/DomainSettingsSection.tsx`
- `src/features/system/ShareSettingsSection.tsx`
- `src/features/system/SystemPage.tsx`
- `src/styles/pages-admin-ops.css`
- `src/styles/pages-system.css`

### style: 序 11 / B10 align section and overlay radii（`831215d`）

- `src/styles/app.css`
- `src/styles/components.css`
- `src/styles/pages-user-d.css`

### style: 序 12 / B11 normalize shared button heights（`db6d2ef`）

- `src/styles/app.css`

### style: 序 13 / B12 align subscription drawer spacing（`c43ed9b`）

- `src/styles/app.css`

### style: 序 14 / B1 converge section, card and key-value containers（`f86f822`）

- `development/tests/ui/users-page.test.tsx`
- `src/features/accounts/AccountPage.tsx`
- `src/features/accounts/InvitesPage.tsx`
- `src/features/accounts/ProfileCard.tsx`
- `src/features/accounts/UserManagementPage.tsx`
- `src/features/accounts/UsersPage.tsx`
- `src/features/admin/AuditLogsPage.tsx`
- `src/features/admin/OperationsCard.tsx`
- `src/features/apps/AppsPage.tsx`
- `src/features/catalog/AppDownloadsSection.tsx`
- `src/features/catalog/AppsPage.tsx`
- `src/features/delivery/MySubscriptionsPage.tsx`
- `src/features/delivery/PlansPage.tsx`
- `src/features/delivery/UserSubscriptionPlan.tsx`
- `src/features/kb/AdminKbPage.tsx`
- `src/features/system/NoticesSection.tsx`
- `src/features/tickets/AdminTicketsPage.tsx`
- `src/features/user/MinePage.tsx`
- `src/features/user/MyNodesPage.tsx`
- `src/styles/app.css`
- `src/styles/components.css`
- `src/styles/pages-admin-ops.css`
- `src/styles/pages-apps.css`
- `src/styles/pages-catalog.css`
- `src/styles/pages-delivery.css`
- `src/styles/pages-user-d.css`
- `src/styles/pages-users.css`
- `src/styles/user-shell.css`
- `src/ui/PlanCard.tsx`
- `src/ui/StatCard.tsx`

### style: 序 14 / B1 finish shared components and gate assertions（`88ad64b`）

- `development/tests/ui/navigation-structure.test.ts`
- `src/features/admin-resources/ResourceCard.tsx`
- `src/features/admin-resources/resource-card.css`
- `src/features/delivery/PlansPage.tsx`
- `src/features/system/AdminMailSection.tsx`
- `src/styles/app.css`
- `src/styles/components.css`
- `src/styles/pages-admin-ops.css`
- `src/styles/pages-adminshares.css`
- `src/styles/pages-apps.css`
- `src/styles/pages-delivery.css`
- `src/styles/pages-users.css`
- `src/ui/DataTable.tsx`


## 共享容器

| 原类名 | 迁移结果 |
|---|---|
| `.section-empty`、`.cat-empty-wrap`、`.template-empty`、`.sp-empty`、`.sp-table-empty` | `EmptyState` / `.empty-state`，表格用 `.empty-row` |
| `.adm-stat`、`.adm-stat-grid`、`.ui3-stat-grid` | `StatCard` / `.stat-grid` |
| `.tk-list-card`、`.appu-card`、`.sp-stat-card`、`.sp-plan-card`、`.profile-card`、`.del-status-card` | `.object-card` 与局部布局类。工单保留一项一卡，每张卡对应独立工单。基线目录页为 DataTable，保留表格形态 |
| `.ops-card`、`.usr-card`、`.del-link-card`、`.upd-card` | `.data-section` 与共享头部；`.upd-card` 已从节点表格移除 |
| `.sys-domain-block`、`.dom-stack`、`.dom-block` | `.data-section`、`.page-stack` 及设置布局类 |
| `.profile-fields` | 账户和用户端已迁为 `.key-value-rows`；订阅详情抽屉待 B3 |

## G1–G15 核对

| 规则 | 状态 | 源码核对 |
|---|---|---|
| G1 | 本线落实 | 概览和系统设置移除外层整页卡，使用 `.page-stack` |
| G2 | 部分落实 | 用户、目录、运营和设置复用 `.data-section` 与共享区块头，仍有各页内嵌分组 |
| G3 | 部分落实／待 B3 | 共享键值行使用发丝线，设置域名行统一内距；订阅详情行式待 B3 |
| G4 | 部分落实 | 统计、计划、应用及工单使用 16px 共享对象卡，仍有旧页面容器样式 |
| G5 | 部分落实 | DataTable 改为 42px，运营和目录主要表格覆写已收敛；窄屏保留目录全选入口 |
| G6 | 部分落实 | 目录、运营采用共享工具栏或区块头，部分列表仍有原过滤器布局 |
| G7 | 本线落实 | 指定空态合并，DataTable 空行改用 `.empty-row` |
| G8 | 部分落实／待 B3 | 共享弹窗、计划、工单与用户区块标题归档；订阅抽屉自身 h3 待 B3 |
| G9 | 部分落实 | 设置字段上限 460px，邮件模板、提醒及试用保存迁移到区块头，局部编辑表单保留自己的布局 |
| G10 | 不适用 | 账号菜单为 B4 集成范围 |
| G11 | 待 B3 | 共享键值行已用于用户资料；订阅详情键值、链接、诊断行待 B3 |
| G12 | 部分落实 | 修改指定预览与选择列表容器、内容卡及抽屉圆角；存量组件仍有其他圆角 |
| G13 | 部分落实 | 公共和批量操作按钮采用 32/28px，公共图标按钮 24/32px；页面局部控件仍需浏览器审计 |
| G14 | 部分落实／待 B3 | 订阅详情指定三处 gap 为 12/12/0；发丝线行式待 B3，存量间距仍有其他值 |
| G15 | 部分落实 | 共享区块、空态、统计卡及键值行已有复用，存量页面 CSS 仍有组件外观声明 |

## 逐页截图核对

1440 和 390 两档都受浏览器启动阻塞，未能保存截图或核对渲染。下表记录源码核对及仍待视觉验证的项目。

| 页面 | 路径 | 源码核对 | 待核对（1440 / 390） |
|---|---|---|---|
| 概览 | `/dashboard` | 统计组复用 StatCard，资源指标仍为可点击链接 | 网格换列、长标签、卡片间距 |
| 节点 | `/catalog/nodes` | 共享区块头和 DataTable，仍有原窄屏全选入口 | 筛选折行、全选入口、表格滚动 |
| 订阅 | `/delivery/subscriptions` | 抽屉三处间距调整 | 表格、抽屉及长链接溢出 |
| 用户 | `/users` | 用户和邀请页面使用共享区块，保留原操作与分页 | 窄屏字段、行操作、分页 |
| 运营 | `/delivery/tickets` | 共享区块头及表格 | 筛选与操作菜单定位 |
| 设置 | `/system/registration` | 各设置区块独立，使用共享标题样式 | 表单宽度、操作按钮、窄屏遮挡 |
