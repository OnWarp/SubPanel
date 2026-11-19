# REPORT — 移动端底栏 NovoNET 式悬浮胶囊

基线 `origin/main` `a14038392d9f46ea23235d4674be1bec3714b522`（日志里的短哈希 `a1403839`）。分支 `task/mobile-nav-novo`。几何按简报「实测尺寸」小节，覆盖简报其余估算。

## 入口

窄屏断点仍是 `max-width: 760px`，与 `MOBILE_MEDIA_QUERY` 一致。宽屏底栏 `display: none`，桌面侧栏仍是 6 个一级入口。

管理端窄屏底栏 4 项：概览、节点管理、订阅管理、用户管理。运营管理、系统设置不在底栏里。落在这两个域（以及它们的子页，如 `/catalog/apps`）时，底栏 4 项都没有 `aria-current`，也没有 `active`。`/invites` 仍高亮「用户管理」，因为它属于用户管理域。

窄屏顶栏头像菜单顺序：运营管理（`/delivery/tickets`）、系统设置（`/system/registration`）、账户安全、外观、退出登录。桌面侧栏账号菜单不加这两项。两处 `ThemeMenu` 使用不同 id（`admin-theme-menu` / `admin-theme-menu-topbar`），避免隐藏副本抢走弹出层。

用户端底栏仍是首页、订阅、节点、我的，路由不变。

## 几何（390×844 实测）

选中胶囊就是等分格子本身，只改背景和前景，占位不变，切换不挤动其它项。390 宽、左右各 19px 时，格子约 80.5×54，落在实测的 80–85 × 52–55 里。更窄时格子会跟着变窄，不以 320 作为通过条件。

390×844、deviceScaleFactor 2，管理端浅色/深色与用户端浅色/深色四组读数一致：

- 条：`position: fixed`；左 19px、右 19px、底 9px（另加 `safe-area`）；高 68px、宽 352px；圆角 34px（高度一半）；1px 描边（浅色 `rgba(0,0,0,0.16)`，深色 `rgba(255,255,255,0.16)`）；表面 `color-mix(in srgb, var(--color-surface) 92%, transparent)`；`backdrop-filter: blur(18px)`；阴影 `0 8px 24px rgb(0 0 0 / 0.12), 0 2px 6px rgb(0 0 0 / 0.06)`。深色 `--shadow-float` 是 `none`，所以阴影写在底栏规则上，没有改令牌。
- 选中胶囊：宽 80.5、高 54、圆角 26px；填充 `rgb(94, 106, 210)`（`#5e6ad2`，浅色深色相同，不用浅色主色 `#0071e3`）；前景 `rgb(255, 255, 255)`；图标 23×23；文字 13px；图标与文字间距 5px。四字标签没有截断。
- 滚动到底：底栏矩形不变，不隐藏、不收缩。内容区 `padding-bottom: calc(9px + 68px + 16px + env(safe-area-inset-bottom, 0px))`（93px）。末尾内容与底栏的间隙：管理端 24.75px，用户端 25.5px。`scrollWidth` 不超过视口。
- 源样式只写标准 `backdrop-filter`。同时写 `-webkit-backdrop-filter` 时，构建压缩会只留下前缀，Chromium 的 `getComputedStyle` 读到 `none`。只写标准属性后，产物里两者都在，计算值为 `blur(18px)`。

## 改动文件

- `src/app/navigation.ts`：新增 `adminMobileDock`，只保留 4 个底栏域，对象仍是 `adminDomains` 里的同一引用。
- `src/app/AppShell.tsx`：底栏改走 `adminMobileDock`，图标 23px；窄屏账号菜单增加运营管理、系统设置。
- `src/styles/app.css`、`src/styles/pages-nav.css`：悬浮条几何、靛蓝选中胶囊、内容底边距。`pages-nav.css` 在后面加载，用户端规则已对齐，避免把旧的 8px/60px 底栏盖回来。
- `development/tests/ui/navigation-structure.test.ts`：底栏 4 项、非底栏域不高亮、窄屏菜单顺序。
- `development/tests/browser/auth.spec.ts`：手机视口断言改为 4 个底栏入口。
- `development/test-nav-structure.mjs`：移动段改为 4 入口，并从顶栏菜单进入运营管理、系统设置后断言底栏无选中。页签 `aria-current` 改为 Playwright 重试断言（地址栏更新早于 React 提交）。订阅分发页的拦截补了 `{ templates: [], defaultId: null }`，否则附加配置把空对象的 `templates` 当成数组，页面在到达底栏断言前崩溃。
- `REPORT_MOBILE_NAV_NOVO.md`

