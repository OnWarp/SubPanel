# 管理员布局本地化

## 改前审计

分支 `task/sub-per-user-layout`，HEAD 与本地 `origin/main` 同为 `7d5eb686`，Git 身份已核对。

| 范围 | 状态 / 默认值 | 存储、读取与写入 |
| --- | --- | --- |
| PC | 侧边栏 / 顶部导航，默认侧边栏 | `localStorage['subpanel:admin-layout']`，`AppShell` 初始化读取，管理员账号菜单经 `changeAdminLayout` 写入 |
| PC | 侧栏展开 / 收起，默认展开 | `localStorage['subpanel:sidebar-collapsed']`，管理员与普通用户共用，`AppShell` 读取和切换写入。宽度由 CSS token 固定为 216 / 56 px，无独立宽度设置 |
| 移动端 | 悬浮 / 内嵌底栏，默认悬浮 | `localStorage['subpanel:mobile-bar']`，`useMobileBarPreference` 读取和写入，`AppShell` 提供给管理员账号菜单和普通用户个人中心的 `MobileBarOptions` |
| PC 与移动端 | 外观，默认跟随系统配色 | `localStorage['subpanel.theme']`，管理员、普通用户、访客共用。首屏由 `public/theme-init.js` 读取，`ThemeProvider` 读写、监听存储和系统配色变化，`ThemeMenu` 操作 |
| PC 与移动端 | 断点、密度、菜单展开、当前导航 | 768 px 断点由 CSS 和 `useMobileViewport` 应用；密度由 CSS 定义；菜单展开由 DOM 管理，导航高亮由路由推导，均无持久化布局偏好 |

布局状态只在前端浏览器出现，D1 `system_settings` 和 bootstrap 没有对应布局字段或写入入口。无需后端或数据库变更。

## 新存储方案

- 管理员键为 `subpanel:layout:admin:<encodeURIComponent(userId)>`。同一对象的 `pc` 保存 `navigation`、`sidebarCollapsed`，`mobile` 保存 `bar`，两端共用同一账号的 `theme`。默认值为侧边栏、展开、悬浮、跟随设备配色。应用只读取浏览器本地偏好，部署侧配置和 bootstrap 返回值没有布局读取入口。显式保存浅色或深色后，设备配色切换也不会覆盖该选择。
- 旧键没有账号来源。具备 Web Locks 的浏览器以 `subpanel:layout:legacy-owner` 记录首次迁移的管理员键，由该账号继承旧桌面布局、折叠状态、移动底栏和主题。其他管理员以代码默认值初始化。Web Locks 会串行化旧值认领。普通用户仍沿用旧的侧栏、底栏与外观键。
- 切换身份时按账号重新挂载布局，退出登录时卸载管理员壳。访客外观使用独立键 `subpanel:layout:guest:theme`，首次使用跟随设备配色，登录页的外观按钮仍可使用。旧外观键保留，游客专属偏好从新键开始。
- 无效字段按字段回退。存储不可用时可在当前会话中调整，刷新后按可读的本地值或默认值初始化。应用不调用服务端保存 API。

## 文件

- `src/app/admin-layout.tsx` 实现账号作用域、默认值、旧键迁移和存储回退。
- `src/app/App.tsx`、`src/main.tsx` 将布局和主题绑定到当前会话身份。
- `src/app/AppShell.tsx`、`src/app/mobile-bar.ts` 将现有控件接至相应存储。
- `public/theme-init.js`、`src/theme/ThemeProvider.tsx` 应用访客、普通用户或管理员的外观。
- `development/test-sub-per-user-layout.mjs` 增加隔离、退出、迁移、重载、默认值和截图回归。
- `development/test-design-v2-p0.mjs` 至 `test-design-v2-p2.mjs`、`development/test-layout-switch-split.mjs`、`development/test-mobile-bar-inset.mjs` 将现有断言和测试夹具接至新的管理员键。

## 风险与回滚

旧共享键无法恢复多账号的独立历史。首次进入的管理员继承该浏览器最后留下的旧值。Web Locks 不可用时，新建管理员偏好直接取默认值，旧键仍保留。偏好 JSON 在同一账号跨标签页同时修改时仍由最后一次写入决定。此交付保留旧键及相关数据。

在集成分支上可 `git revert` 本次交付提交，然后重建。旧版本将重新读取共享键。新键留在浏览器内，恢复新版即可再次读取。回滚无需 D1 操作。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误，77 条存量 lint 警告 |
| `npm run build` | Worker 和客户端均构建成功。构建仍提示客户端大体积 chunk |
| `CI=1 npm test` | 66 个文件通过，559 项通过，4 项跳过，0 失败 |
| 布局专项 Playwright | 通过。覆盖共享键迁移、同一浏览器两名管理员隔离、服务端模拟默认值变更不覆盖本地、退出后恢复访客外观、刷新恢复 |
| 既有 Playwright 回归 | PC/移动布局入口拆分和 767/768 px 断点、底栏几何与安全区、侧栏切换与焦点、目录筛选和主流程均通过。设计 V2 P2 的「来源刷新定时任务」断言因模拟接口缺失而失败，在基底 `7d5eb686` 复现 |
| 视觉回归 | `development/screenshots/sub-per-user-layout/` 含 1440、1024、390 px 各一对改前改后截图。同尺寸 PNG 逐一比对完全相同。PC 覆盖顶部导航，移动端覆盖内嵌底栏。折叠侧栏与悬浮底栏另由交互测试覆盖 |

初始依赖软链接指向旧版工具链。基线命令临时使用与锁文件匹配的本地依赖目录验证，依赖文件和软链接均未收入交付。

SUB_PER_USER_LAYOUT_DONE
