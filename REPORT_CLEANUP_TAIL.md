# SubPanel 收尾线交付报告

分支 `task/cleanup-tail`，基线 `c1ea30ead6c32112d1c9eb92e6d7e117f88edff4`，提交身份 Muse <muse@outtw.com>。`src/app/api.ts` 与 `public/_headers` 和基线字节一致。业务 API、D1 迁移、订阅编译、权限、cron 与到期提醒调度未改

## 1. 管理员浏览器规格

三处失败都是规格过时，界面保持现行行为。串行套件 `development/tests/browser/admin-frontend.spec.ts` 16 项通过

### 订阅导航 `aria-current`

判定：界面正确。带分区的管理域链接使用 `aria-current="location"`，分区页签使用 `aria-current="page"`

依据：`src/app/AppShell.tsx` 中 `AdminNavigation` 在 `activeDomain.section` 存在时写 `location`，否则写 `page`。`src/app/navigation.ts` 的订阅域带有分区「订阅管理导航」，页签为订阅、分享、订阅计划。`development/tests/ui/navigation-structure.test.ts` 与 `development/tests/browser/mobile-nav.spec.ts` 已按此约定断言。`REPORT_DESIGN_V2_P1.md` 记录的就是这处旧断言。用户侧边栏与底栏仍使用 `aria-current="page"`

规格只改断言：顶栏短标签「订阅」为 `location`，分区页签「订阅」为 `page`

### 邀请

判定：界面正确。用户管理拆分和邀请码改版之后，顶栏不再有「创建邀请」，页面不再有「邀请用户名」

依据：`UserManagementPage` 标题为「用户管理」，按钮「邀请用户」进入 `/invites`。`InviteCodesSection` 标题为「注册邀请码」，动作为「生成邀请码」，批量工具只有「停用」。行菜单是 `<summary class="icon-button">`，可访问名称为「{用户名} 的操作」，不是 `button`。管理员行的「停用」为禁用，`title` 为「管理员不能在这里启用或停用」。顶栏高度为 `--size-topbar`（48px），管理端标题为 `--font-page-title`（20px）。`development/tests/ui/invite-routes.test.ts` 与 `users-page.test.tsx` 仍是这份契约，本线未改它们

规格改为：管理员行不能停用；从「邀请用户」进入邀请码页；生成 2 个批量单次码；390px 下从「更多批量操作」打开「停用邀请码」，点遮罩不关闭

### 密码重置

判定：对话框在请求进行中保持打开的行为还在。打开方式、接口和造用户路径已变

依据：`UsersPage` 的「重置密码」只出现在普通用户行菜单里。提交按钮文案保持「确认重置」，`mutating` 时禁用。`Dialog` 在 `busy` 时忽略 Escape。接口是 `POST /api/admin/users/:id/reset-password`。现行创建普通用户的路径是邀请码注册：`PUT /api/admin/system/registration` 设为 `invite`，`POST /api/admin/invites` 发码，`POST /api/register` 带用户名、密码、邮箱和邀请码。注册成功后会话切到新用户，规格再以管理员登录。`page.request` 不携带页面会话，规格改为页内 `fetch`，并先等到 `/dashboard`

`POST /api/register` 在 `accountsUseD1` 为假时返回 409 `REGISTRATION_UNAVAILABLE`（「注册暂不可用」）。该标记是 `system_settings.accounts_d1_ready`，现有迁移不写入，产品也没有账户导入接口（`REPORT_BATCH4.md`：协调者在带外置位）。验收库在创建管理员之前写入该标记，初始化因此把管理员写入 D1，随后注册可用。命令：

```sql
INSERT INTO system_settings (key, value, updated_at)
VALUES ('accounts_d1_ready', 'true', '2026-01-01T00:00:00.000Z');
```

`value` 为 JSON `true`。标记必须先于初始化；若管理员已只存在于 KV，再置位会使当前会话读到空的 D1 用户表

## 2. 用户订阅规格

`development/tests/browser/user-subscriptions.spec.ts` 1 项通过。旧规格按邀请兑换用户名、原生 `<select>`、「复制自动订阅链接」和「链接已复制」状态、以及「sing-box 二维码」对话框编写

现行界面对齐结果：

