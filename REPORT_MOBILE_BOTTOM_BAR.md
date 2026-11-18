# REPORT — 管理员移动端底栏大板块

## 与沉浸式线的关系

派活时沉浸式线仍在跑（截图自查阶段，远端 `task/immersive-shell` 当时尚未推送）。按「在跑任务不迁移、不打断」，本线在 `bf9cc2d1` 上独立新开，没有往沉浸式分支追加，也没有把沉浸式提交合进本分支。

集成时 main 会已先后合入域名简化与沉浸式两条线。对账 `AppShell` 时以当时最新 main 为准，不回退那两条线的成果，也不回退本线的单行底栏。本分支上的内容区还不是沉浸式内嵌面板；底栏按简报形态段自己做成圆角、1px 边框、浮起阴影令牌、四周约 8px、表面色与画布可区分的单行面板，便于之后并排。

## 最终标签

390×844 下四字标签放得下，没有改短标签，也没有省略号。

最终可见标签：概览、节点管理、订阅管理、用户管理、运营管理、系统设置。

图标在文字上方。12px（`--font-sm`）时，四字标签实测宽 48.02px。有纵向滚动条时每个等宽格约 56.5px，无滚动条时约 59px。`scrollWidth === clientWidth`，字形没有超出按钮，也没有超出面板。

## 形态与行为

- 窄屏断点仍是 `max-width: 760px`。宽屏底栏 `display: none`，桌面侧栏不动。
- 面板单行 `flex-wrap: nowrap`，6 个入口等宽。实测同一 `top`，高度 58px。左 8px，下 8px（844 视口里底边在 836）。圆角 16px（`--radius-card`），1px 边框，背景 `--color-surface`。
- 浅色：表面 `#ffffff`，画布 `#f5f5f7`，阴影为 `--shadow-float`（`rgb(0 0 0 / 0.22) 3px 5px 30px`）。
- 深色：表面 `#0f1011`，画布 `#08090a`，1px 浅色边框。深色主题把 `--shadow-float` 定为 `none`，面板靠表面亮度差和边框分开，没有另写阴影。
- 选中态：`--color-primary-soft` 底、`--color-primary` 字、`--weight-semibold`（590）。令牌未改。浅色主色是 `#0071e3`，深色主色是 `#5e6ad2`。深色选中字实测 `rgb(94, 106, 210)`。
- 高亮用 `adminDomainForPath`，与桌面侧栏同一域对象。子页跟着当前域，而不是只认入口路径前缀。
- 点击进入各域默认页，路由与桌面 6 入口一致：`/dashboard`、`/catalog/nodes`、`/delivery/subscriptions`、`/users`、`/delivery/tickets`、`/system/registration`。
- 没有「更多」、没有二级展开、没有弹出层。原先只给管理员底栏用的「更多导航」层已删掉。
- 内容区底部 `padding-bottom: calc(96px + env(safe-area-inset-bottom, 0px))`。面板本身 `bottom: calc(8px + env(safe-area-inset-bottom))`，左右用 `max(8px, safe-area-inset-*)`。
- 用户端底栏仍是首页 / 订阅 / 节点 / 我的。390 宽下管理员底栏不渲染。

## 改动文件

- `src/app/AppShell.tsx`
- `src/styles/app.css`
- `development/tests/ui/navigation-structure.test.ts`
- `development/tests/browser/auth.spec.ts`
- `development/test-nav-structure.mjs`
- `REPORT_MOBILE_BOTTOM_BAR.md`

`BRIEF_MOBILE_BOTTOM_BAR.md` 是任务输入，未纳入提交。

## 测试

- `npm run check`：通过（wrangler types、tsc、oxlint 0 error）。
- `npm test`：57 个文件、481 条通过，没有回退。
- `npx vitest run --config development/vitest-pages-node.config.ts`：14 个文件、187 条通过。其中 `navigation-structure.test.ts` 78 条，覆盖 6 入口、单行样式约束（禁止 3 列网格和标签省略号）、域内子页与工单详情的底栏高亮。
- `npm run build`：通过。

## 截图自查（Playwright Chromium，390×844，deviceScaleFactor 2）

开发服务器 `http://127.0.0.1:4179`，接口在浏览器里拦截，不依赖线上登录。

- 浅色 `/dashboard`：6 个按钮一行，概览选中，标签完整。
- 浅色 `/catalog/sources`：节点管理选中（来源是该域子页）。
- 深色 `/delivery/tickets/tkt_1`：运营管理选中，面板与画布可区分。
- 点击「系统设置」进入 `/system/registration`，选中态跟着变成系统设置。
- 概览页滚到文档末尾：最后一块内容底边 748，底栏顶边 778，间隙 30px，没有被挡住。首屏长页会从栏下滚过，末尾留白能把最后一块抬到栏上方。
- `documentElement.scrollWidth` 不超过 390。
- 1280 宽：管理员底栏 `display: none`，侧栏仍在。
- 用户 `/home` 390 宽、深色：底栏为首页 / 订阅 / 节点 / 我的，没有管理员底栏。

截图留在本机 `/tmp/bottom-bar-shots/`，未提交。

## 已知后果与未验证项

- 管理员移动端的账户安全、外观和退出登录原来在「更多」层里。该层按规格删除后，这三项仍只在桌面侧栏账号菜单中；窄屏侧栏继续 `display: none`。本线没有在底栏加第二行或弹出层。
- `safe-area-inset-bottom` 写在样式里。这台 Chromium 没有刘海安全区，没有在真机上量过 inset。
- `development/tests/browser/auth.spec.ts` 里原来点「更多」的用例已改成断言 6 个入口且页面不横向溢出。完整 Playwright e2e 没有对真实后端重跑。
- `development/test-nav-structure.mjs` 的移动段已改成单行 6 入口和子页高亮。整份脚本没有再跑一遍。
- 验收宽度是 390。更窄的 320 没有作为通过条件测量；12px 四字标签在 320 上会比单格更紧。
