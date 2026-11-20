# REPORT_OVERVIEW_REDESIGN — 管理端概览页参照 gmshop 仪表盘重新设计

基线：origin/main 3c0788c（docs: archive drawer slim screenshots）。分支 task/overview-redesign。
打捞说明：原 Codex 线做完工作后自述「工作树 Git 元数据只读」，未产出报告、提交、bundle 与完成标志后退出；打捞实查 worktree 的 `.git`（gitdir 指向主仓 `.git/worktrees/subpanel-overview-redesign`）与主仓 `.git` 均可写，所谓只读是误判。以下提交与 bundle 由打捞方完成，日志末尾的 CODEX_OVERVIEW_DONE 为打捞方代写。

## 1. 参考版式提炼（gmshop-edge c8a2bf1）

出处：`src/features/dashboard/pages/admin.tsx` 与 `pages/tasks.tsx`，只提结构、不抄业务字段。

- **页头 PageHeader**：标题＋一行说明在左，右上角放页面级操作（gmshop 是时间范围分段切换器：今天 / 7 / 30 / 90 天，装在带边框的胶囊组里）。SubPanel 概览无时间维度数据，页头只保留标题＋说明，右侧不硬塞控件。
- **单一 KPI 网格**（核心结构）：一个响应式网格（2 列 → 3 列 → 5 列，gap 12–16px），指标卡与待办卡**混排在同一个网格**里，不另起区块。
  - 指标卡内部结构：`rounded-xl border bg-card shadow-sm`，内边距 16/20px；顶部一行＝小图标（16px）＋次级色标签（14px），下方 12px 间距放主数字（20–24px 半粗）。没有副信息、没有环比——gmshop 的指标卡就两层：标签行＋大数字。
  - 待办卡（AdminTasksSection）：与指标卡同网格同外形，内部纵向两端对齐：上方一行＝标签（左）＋图标（右），下方放更大的计数（30px）；整卡是链接，hover 时边框变强调色＋底色微变。待办靠「可点击＋计数更大」与普通指标区分，不靠换容器。
- **图表区**：双列等宽卡片（宽屏 2 列、窄屏堆叠），每卡＝标题（20px 半粗）＋一行次级色说明＋图表本体。SubPanel 无趋势数据接口，此区舍弃（见 §3）。
- 加载骨架与真实网格同构（同列数同卡高）。

## 2. 最终区块清单（数据来源逐块标注）

数据全部来自现有接口 `GET /api/admin/stats`，后端 `worker/admin/service.ts` 的 `adminStats()` 直接返回以下 7 个字段，未改接口、未改 handler。

| 区块 | 内容 | 数据来源 |
|---|---|---|
| 页头 | 标题「概览」＋说明「查看系统统计和待处理事项」 | 静态文案 |
| KPI 网格（单一网格，7 卡混排） | 总用户 | `/api/admin/stats` → `users` |
|  | 有效订阅 | `/api/admin/stats` → `activeSubscriptions` |
|  | 7 日内到期（待办卡，可点击） | `/api/admin/stats` → `expiringSubscriptions`，跳 `/delivery/subscriptions?expiry=soon` |
|  | 待处理工单（待办卡，可点击） | `/api/admin/stats` → `pendingTickets`，跳 `/delivery/tickets` |
|  | 节点 | `/api/admin/stats` → `nodes` |
|  | 计划 | `/api/admin/stats` → `plans` |
|  | 分组 | `/api/admin/stats` → `groups` |

版式实现（`src/styles/pages-admin.css`）：`.adm-overview` 用 container query，网格 2 列 → 36rem 起 3 列 → 54rem 起 5 列，卡片最小高 7rem，用全站唯一的 `sp-stat-card` 造型，不写死页面宽度，装进单边内嵌、其余撑满后的工作区。加载态与真实网格同构（7 个占位卡，`aria-busy`）。页面现在只发一次 stats 请求（旧版并行拉 stats＋catalog＋subscriptions 三个接口）。

去重结果：旧版「总用户」与「用户」重复（同一 `users` 值出现两次）已消除；「订阅总数」与「有效订阅」含糊并列已消除，只留口径明确的「有效订阅」。

## 3. 舍弃区块及原因

- **图表区（趋势图）**：参考有，SubPanel 无趋势数据接口，故舍弃。
- **时间范围切换器（今天/7/30/90 天）**：参考有，SubPanel 概览无时间维度数据，故舍弃。
- **来源 / 启用节点 / 订阅总数三张卡**：旧版从 `/api/admin/catalog`（来源数、启用节点数）与 `/api/admin/subscriptions`（订阅总数）计数得到；本线只用 stats 接口、且「订阅总数」与「有效订阅」口径含糊并列，故舍弃。
- **问题提醒条（旧 issues 区块）**：旧版汇总「来源最近刷新失败」「订阅存在兼容性跳过」并链到来源页；依赖 catalog 与 subscriptions 两个接口，随旧的三接口结构一并移除。注意：这是有意的行为变化——新版概览不再提示来源刷新失败，集成验收时确认是否接受，或由后续线另行补回。
- **旧的三区并列结构**（用户与订阅统计 / 系统统计 / 资源统计三组网格＋OperationsHeading 大卡套嵌）：被单一 KPI 网格取代。

## 4. 改动文件清单

- `src/features/dashboard/DashboardPage.tsx`：单次 stats 请求、7 卡单一网格、两张待办卡可点击跳转、加载/错误态
- `src/styles/pages-admin.css`：概览容器查询网格（2→3→5 列）、卡片尺寸与阴影、页头说明行样式
- `src/styles/pages-admin-ops.css`：删旧概览大卡相关样式（35 行）
- `development/tests/ui/navigation-structure.test.ts`：新增加载网格测试（页头＋7 个占位卡）
- `development/test-ui-content.mjs`：mock 补 tickets/subscriptions 的 total 字段；断言 7 个值、总用户只出现一次、两张待办卡点击跳转、390px 下网格 2 列且不横向溢出
- `REPORT_OVERVIEW_REDESIGN.md`：本报告

## 5. 验收

原线自述（打捞时未重跑全量，见下）：`npm run check` 与构建通过；离线页面测试 189/189；新增的三组测试 14/14、32/32、93/93 全过。

**待集成复跑**：全量 Vitest、Playwright、截图验收（桌面 1440、窄屏 390、深色）在原线沙箱受限未跑；基线计数对照原线未记录。集成时须在集成机重跑 check、vitest 全量、页面测试与 build，并补三张截图（区块层级清楚、无重复指标、待办卡可点击且形态有别、窄屏不破版）。