- 造用户与管理员规格相同，使用邀请码注册。退出登录在侧栏「管理员账号菜单」内
- 迁移 `0007_domain_stage.sql` 已把 `sub.warp.dpdns.org` 记为已验证主订阅域，所以链接、复制和二维码会渲染。主链接在平台就绪时优先「自动识别」（`pickPrimaryLink`）
- 链接是 `.del-link-text`。主复制按钮文案为「复制」，成功后就地变为「已复制」，不另出「链接已复制」。二维码是页内 `img`，替代文字为「订阅二维码」
- 切换订阅使用 `combobox`「选择订阅」。切到「备用订阅」后标题变化，平台仍按下「自动识别」，链接文本与主订阅不同
- 复制反馈不推动「订阅计划」区块的纵向位置。重置确认框点遮罩不关闭。确认后出现状态「订阅令牌已重置」和文本框「新订阅令牌」，链接随之更换
- 无有效订阅计划时编译结果是「输入 0 · 输出 0 · 跳过 0」。`worker/delivery/compiler.ts` 的 `entitledNodes` 在没有有效计划时给出 `noPlan` 并不输出节点。页头徽章为「无可用订阅」。诊断说明为「已跳过表示该节点未输出；节点仍会输出表示仅列出的字段未能映射，相关能力可能失效」

## 3. SubscriptionReset

全仓检索后，`src/features/user/SubscriptionReset.tsx` 没有导入方。它只用共享的 `ConfirmDialog`、`Select`、`StatusMessage`，没有专属样式或测试。已删除。`REPORT_DESIGN_V2_P3.md` 里的历史备注未改。页面套件仍为 227 项

## 4. 圆角令牌

未改 `tokens.css` 的阶梯，也没有新增数值。`--radius-card` 仍是 16px，`--radius-card-lg` 仍是 20px。样式里剩下的数字圆角只有 `0` 和 `50%`。`0` 是平面分割，`50%` 是状态点

| 原值 | 现用令牌 | 位置 |
| --- | --- | --- |
| `999px` | `--radius-pill` | 用户底栏项、浮动底栏项 |
| `34px` | `--radius-pill` | 浮动底栏外框。高度 68px，半径不小于一半，裁切后仍是同一胶囊。`test-mobile-bar-inset.mjs` 的指定值断言改为 `999px` |
| `5px` | `--radius-ctl`（6px） | 知识库行内代码，阶梯上最接近的一档 |
| `calc(var(--radius-control) - 2px)`（4px） | `--radius-ctl` | 账号菜单里的布局选项。只在菜单打开时可见 |

`development/screenshots/cleanup-tail/` 有 18 张 1440 与 390 截图，覆盖管理端概览、节点、订阅、用户、注册、分发，以及用户端首页、订阅、个人中心。与收敛前相比，9 张 1440 截图像素差为 0。390 上概览、节点、订阅、首页差为 0。其余像素差来自触控高度变化和底栏抗锯齿，不是转角形态：分发 33、个人中心 206、用户 7057、注册 14884、用户订阅 33041。用户订阅页的文字页签仍是下划线，没有被拉成 44px 按钮

## 5. 控件审计

Chromium 测量了上述页面。公共按钮按 32px、分段按钮按 28px、窄屏开关与触控目标按 `--size-touch-target`（44px）对齐。焦点沿用 `button:focus-visible`。禁用按钮与对话框关闭按钮为 `opacity: .4`。加载按钮已有 `disabled`、`aria-busy` 和 `.sp-spinner`

本线调整：

- `.sp-chip` 高度 30px 改为 32px，节点页同样。窄屏 `min-height` 为 44px
- `.sp-segmented button` 高度 26px 改为 28px。窄屏默认 44px。`.upd-subs .sp-segmented button` 在窄屏保持 `height: auto`，用户订阅文字页签不增高
- `.sp-search`、`.sp-select-trigger`、`.sp-input`、`.sp-textarea` 窄屏至少 44px。搜索框内部输入不另加最小高度。`controls.css` 最后引入，所以输入规则写在该文件
- 菜单行与用户账号菜单行桌面最小高度 36px 改为 32px，窄屏 44px
- 管理端账号菜单链接、按钮和外观入口窄屏至少 44px

保留、不按按钮尺寸放大：

