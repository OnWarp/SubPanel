# 管理端双布局一致性修复

基线为 `origin/main` 的 `a960f3c3`，交付分支为 `task/layout-consistency`。

## 改动文件与修复口径

唯一改动的产品文件是 `src/styles/admin-navigation.css`。

| 口径 | 规则与效果 |
| --- | --- |
| 导航区与窗口底色融为一体 | 桌面 `.admin-topbar-layout .admin-desktop-topbar` 删除 `background: var(--color-surface)` 与 `border-radius: var(--radius-shell)`。透明顶栏透出 `.app-layout` 的窗口底色。顶栏高度、内边距、品牌、菜单排布和层级沿用原规则。顶栏与工作区页头仍无底线。 |
| 工作区是唯一的全局内嵌面板 | 桌面 `.admin-layout .workspace` 与 `.admin-topbar-layout .workspace` 沿用原来的伸展及边角规则。顶栏布局在上方保留 `--space-shell` 间距，左右和底部贴窗。侧栏布局在左边保留网格间距，顶部、右侧和底部贴窗。 |
| 短页由工作区表面自然延展 | 两种布局共用 `.workspace-content` 与直属 `.page-stack` 规则。概览等页面保留同一套 `24px … 48px` 内边距和顶部对齐。工作区占满剩余空间，未新增底部元素或补位样式。 |
| 侧栏布局保持原有形态 | 改动选择器仅匹配桌面顶栏布局。侧栏窗口底色、侧栏与工作区间距以及侧栏模式面板边角均沿用原规则。 |

## 测试对照

| 命令 | 基线 | 交付 |
| --- | --- | --- |
| `npm run check` | 通过 | 通过 |
| `npm test` | Worker 池监听 `127.0.0.1` 时收到 `EPERM`，无用例计数 | 同一启动错误，无用例计数 |
| `npx --no-install vitest run --config development/vitest-pages-node.config.ts` | 14 文件，189/189 | 14 文件，189/189 |
| `node development/test-pages-offline.mjs` | 3/3 | 3/3 |
| `npm run build` | 通过 | 通过 |

两次构建均有大于 500 kB 的 chunk 提示。基线与交付的测试使用同一份可写依赖副本。

## 截图与自查

实际截图待补。当前 shell 禁止本地监听，Playwright Chromium 启动时分别在 Crashpad 的 `setsockopt` 与 headless shell 的 `shutdown` 调用收到权限错误。下列为计划存档位置：

- 顶栏概览全屏 `development/screenshots/layout-consistency/topbar-overview.png`
- 侧栏概览全屏 `development/screenshots/layout-consistency/sidebar-overview.png`
- 顶栏短页（注册设置）`development/screenshots/layout-consistency/topbar-settings.png`
- 侧栏短页（注册设置）`development/screenshots/layout-consistency/sidebar-settings.png`

已核对 CSS 中的顶栏底色、圆角、工作区贴边、共享页面内边距及无底部补位元素。实机视觉对照仍待验证。既有 `topbar-fill.spec.ts` 中要求顶栏圆角大于零的断言对应旧设计，与本次验收口径相反。

## 提交与交付

原 worktree 的共享 Git 元数据为只读，`git add` 无法创建 `index.lock`。在可写克隆的同名分支中逐个暂存和提交，原 worktree 中保留 CSS 和报告。交付 bundle 为 `/data/tmp/layout-consistency.bundle`，以基线提交为前置，无远端推送。
