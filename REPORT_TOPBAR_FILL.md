# 顶栏布局微调交付报告

基线为 `origin/main` 的 `3a352ed0`，交付分支为 `task/topbar-fill`。工作区几何调整应用于管理员桌面双布局，沿用 760 px 移动端断点。

## 改动与简报对照

| 验收项 | 实现 |
| --- | --- |
| 顶部导航单边内嵌 | 桌面导航下方保留 `--space-shell` 间距。工作区占满其余网格空间，左、右、底贴窗边。 |
| 侧栏单边内嵌 | 侧栏与工作区之间沿用网格列间距。工作区顶、右、底贴窗边，适用于展开及折叠侧栏。 |
| 页面主容器 | 桌面双布局共用一组样式。概览、资源列表、用户列表和设置等使用的页面主卡横向拉满并补足剩余高度，卡内控件沿用原有间距。长内容仍在 `.workspace-content` 内滚动，页头位于滚动区外。 |
| 顶栏圆角 | 桌面顶栏用现有 `--radius-shell` 圆角和 `--color-surface` 表面。高度、网格、间距和菜单定位沿用原规则。 |
| 去除两条横线 | 删除共享页头 `.workspace-topbar` 和桌面主导航 `.admin-topbar-layout .admin-desktop-topbar` 的底边框。页签、表格和卡内的分隔样式沿用现有规则。 |

## 文件与并行线对账

- `src/styles/app.css` 仅删除 `.workspace-topbar` 的底边框。若全站统一线也调整此选择器，合并时对照页头的间距与边框声明。
- `src/styles/admin-navigation.css` 的桌面规则调整 `.admin-layout .workspace`、`.admin-topbar-layout .workspace`、`.admin-layout .workspace-content` 及其直属页签和页面主卡，并更新 `.admin-topbar-layout .admin-desktop-topbar`。全站统一线若也调整工作区或页面卡片的外层尺寸，需对照这些选择器。
- 订阅列表的直属 `.data-section.resource-card` 会使用新布局。与 `task/drawer-slim` 合并时，核对列表区域和抽屉开关后的滚动与焦点。订阅详情组件、抽屉选择器及顶栏布局的模态滚动锁定均沿用基线。
- `development/tests/browser/topbar-fill.spec.ts` 增加独立的双布局验收用例。功能、文案、路由、导航结构、接口及主题令牌定义沿用基线。

## 验收

| 命令 | 基线 | 交付 |
| --- | --- | --- |
| `npm run check` | 通过，0 错，退出码 0 | 通过，0 错，退出码 0 |
| `npm test` | Worker 池监听 `127.0.0.1` 报 `EPERM`，无用例计数 | 同一启动错误，无用例计数 |
| `npx vitest run --config development/vitest-pages-node.config.ts` | 14 文件，189/189 | 14 文件，189/189 |
| `node development/test-pages-offline.mjs` | 3/3 | 3/3 |
| `npm run build` | 通过 | 通过 |

两版构建均有 chunk 超过 500 kB 的提示。沙箱内的共享依赖目录只读，测试在可写克隆的依赖副本上执行。

Playwright 的管理员前端套件和新增布局用例均在 Vite 启动阶段被 `uv_interface_addresses` 的权限错误拦截。新增用例通过 Playwright `--list` 的发现与加载。直接启动 Chromium 也在沙箱系统调用处失败，因此六张实机截图、裁切检查和实际滚动均待集成复跑。当前已静态核对边距、滚动容器和边框声明。

集成环境可分别运行 `npm test`、`npm run test:e2e -- admin-frontend.spec.ts` 和 `npm run test:e2e -- topbar-fill.spec.ts`。布局用例在 1440 × 900 下覆盖概览、用户列表、注册设置各两种导航形态，检查贴边、圆角、横线、可见性和水平溢出，并在缩短视口后检查两种布局的纵向滚动。六张 PNG 会存入 Playwright 的 `test-results/` 对应用例目录并附到用例结果。

## 提交与 bundle

原工作树的共享 Git 元数据为只读，无法创建 `index.lock`。逐个暂存和提交在可写克隆 `/data/tmp/topbar-fill-delivery` 的同名分支完成。原工作树保留交付文件。指定位置 `/data/topbar-fill.bundle` 同样受只读挂载限制，交付文件实际为 `/data/tmp/topbar-fill.bundle`。bundle 以 `3a352ed0` 为前置提交，包含实现、验收用例和本报告。无远端推送。
