# Design System V2 P1 交付报告

基线为 `b76b5374`，交付分支为 `task/design-v2-p1`，提交身份为 Muse <muse@outtw.com>

## 影响路由

| 路由 | 改动 |
| --- | --- |
| `/catalog/sources` | 保留 P0 的单一标题和搜索、状态、新增同行布局。接入共享筛选重置、表格、加载骨架、总数和批量工具栏 |
| `/catalog/nodes` | 接入工作区主标题。搜索和状态常显，协议和来源按需展开。保留分页、当前页选择、全选筛选结果和编辑入口 |
| `/catalog/groups` | 接入工作区主标题和新增操作。扁平列表突出来源数和节点数，搜索可重置，批量选择随筛选结果收敛 |

共享组件的现有调用方也获得相应的空值标记、筛选分组语义、原生操作浮层及键盘行为。三条目录路由启用响应式扁平表格和紧凑批量工具栏

## 改动文件

- `src/ui/{DataTable,FilterBar,SearchInput,BatchToolbar}.tsx` 增加响应式表格列、排序状态语义、空值短标记、表格骨架、渐进筛选、重置焦点与窄屏批量操作
- `src/features/admin-resources/{ResourceCard.tsx,resource-card.css}` 统一总数和分页区域，补齐行操作关闭后的焦点和触摸尺寸
- `src/features/catalog/{SourcesPage,NodesPage,GroupsPage}.tsx` 统一页面标题、筛选、列表、批量进度、失败反馈和空态入口
- `src/styles/{pages-catalog,components,app}.css` 移除目录遗留的表格和筛选布局覆写。扁平表格沿用共享表格的 42px 基础行高和 1px 分隔线，允许内容换行与触摸区域扩张
- `development/test-design-v2-p1.mjs`、`development/tests/controls/resource-cards.test.tsx` 和 `development/tests/browser/admin-frontend.spec.ts` 补充 P1 断言并更新目录的既有结构断言
- `development/screenshots/design-v2-p1/` 存放三条目录路由的 1440px、768px、390px 浅色截图与 390px 深色截图，共 12 张。1440px 使用侧栏，其他尺寸使用顶栏布局及已有的窄屏导航

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误 |
| `npm run build -- --outDir /data/tmp/design-v2-p1-build --emptyOutDir` | 通过，Vite 提示有压缩后超过 500 kB 的代码块 |
| Worker | 514 / 514 |
| 页面 | 227 / 227 |
| Controls | 34 / 34，包含 33 个既有用例及 1 个新增用例 |
| Subscriptions | 14 / 14 |
| Templates | 93 / 93 |
| P1 Chromium 截图和交互 | 通过。检查单一 H1、320/390/768/1440px 页面及行操作边界、菜单与抽屉 Esc、键盘焦点可见及回归、筛选重置、全局布局切换后保留过滤条件、窄屏批量菜单、保存反馈、骨架、失败重试与空态 |
| P0 Chromium 回归 | 通过。检查来源工具栏、预览、抽屉、焦点及侧栏切换持久化 |
| 补充管理员 Chromium 回归 | 串行套件前 12 项通过，覆盖全部目录用例。订阅用例在导航断言处停止，断言期待 `aria-current="page"`，基线 AppShell 使用 `location`。分享窄屏用例单独通过。邀请及密码重置用例分别找不到其期待的顶栏「创建邀请」按钮和「邀请用户名」字段。补充回归使用已应用现有迁移的独立本地测试库 |

## 范围边界与回滚

- 筛选沿用原有页面状态，管理员布局切换时继续保留。目录继续沿用既有记录顺序和分页行为
- P2、P3 的页面迁移、全站视觉审计和其他浏览器矩阵留给后续阶段
- 交付范围为 UI、样式、测试和截图。业务 API、D1、订阅、权限、缓存、响应头、cron 与到期提醒调度均在范围外
- Bundle 位于 `/data/tmp/design-v2-p1.bundle`，以 `b76b5374` 为前置提交，包含 `refs/heads/task/design-v2-p1`
- 在已有基线的克隆中可用 `git bundle verify /data/tmp/design-v2-p1.bundle` 核验，用 `git fetch /data/tmp/design-v2-p1.bundle task/design-v2-p1` 取回提交。回滚时 revert 本次 P1 提交即可
- 完成标志按交付顺序在 bundle 核验后追加到工作区报告末行
