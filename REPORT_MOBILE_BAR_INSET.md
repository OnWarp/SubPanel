# 移动端内嵌底栏交付报告

分支 `task/mobile-bar-inset`，基线 `c87fbfed`，提交身份 `Muse <muse@outtw.com>`

## 实现

- 管理端与用户端共用浏览器偏好 `subpanel:mobile-bar`。默认 `floating`，可切换为 `inset`，即时更新并在刷新后保留。管理端入口在窄屏头像菜单，和布局分段控件同级。用户端入口在「我的」的显示设置区。宽屏隐藏底栏样式控件
- 内嵌底栏占据内容面板底部的一行，贴合面板内侧边框，沿用面板表面和底部圆角，顶部以 1px 发丝线分隔。保留原四个入口、路由目标、图标、文案和选中状态。窄屏运营管理和系统设置仍可从头像菜单进入
- 悬浮式根据底栏占高及偏移为滚动内容预留空间。内嵌式由网格按实际底栏高度缩短滚动区域。两者均计入底部安全区；工单回复区随滚动区域调整
- Design V2 的「不新增第三套布局」约束适用于管理端桌面布局。内嵌底栏是移动导航的样式变体，桌面继续使用侧边栏与顶部导航两套布局

## 差异文件

| 文件 | 变更 |
| --- | --- |
| `src/app/mobile-bar.ts`、`src/app/MobileBarOptions.tsx` | 共用偏好、浏览器存储与可键盘操作的分段控件 |
| `src/app/AppShell.tsx`、`src/ui/PageFrame.tsx` | 将现有底栏放入面板尾部插槽，并接入管理端头像菜单 |
| `src/features/user/MinePage.tsx` | 在用户端显示设置区提供同一控件 |
| `src/styles/app.css`、`src/styles/admin-navigation.css`、`src/styles/pages-nav.css`、`src/styles/pages-tickets.css` | 底栏两种形态、分段控件、滚动留白与工单回复区偏移 |
| `index.html` | 为支持安全区的浏览器启用 `viewport-fit=cover` |
| `development/test-mobile-bar-inset.mjs`、`development/screenshots/mobile-bar-inset/` | 浏览器回归脚本与 9 张截图 |
| `development/tests/browser/mobile-nav.spec.ts`、`development/tests/ui/navigation-structure.test.ts` | 更新菜单和共用选择器断言；浏览器断言沿用实际的 `aria-current` 区分（有二级页签的管理域为 `location`） |

## 影响路由

共用应用外壳下的登录后页面均应用移动底栏偏好

- 管理端 `/dashboard`、`/catalog/{nodes,sources,groups,apps}`、`/delivery/{subscriptions,shares,tickets,tickets/:id}`、`/plans`、`/users`、`/users/recycle-bin`、`/invites`、`/operations/notices`、`/kb/manage`、`/system`、`/system/:section`、`/audit-logs`
- 用户端 `/home`、`/subscriptions`、`/nodes`、`/me`、`/notices`、`/kb`、`/kb/:id`、`/tickets`、`/tickets/:id`。旧订阅入口仍重定向到原目标
- 共用 `/apps`、`/account`。普通用户的 `/account` 复用「我的」并提供同一设置

## 验证与复现

- `npm run check` 通过，0 错误。生产构建通过，Vite 提示主 JS chunk 大于 500 kB
- 既有套件全部通过。Worker 514，页面 227，controls 33，subscriptions 14，templates 93
- 既有移动导航 Playwright 用例 12 项全部通过，使用隔离的本地 D1 测试状态完成注册及登录流程
- 新增 Chromium 回归覆盖默认及无效偏好回退、键盘切换及 Esc 焦点恢复、跨角色共用偏好、刷新持久化、两端导航与激活态、内嵌边缘与表面、模拟 34px 底部安全区、768px / 1440px 下隐藏及 320px 滚动到底无遮挡。减弱动画断言兼容 `0ms` 和压缩后的 `0s`
- 截图为管理端 / 用户端各 390px 悬浮 / 内嵌 × 浅色 / 深色，另有管理端 320px 内嵌浅色的节点列表滚动底部截图

在仓库根目录使用生产静态产物复现截图及回归。脚本在浏览器中拦截 API 并提供固定数据

```sh
mkdir -p /data/tmp/mobile-bar-inset
npm run build -- --outDir /data/tmp/mobile-bar-inset/dist
printf 'export default {}\n' > /data/tmp/mobile-bar-inset/vite-preview.mjs
npx vite preview --config /data/tmp/mobile-bar-inset/vite-preview.mjs \
  --outDir /data/tmp/mobile-bar-inset/dist/client --host 127.0.0.1 --port 4182
# 另开终端在仓库根目录执行
node development/test-mobile-bar-inset.mjs
```

## 未做项与回退

未做真机安全区测试，安全区在 Chromium 中使用非零值验证。其他 Design V2 阶段和生产部署不在本次范围。保留基线 P0、前端缓存层、`public/_headers` 下 `/assets` immutable 策略、业务 API、D1、订阅链接及权限语义。回退可撤销本次提交，无需数据迁移

交付包 `/data/tmp/mobile-bar-inset.bundle`，以 `c87fbfed` 为前置提交
