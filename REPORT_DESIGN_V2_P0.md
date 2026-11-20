# SubPanel Design System V2 · P0 交付报告

分支 `task/design-v2-p0`，指定基线 `c4c936d710c9797b26f54d977a84f8a79147583e`，提交身份 Muse <muse@outtw.com>。本地 `origin/main` 仍指向较早的 `ac694e9`，交付以简报指定的 SHA 为准

## 实现与差异文件

| 文件 | 差异 |
| --- | --- |
| `src/styles/tokens.css` | 保留原有颜色与兼容令牌，增加页面标题、正文、辅助文字、留白、表格行、按钮、触控和分隔线令牌。减少动态效果时将 UI 动画时长设为零 |
| `src/ui/PageFrame.tsx`、`src/ui/page-header-slots.ts`、`src/ui/PageHeader.tsx` | 侧栏与顶栏共享页面框架、标题及操作插槽。用框架内的 DOM 引用挂载标题和操作，描述默认省略 |
| `src/app/AppShell.tsx`、`src/app/navigation.ts`、`src/ui/SectionTabs.tsx` | 一级导航标示当前领域，二级导航标示当前页面。共用路由匹配规则，保留移动导航、审计日志归属、布局偏好、侧栏折叠及切换焦点恢复 |
| `src/styles/app.css`、`src/styles/admin-navigation.css`、`src/styles/pages-admin.css` | 应用后台页面标题与内容间距令牌，使用 216px 桌面侧栏并移除工作区阴影，清理概览标题描述专用样式。保留桌面顶栏品牌尺寸与导航字号 |
| `src/features/catalog/SourcesPage.tsx`、`src/styles/pages-catalog.css` | 来源页采用单标题，搜索、状态筛选与添加来源同排。使用平面表格、细线行分隔、末列操作和筛选重置。选中后才显示批量操作。窄屏收起低优先级列，可在编辑抽屉查阅同步详情。远程高级字段默认收起，手工／文件预览在请求成功后显示。关闭编辑抽屉时焦点回到对应行按钮 |
| `development/tests/controls/resource-cards.test.tsx`、`development/tests/ui/navigation-structure.test.ts`、`development/test-design-v2-p0.mjs` | 验证标题、描述、工具栏、无选中时的批量区、导航标记及浏览器交互。控件断言同时对齐基线的 `DataHeader` 二级标题结构 |
| `development/screenshots/design-v2-p0/`、`REPORT_DESIGN_V2_P0.md` | 12 张截图及本报告 |

## 影响路由与范围

- `/catalog/sources` 是本线唯一改造内容结构的页面。保留来源接口、请求参数、筛选语义、预览校验、增删改查、批量操作与反馈
- `/dashboard` 应用共享标题与框架，省略重复描述。七项统计及链接沿用现有实现
- 共享后台导航和框架覆盖 `/dashboard`、`/catalog/{nodes,sources,groups,apps}`、`/delivery/{subscriptions,shares,tickets}`、`/delivery/tickets/:id`、`/plans`、`/users`、`/users/recycle-bin`、`/invites`、`/operations/notices`、`/kb/manage`、`/system/*`、`/audit-logs` 及管理员账号页。使用 `PageHeader` 的其他路由继承其描述默认行为
- `src/app/api.ts` 与 `public/_headers` 和基线字节一致。业务 API、D1、订阅链接及权限规则沿用基线
- 其余数据页、配置页、用户端内容及概览统计分层留待 P1–P3。来源页维持现有全量列表，不引入分页接口或新路由

## 验收

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误 |
| `npm run build` | 通过，有 Vite 产物超过 500 kB 的提示 |
| `npm test` | 58 个 Worker 测试文件，514 项通过 |
| `vitest-pages-node.config.ts` | 15 个文件，227 项通过 |
| `vitest.controls.config.ts` | 7 个文件，33 项通过 |
| `vitest-subscriptions-node.config.ts` | 3 个文件，14 项通过 |
| `vitest.templates.config.ts` | 5 个文件，93 项通过 |
| Chromium | 320、390、768、1440px 验证工具栏同排、搜索、状态筛选与重置、批量区、预览、高级字段、键盘焦点、菜单及抽屉 Esc 关闭和焦点恢复。另验证布局切换保留筛选、恢复账号焦点、折叠状态跨刷新保留及减少动态效果令牌 |

截图与浏览器交互使用固定演示数据拦截 API 响应，Worker 测试独立运行。复现时启动 `npm run dev -- --host 127.0.0.1 --port 4181`，再运行 `node development/test-design-v2-p0.mjs`

| 视口 | 布局 | 来源页 | 概览页 |
| --- | --- | --- | --- |
| 1440 × 900 | 侧栏 | [浅色](development/screenshots/design-v2-p0/sources-1440-light.png) · [深色](development/screenshots/design-v2-p0/sources-1440-dark.png) | [浅色](development/screenshots/design-v2-p0/dashboard-1440-light.png) · [深色](development/screenshots/design-v2-p0/dashboard-1440-dark.png) |
| 768 × 900 | 顶栏 | [浅色](development/screenshots/design-v2-p0/sources-768-light.png) · [深色](development/screenshots/design-v2-p0/sources-768-dark.png) | [浅色](development/screenshots/design-v2-p0/dashboard-768-light.png) · [深色](development/screenshots/design-v2-p0/dashboard-768-dark.png) |
| 390 × 844 | 移动导航 | [浅色](development/screenshots/design-v2-p0/sources-390-light.png) · [深色](development/screenshots/design-v2-p0/sources-390-dark.png) | [浅色](development/screenshots/design-v2-p0/dashboard-390-light.png) · [深色](development/screenshots/design-v2-p0/dashboard-390-dark.png) |

## 交付与回滚

交付文件为 `/data/tmp/design-v2-p0.bundle`，包含 `refs/heads/task/design-v2-p0`，前置提交为 `c4c936d`。回滚时撤销本线提交即可恢复界面，无需数据库或配置迁移

CODEX_DESIGN_V2_P0_DONE
