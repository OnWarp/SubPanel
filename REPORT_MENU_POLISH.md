# 管理员账号菜单精修

开发分支为 `task/menu-polish`，基线为 `origin/main` 的 `3a352ed088d385fd5b240b7df88367e9a5c22f26`。开发期间沿用该基线。

## 改动文件

- `src/app/AppShell.tsx` 将 `AdminAccount` 的菜单图标定为 16 px，整理分段控件 JSX 缩进。侧栏和顶栏共用 `AdminAccount`，沿用已有的切换、焦点恢复和 `subpanel:admin-layout` 存取逻辑。
- `src/styles/admin-navigation.css` 调整管理员账号菜单的分段轨道、选中态、行尺寸及图标对齐。外观图标的尺寸在账号菜单内设定，主题弹层和其他入口沿用原样式。
- `REPORT_MENU_POLISH.md` 记录参数、验收和交付。

## 分段控件与菜单行

| 项目 | 最终取值 |
| --- | --- |
| 轨道 | `--color-surface-subtle`，浅色 `#e9e9ee`、深色 `#141516`。宽度占满菜单内宽，6 px `--radius-control`，32 px `--space-6` 最小高度 |
| 分段 | 两个等宽网格列。轨道内缩 2 px，段面高 28 px，段面圆角 4 px |
| 选中面 | `--color-surface-raised`，浅色 `#ffffff`、深色 `#191a1b`。阴影沿用 `--shadow-shell`。文字使用 `--color-text` 和 `--weight-medium`（510） |
| 未选中面 | 透明底、继承常规字重，使用 `--color-text-muted`。悬停改用 `--color-text` |
| 过渡 | 底色、文字色及阴影使用 `--duration-ui`（160 ms）和 `--ease-out`。减少动态效果时禁用过渡 |
| 菜单节奏 | 布局标签和操作行同为 32 px 最小高度。轨道紧贴标签的行盒，布局块前后沿用菜单 4 px 行距。菜单上下内边距均为 8 px |
| 图标及悬停 | 四条主行统一 16 px 图标、2 单位描边、20 px 图标槽与 8 px 文字间距，图标和文字垂直居中。操作行悬停底色占满菜单内宽并沿用 6 px 内缩圆角 |

## 验收

| 命令 | 基线 | 精修分支 |
| --- | --- | --- |
| `npm run check` | 通过 | 通过 |
| `npm test` | Worker 池监听 `127.0.0.1` 返回 `EPERM`，未产生计数 | 同一启动错误，未产生计数 |
| `node ./node_modules/vitest/vitest.mjs run --config development/vitest-pages-node.config.ts` | 14 文件，189/189 | 14 文件，189/189 |
| `node development/test-pages-offline.mjs` | 3/3 | 3/3 |
| `npm run build` | 通过 | 通过 |

两版构建均有单个 chunk 超过 500 kB 的提示。相关 Playwright 套件 `admin-frontend.spec.ts` 和 `mobile-nav.spec.ts` 在 Vite 启动时遇到 `uv_interface_addresses` 系统错误，待集成环境复跑。独立 Chromium 启动探测在 `shutdown` 系统调用处收到 `EPERM`。共享桌面也未发现已启动的浏览器。

## 四态截图自查

| 主题与布局 | 结论 |
| --- | --- |
| 浅色侧栏 | 待补拍，浏览器启动受阻 |
| 浅色顶栏 | 待补拍，浏览器启动受阻 |
| 深色侧栏 | 待补拍，浏览器启动受阻 |
| 深色顶栏 | 待补拍，浏览器启动受阻 |

静态复核确认 ① 轨道横贯内宽，两段均分宽度，选中靠表面和中等字重区分 ② 标签与操作行使用同一尺寸，轨道下沿到下一行保留菜单统一行距 ③ 四个图标使用统一尺寸、描边和槽位。四态实拍及视觉验收待集成复跑。

## 集成关注点

- `task/drawer-slim` 当前工作树改动集中在抽屉及其调用方。菜单与抽屉的联动验收集中在顶栏菜单层级、抽屉遮罩和关闭后的焦点。
- `task/topbar-fill` 同样修改 `admin-navigation.css`，其桌面媒体查询紧邻本次菜单样式。集成时检查顶栏圆角、菜单定位和溢出显示。两线当前样式改动位于相邻区段。

## 交付

指定工作树的 Git 索引和 `/data/menu-polish.bundle` 均因只读挂载无法写入。交付提交位于可写克隆的同名分支，bundle 位于 `/data/tmp/menu-polish.bundle`，以前述基线为前置提交。两份输入规格留在原工作树中。所有交付文件逐个暂存，无推送。