- 选择框保持 18×18，放大后会改变表格行高
- 桌面搜索与下拉触发器高度 36px，跟 `--size-bar` / `--size-page-button` 走，不是 32/28 的公共按钮
- 「外观」带文字，桌面约 158×32（管理端）和 152×32（用户端）。它使用 `icon-button` 类，但不是 32×32 的方形图标按钮
- 品牌标记 28px，底栏把手 36×4
- `border-radius: 0` 与 `50%` 状态点
- 图标按钮维持桌面 24px、窄屏 32px。对话框关闭按钮桌面 24px、窄屏已是 44px

审计收尾后，令牌外圆角为 0。剩下的记录只有带标签的「外观」按钮

## 验收

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过。Wrangler 类型已是最新，oxlint 338 个文件 0 警告 0 错误 |
| `npm run build` | 通过。既有的超过 500 kB 分块提示仍在 |
| Worker `development/vitest.config.ts` | 58 个文件，515 项通过 |
| 页面 `development/vitest-pages-node.config.ts` | 15 个文件，227 项通过 |
| 控件 `development/vitest.controls.config.ts` | 8 个文件，36 项通过 |
| 订阅 `development/vitest-subscriptions-node.config.ts` | 3 个文件，14 项通过 |
| 模板 `development/vitest.templates.config.ts` | 5 个文件，93 项通过 |
| `development/test-mobile-bar-inset.mjs` | 通过，含底栏 `border-radius` 为 `999px` |
| `development/test-layout-switch-split.mjs` | 通过 |
| `development/test-design-v2-p3.mjs` | 通过。首页 320/768/1440、订阅复制与重置、账号菜单 Escape、节点筛选、窄屏外观与提醒开关、加载/失败/空态均通过 |
| `admin-frontend.spec.ts` | 16 项通过（30.3s） |
| `user-subscriptions.spec.ts` | 1 项通过（5.1s） |

浏览器规格对着已应用全部 17 个迁移的本地库运行，方法与 P1 相同：先 `wrangler d1 migrations apply subpanel-d1 --local`，再启动 Vite，Playwright 使用 `SUBPANEL_EXTERNAL_SERVER=1`，避免 `npm run test:e2e` 清空 `.wrangler/state`。清空后的冷启动会在迁移完成前访问 D1，出现 `no such table`。两支规格各自使用一份新库，并在初始化前写入上一节的 `accounts_d1_ready`。本机 Chromium 由 `CHROMIUM_PATH=/usr/bin/chromium` 指定。`development/playwright.config.ts` 只在该变量存在时附加 `executablePath`，未设置时与基线相同

三支回归脚本在本机临时使用系统 Chromium 跑通后，启动行已恢复为 `chromium.launch({ headless: true })`。它们改写过的历史截图已用基线版本还原，未进入本次提交

## 改动文件

| 文件 | 差异 |
| --- | --- |
| `development/tests/browser/admin-frontend.spec.ts` | 订阅 `location`/`page`、邀请码批量停用、现行密码重置 |
| `development/tests/browser/user-subscriptions.spec.ts` | 注册造用户、账号菜单退出、链接复制、页内二维码、计划门禁下的诊断文案 |
| `src/features/user/SubscriptionReset.tsx` | 删除未引用组件 |
| `src/styles/app.css`、`pages-nav.css`、`pages-kb.css`、`admin-navigation.css` | 圆角收进既有令牌 |
| `src/styles/components.css`、`controls.css`、`pages-nav.css`、`pages-user-d.css`、`user-shell.css`、`admin-navigation.css` | 按钮、芯片、分段、输入与窄屏触控高度 |
| `development/test-mobile-bar-inset.mjs` | 浮动底栏指定圆角改为 `999px` |
| `development/playwright.config.ts` | 可选的 `CHROMIUM_PATH` |
| `development/screenshots/cleanup-tail/` | 18 张对比截图 |
| `REPORT_CLEANUP_TAIL.md` | 本报告 |

## 未做

- `development/tests/browser/auth.spec.ts` 仍查找「用户与邀请」「邀请用户名」「创建邀请」。它不在本线验收清单内
- 未新增圆角数值，未把 `--radius-card` 从 16px 改到别的档
- 未恢复旧的「邀请用户名」字段，未改注册、D1 或权限语义
- 选择框、桌面 36px 字段、「外观」标签按钮、用户订阅文字页签、`0` 与 `50%` 圆角按上一节保留
- 无有效计划时用户订阅诊断为 0 个节点。给订阅发放计划会另建一条计划订阅，本线不改编译规则
