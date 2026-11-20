# 管理员桌面端双布局交付报告

基线为本地 `origin/main` 的 `49d24656165eeac77147dcf890bc5427b1bac619`。开发分支为 `task/admin-dual-layout`。

## 改动文件

- `src/app/AppShell.tsx` 增加管理员桌面布局及账号菜单选择，保持工作区位置，共用管理员账号菜单和主导航渲染逻辑
- `src/app/navigation.ts` 在现有管理员模块数据上补充顶栏短名，复用原目标、顺序和模块匹配规则
- `src/styles/admin-navigation.css` 设置桌面顶栏排列、激活下划线、账号菜单层级及弹层开启时的工作区滚动锁定，沿用 760 px 移动切换规则与主题令牌
- `src/features/admin-resources/ResourceCard.tsx` 向行操作回调传递触发该菜单的按钮
- `src/features/delivery/SubscriptionsPage.tsx` 将订阅详情关闭后的焦点还给对应行的「更多操作」按钮
- `development/tests/browser/admin-frontend.spec.ts` 扩展现有订阅回归，覆盖键盘切换、当前选项、URL 和历史、节点身份、搜索、选择、两种布局的详情及二维码、折叠、断点和刷新
- `REPORT_ADMIN_DUAL_LAYOUT.md` 记录改动、验收与交付

## 偏好与工作区

React 的惰性状态初始化在 AppShell 首次渲染时同步读取 `subpanel:admin-layout`。读到 `topbar` 时直接渲染顶栏，缺失、其他值或读取异常均落到默认侧栏。用户切换时立即更新 React 状态并尝试写入，写失败时当前页面仍可切换。原折叠键 `subpanel:sidebar-collapsed` 单独存取。切换关闭账号菜单，并在布局提交后聚焦可见的账号按钮。

`workspace-content` 的位置、DOM 类型和 `key={location.pathname}` 沿用原实现。布局选项只改变导航和样式，不调用路由导航，查询参数、页内页签及其组件状态沿用同一个工作区。订阅模块的页签仍为订阅、分享、订阅计划。订阅详情、编辑、二维码、复制、附加配置及重置令牌沿用原组件和处理函数。

## 门槛实跑

| 命令 | 49d24656 基线 | 双布局分支 |
| --- | --- | --- |
| `npm run check` | 通过 | 通过 |
| `npm test` | Worker 池启动失败，无测试计数 | 同一启动错误，无测试计数 |
| `npx vitest run --config development/vitest-pages-node.config.ts` | 14 文件，189/189 | 14 文件，189/189 |
| `node development/test-pages-offline.mjs` | 3/3 | 3/3 |
| `npm run build` | 通过 | 通过 |

全量 Vitest 在监听 `127.0.0.1` 时返回 `EPERM`。Playwright 集成运行器在 Vite 启动阶段遇到 `uv_interface_addresses` 系统错误。独立 Chromium 启动也在 `sandbox_host_linux.cc` 的 `shutdown` 调用处被拒绝，进程收到 `SIGTRAP`。两版构建均有单个 chunk 超过 500 kB 的提示。

## 验收逐项

下表为静态核查结果。浏览器交互结果全部待集成复跑。

| 场景 | 静态核查与集成验收点 |
| --- | --- |
| 默认侧栏、切换、刷新 | 首次同步读取、异常回退、两项 `aria-pressed`、切换后聚焦与同页写入已接通。待测刷新与存储异常场景 |
| 同页状态 | 同一工作区和路径键，布局操作无路由调用。集成用例覆盖 URL、历史、工作区节点、搜索和选中行。另需实测查询筛选、页签、非首页分页、滚动和表单草稿。原生模态编辑抽屉打开时背景布局控件不可交互 |
| 侧栏折叠恢复 | 折叠状态使用原键与状态，布局切换不写折叠键。集成用例覆盖折叠往返 |
| 订阅详情与弹窗 | 两种布局引用同一详情抽屉。关抽屉显式回焦该行「更多操作」。集成用例覆盖两个布局的详情及二维码、关闭后回焦和选中状态 |
| 深链接和返回 | 工单详情沿用 `includeChildren`，设置子页和审计日志沿用现有模块定义。待测深链接高亮、下划线以及前进、返回 |
| 窄屏和恢复 | 760 px 及以下沿用移动 dock 和移动账号菜单。宽屏再次显示已选择的导航。集成用例覆盖 760 px 到宽屏往返 |
| 角色、主题、键盘和模块回归 | 普通用户分支沿用原导航，主导航与账户选择保留原生键盘控件及主题令牌。需实测普通用户宽窄屏、管理员浅色及深色，以及概览、节点、用户、运营、设置各模块 |
| 订阅原有操作 | 原复制、二维码、附加配置、编辑及重置令牌的处理函数保持原样。二维码有两布局集成断言，其余需在两布局复跑 |

## 截图与层级

桌面顶栏、桌面侧栏、窄屏共三张截图均因 Chromium 启动限制未能生成。替代静态检查确认顶栏在独立网格行，工作区拥有单独的滚动区。顶栏使用现有层级令牌，账号菜单打开时仅提升一级。原生 `showModal()` 使订阅抽屉和确认弹窗进入浏览器顶层并将背景设为不可交互，桌面顶栏布局额外锁定工作区滚动。遮罩覆盖、滚动锁定、列表回位与边缘裁切留集成环境实测并补图。

## 提交与 bundle

原工作树 Git 元数据只读，暂存时无法创建 `index.lock`。指定的 `/data/admin-dual-layout.bundle` 同样不可写。提交保存在可写克隆 `/data/tmp/subpanel-dual-delivery` 的同名分支。逐个暂存交付文件，两份输入规格保留在原工作树中，无远端推送。

bundle 路径为 `/data/tmp/subpanel-dual-delivery/admin-dual-layout.bundle`，以 `49d24656` 为前置提交。bundle 内含实现及本报告。最终 bundle 的字节数与 SHA-256 随校验结果写入分支上的后续报告提交，因为将摘要写入 bundle 自身会改变摘要。
