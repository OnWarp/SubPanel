# SubPanel 管理端导航精简 · 线 E

基线为 `090b1432b6cfc9dcce81f9982168b7be6026d156`，工作树开工时的 `HEAD` 和本地 `origin/main` 一致，GitHub 只读查询也确认远端 `main` 为该提交

## 结构对照

桌面管理端侧栏从 13 个入口、5 个分组标题调整为 6 个入口，点击直接打开该域默认页

| 原桌面入口 | 新一级入口 | 页内页签 | 默认落点 |
| --- | --- | --- | --- |
| 概览 | 概览 | — | `/dashboard` |
| 节点、来源、分组 | 节点管理 | 节点 / 来源 / 分组 | `/catalog/nodes` |
| 订阅管理、分享管理、权益计划 | 订阅管理 | 订阅 / 分享 / 权益计划 | `/delivery/subscriptions` |
| 用户管理 | 用户管理 | 用户 / 邀请 / 回收站 | `/users` |
| 工单、公告、知识库、客户端下载 | 运营管理 | 工单 / 公告 / 知识库 / 客户端下载 | `/delivery/tickets` |
| 系统设置、审计日志 | 系统设置 | 注册设置 / 邮件设置 / 订阅分发 / 运行状态 / 审计日志 | `/system/registration` |

- 五个业务域共用 `SectionTabs`。页签使用现有路由，页面工具栏继续操作当前数据。工单详情归入工单页签，用户和系统页签保留查询参数，旧系统兼容入口仍按原有规则跳转
- 管理端桌面侧栏展开 224px、收起 64px，Logo 区高 64px，入口高 40px、间距 4px、图标 18px、字号 14px。沿用原展开按钮和 `subpanel:sidebar-collapsed` 持久化键。收起后链接保留名称、悬停提示和键盘访问。选中态和页签用既有明暗主题令牌
- 底部账号入口显示头像、用户名、管理员角色，菜单包含账户安全、外观和退出登录；收起后以头像打开
- 管理端移动底栏继续使用概览、分组、用户、更多，更多面板沿用原分组和名称。底栏对应关系建议为概览直达概览、分组继续直达节点管理的分组页、用户直达用户管理，更多覆盖订阅、运营、系统等其余入口。用户端底栏继续使用首页、订阅、节点、我的

## 文件清单

| 文件 | 改动 |
| --- | --- |
| `src/app/navigation.ts` | 桌面一级入口、二级页签配置和路径归属 |
| `src/app/AppShell.tsx` | 桌面侧栏、底部账号区域、页签挂载 |
| `src/ui/SectionTabs.tsx` | 共享路由页签组件 |
| `src/styles/admin-navigation.css` | 管理端侧栏、账号区域和页签样式 |
| `src/main.tsx` | 加载导航样式 |
| `src/features/accounts/UserManagementPage.tsx` | 去掉旧用户页签，保留子页内容接线 |
| `src/features/system/SystemPage.tsx` | 去掉旧系统内侧栏，保留原子页组件和旧链接跳转 |
| `src/styles/pages-system.css` | 移除旧系统内侧栏样式 |
| `development/tests/ui/navigation-structure.test.ts` | 六入口、五域归属、选中态、查询参数及权限回归 |
| `development/tests/worker/spa-fallback.test.ts` | 25 个管理端路径及兼容路径的浏览器文档响应断言 |
| `development/test-nav-structure.mjs` | 浏览器页签切换、折叠持久化、键盘进入及审计日志断言 |
| `development/tests/browser/admin-frontend.spec.ts` | 更新旧桌面入口与账号菜单定位 |
| `REPORT_NAV_SLIM.md` | 交付记录 |

## 验证结果

- `npm run check` 和 `npm run build` 通过。构建提示有压缩前超过 500 KB 的分块
- 导航聚焦测试 68 项通过，Node 子集 165 项通过
- 使用构建出的 HTML 作为静态资源绑定，在 Node 进程中调用实际 Worker 的 HTTP 处理器。25 个管理端路径（含工单详情、账户安全、系统旧入口及别名）的浏览器文档请求均返回 HTTP 200 和 SPA HTML。路由渲染与兼容跳转另由聚焦测试验证
- `npm test` 在 Worker 测试启动时遇到 `listen EPERM 127.0.0.1`，全量基线 456 项待集成复验。Chromium 启动时遇到 `setsockopt: Operation not permitted`，浏览器交互、尺寸与深色模式视觉效果待集成复验

## 提交与打包

原工作树共用的 Git 元数据为只读，`git add` 无法创建 `index.lock`。使用临时可写 Git 仓库，以同一基线和工作树文件逐个暂存并提交到 `task/nav-slim`，再创建 `/tmp/nav-slim.bundle`。原工作树分支引用仍指向基线，集成提交以 bundle 中的 `refs/heads/task/nav-slim` 为准