`BRIEF_MOBILE_NAV_NOVO.md` 与 `NOVONET_INSPECTION.md` 是任务输入，未纳入提交。截图留在 `/tmp/mobile-nav-novo-shots/`，未提交。

## 测试

基线取自 `/tmp/grokmobilenovo.log` 分隔线 `===== BASELINE END 2026-11-19T16:04:07+00:00 =====` 之前，HEAD `a1403839`。该段没有记录 `check` / `build`。

| 命令 | 基线 | 完工 |
| --- | --- | --- |
| `npm test`（worker） | 57 文件，481 通过 | 57 文件，481 通过 |
| `npx vitest run --config development/vitest-pages-node.config.ts` | 14 文件，188 通过 | 14 文件，189 通过 |
| `npm run check` | 基线日志未记 | 通过（wrangler types、tsc、oxlint 0 warning / 0 error，315 文件） |
| `npm run build` | 基线日志未记 | 通过（`dist/client/assets/index-stfPUgTc.css`、`index-cYC3z_JT.js`） |
| `node development/test-nav-structure.mjs` | 基线未跑 | 通过（输出 `PASS: ... mobile admin four-entry dock, narrow account menu ...`） |

`navigation-structure.test.ts` 由 79 条增至 80 条（窄屏菜单顺序）。页面套件因此比基线多 1 条。worker 套件条数与基线相同。

## 截图自查（Playwright Chromium，390×844，deviceScaleFactor 2）

用构建产物 `dist/client`，接口在浏览器里拦截，不连真实后端。

- 管理端浅色、深色 `/dashboard`：4 项一行，概览为实心靛蓝胶囊，标签完整，条悬浮在内容之上。
- 用户端浅色、深色 `/home`：首页、订阅、节点、我的，首页为同一靛蓝胶囊。浅色主按钮仍是令牌蓝 `#0071e3`，只有底栏选中胶囊用 `#5e6ad2`。
- 窄屏头像菜单：运营管理、系统设置、账户安全、外观、退出登录。点击运营管理进入 `/delivery/tickets`（工单页签在），点击系统设置进入 `/system/registration`（含注册设置）。两页底栏 `aria-current` 数量都是 0。
- 全局 `html[data-theme-ready] *` 对 `background-color` 有 160ms 过渡。`aria-current` 刚清掉的那一帧，原选中格背景仍会从 `#5e6ad2` 淡出（过渡中曾采到 `rgb(145, 153, 224)`）。等 400ms 后再量，工单页 4 格的计算背景都是 `rgba(0, 0, 0, 0)`，没有 `active`。系统设置页同样是 0 个 `aria-current`。
- 1280×800：底栏 `display: none`，侧栏仍是 6 个入口。

截图：`/tmp/mobile-nav-novo-shots/admin-light.png`、`admin-dark.png`、`user-light.png`、`user-dark.png`，以及菜单 `admin-menu-light.png`、无选中 `admin-tickets-none.png`。

## 未验证项

- 这台 Chromium 的 `safe-area-inset-*` 为 0，没有在有刘海的真机上量过安全区。
- 只把 390 宽当作几何通过条件。更窄时等分格子会小于 80px。
- `development/tests/browser/auth.spec.ts` 只改了断言，没有跑完整 `npm run test:e2e`，也没有对真实后端重放。
- 令牌、桌面侧栏、各页内容、路由和接口没有改。沉浸式面板和 NovoNET 抽屉、问候头图不在本线。
