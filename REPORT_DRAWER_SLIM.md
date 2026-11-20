# 订阅详情抽屉精简报告

分支 `task/drawer-slim`，基线 `origin/main`（`3a352ed`）。范围为管理员订阅列表的详情抽屉。用户端「我的订阅」由 `MySubscriptionsPage.tsx` 独立渲染，未改动。

## 改动文件

- `src/features/delivery/SubscriptionsPage.tsx`。页头显示订阅名称、启用状态、更多菜单和关闭按钮。主体依次显示基本信息、客户端链接和附加配置。兼容诊断仍可展开，重置令牌沿用原有处理函数。
- `src/ui/EditDrawer.tsx`。增加可选的页头状态与操作插槽，沿用原有关闭和恢复焦点逻辑。
- `src/styles/app.css`。字段采用单层边框容器和内部发丝分隔线。宽屏沿用 620px 档位，移动端沿用全宽底部抽屉。链接文本在单行内显示省略号。
- `development/tests/browser/admin-frontend.spec.ts`。现有订阅用例增加格式切换、单行链接、完整剪贴板值、附加配置和更多菜单断言，以及宽窄屏截图。二维码、兼容诊断、关闭后的焦点恢复和两种管理布局继续由同一用例覆盖。

## 格式与附加配置

每次打开详情时，以本条订阅的 `defaultClient` 初始化 React 本地状态 `selectedClient`。当前格式缺少链接时取 `details.links` 的首项，没有链接时显示空态。切换仅更新本地状态，选项使用现有 `CLIENT_LABELS`，地址使用原始 `details.links`。复制按钮和二维码处理函数都收到当前格式的完整地址。重置令牌更新同一订阅的链接后，仍可用的当前格式继续保留。

附加配置用订阅 ID 从原有模板绑定读取接口获取，关闭或切换订阅会取消旧请求。生效方式对应继承默认、基础配置和指定模板。模板名称及发布版本取当前生效模板，没有生效模板时两项显示破折号。

## B3 集成对账点

- 内容结构以本线为准。合并时在基本信息、客户端链接和附加配置的字段容器上重贴 B3 发丝线样式。
- 页头对账标题、状态、更多菜单与关闭按钮的位置，以及长标题的换行和操作区的可点击范围。
- 链接区对账格式选择器和单行链接的栅格，保留文本截断与复制、二维码按钮的布局。
- 附加配置区保留三项字段和可折叠的兼容诊断。宽屏与移动端分别检查边距、分隔线和滚动行为。
- 在侧栏和顶部导航下分别验证列表详情入口、关闭后的焦点恢复，以及搜索、筛选、分页和勾选状态。

## 验收

| 命令 | 基线 | 本分支 |
| --- | --- | --- |
| `npm run check` | 通过 | 通过 |
| `npm run build` | 通过，Worker 285 / 客户端 2016 个模块 | 通过，Worker 285 / 客户端 2016 个模块 |
| `npx vitest run --config development/vitest-pages-node.config.ts` | 14 个文件，189 项通过 | 14 个文件，189 项通过 |
| `npx vitest run --config development/vitest.controls.config.ts` | 7 个文件，32 项通过 | 7 个文件，32 项通过 |
| `npm test` | 沙箱拒绝监听 `127.0.0.1`（`EPERM`） | 同一限制，待集成复跑 |
| `npm run test:e2e -- admin-frontend.spec.ts` | — | Vite 启动时网络接口查询被沙箱拒绝，待集成复跑 |

浏览器自查和截图尚未完成。Chromium 与 Playwright 自带的无头 Chromium 都在启动时遇到沙箱错误。集成环境复跑管理员浏览器套件后，订阅用例产出 `drawer-wide.png` 和 `drawer-narrow.png`（390 × 844），请归档到报告目录 `docs/drawer-slim/`。

## Bundle

原工作树的 Git 元数据和 `/data` 根目录为只读。提交在可写副本 `/data/tmp/drawer-slim-delivery` 的同名分支完成，逐文件暂存。增量 bundle 的实际交付路径为 `/data/tmp/drawer-slim.bundle`，大小约 6.1 KiB，使用 `git bundle verify` 校验，并以从基线检出后的导入结果核对分支提交。
