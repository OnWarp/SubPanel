# SubPanel Design System V2 · P2 交付报告

分支 `task/design-v2-p2`，基线 `b76b5374`，提交身份 Muse <muse@outtw.com>

## 实现与差异文件

| 文件 | 差异 |
| --- | --- |
| `src/ui/FormField.tsx`、`src/ui/focus-field.ts`、`src/ui/Controls.tsx` | 增加表单分组、操作区、高级折叠和字段宽度类。普通字段在表单栈内限宽 460px，正文编辑器可标为宽字段。打开抽屉或弹窗时聚焦第一个字段 |
| `src/ui/EditDrawer.tsx`、`src/ui/Dialog.tsx` | 标题与底栏固定，正文滚动。底栏放保存和取消。未保存时 Esc、关闭按钮和弹窗遮罩先询问，再按 Esc 留在表单。明确的取消直接关闭。关闭后焦点回到打开前的元素 |
| `src/ui/Switch.tsx`、`src/styles/components.css`、`src/styles/app.css`、`src/styles/pages-system.css` | 开关用「开／关」表达状态，不单靠颜色。窄屏开关和抽屉关闭按钮触控高度 44px。订阅详情改为细线键值行，分区标题与共享标题同级 |
| `src/features/delivery/SubscriptionDetailRows.tsx`、`SubscriptionsPage.tsx`、`PlansPage.tsx`、`AdminSharesPage.tsx` | 订阅详情拆成键值行、链接行和诊断行。订阅与计划编辑按分组放进抽屉，保存留在底栏，未保存关闭会提示。分享页沿用现有分区 |
| `src/features/system/SystemPage.tsx`、`DomainSettingsSection.tsx`、`AdminMailSection.tsx`、`InviteCodesSection.tsx`、`TemplateEditor.tsx` | 设置内嵌分组改为共享表单组。到期提醒独立成区，保存仍在区标题，定时任务本身未改。邀请码生成放到表单操作区。新建附加配置可填 HTTPS 地址抓取一次，预览后随创建一起保存 |
| `src/features/accounts/UsersPage.tsx`、`src/features/tickets/AdminTicketsPage.tsx`、`AdminTicketDetailPage.tsx` | 用户编辑和重置密码在未保存时询问。工单筛选和回复表单对齐字段与操作位置 |
| `worker/templates/routes.ts` | 增加 `POST /api/admin/system/subscription-templates/import`。只抓取一次、不写库、不调度。与已有 `/:id/import` 共用同一远程抓取与校验，不新开出站通道，也不把地址写入审计 |
| `development/tests/controls/design-v2-p2.test.tsx`、`development/tests/worker/delivery-api.test.ts` | 覆盖订阅详情行式结构和一次抓取后创建 |
| `development/test-design-v2-p2.mjs`、`development/screenshots/design-v2-p2/` | 受影响路由截图与订阅编辑抽屉键盘检查 |

未改 `src/app/api.ts`、`public/_headers`、DataTable、FilterBar、SearchInput、BatchToolbar、catalog、admin-resources、`features/user`、MySubscriptionsPage、AppShell。确认框仍走现有 `ConfirmDialog`

## 影响路由

- `/system/registration`、`/system/mail`、`/system/distribution`、`/system/status`
- `/delivery/subscriptions`、`/delivery/shares`、`/plans`
- `/users`、`/users/recycle-bin`、`/invites`
- `/delivery/tickets`、`/delivery/tickets/:id`

订阅页和分享页仍用现有二级标题，没有另加一个重复的页面主标题。用户管理页保留原有主标题和分区标题，页面测试仍能找到「用户管理」

## 验收

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误 |
| `npm run build` | 通过。Vite 提示客户端包超过 500 kB，与基线相同 |
| `npm test` | 58 个文件，515 项通过。基线 514，新增一次抓取并创建的 Worker 测试 1 项 |
| `vitest-pages-node.config.ts` | 15 个文件，227 项通过 |
| `vitest.controls.config.ts` | 8 个文件，35 项通过。基线 33，新增行式详情与开关状态测试 2 项 |
| `vitest.templates.config.ts` | 5 个文件，93 项通过 |
| `vitest-subscriptions-node.config.ts` | 3 个文件，14 项通过 |
| 键盘 | 编辑订阅后 Esc 出现「关闭将放弃未保存的更改」，再按 Esc 留在表单，放弃更改后关闭。取消直接关闭且不出现提示 |

截图用固定数据拦截 API，在 `http://127.0.0.1:4181` 上由系统 Chromium 无头生成。每个路由 1440、768、390 浅色各一张，另加 390 深色一张，共 40 张。订阅页截图打开了详情抽屉。脚本同时检查单个主标题和页面不横向溢出

| 路由 | 1440 浅色 | 768 浅色 | 390 浅色 | 390 深色 |
| --- | --- | --- | --- | --- |
| 注册设置 | [图](development/screenshots/design-v2-p2/registration-1440-light.png) | [图](development/screenshots/design-v2-p2/registration-768-light.png) | [图](development/screenshots/design-v2-p2/registration-390-light.png) | [图](development/screenshots/design-v2-p2/registration-390-dark.png) |
| 邮件设置 | [图](development/screenshots/design-v2-p2/mail-1440-light.png) | [图](development/screenshots/design-v2-p2/mail-768-light.png) | [图](development/screenshots/design-v2-p2/mail-390-light.png) | [图](development/screenshots/design-v2-p2/mail-390-dark.png) |
| 订阅分发 | [图](development/screenshots/design-v2-p2/distribution-1440-light.png) | [图](development/screenshots/design-v2-p2/distribution-768-light.png) | [图](development/screenshots/design-v2-p2/distribution-390-light.png) | [图](development/screenshots/design-v2-p2/distribution-390-dark.png) |
| 运行状态 | [图](development/screenshots/design-v2-p2/status-1440-light.png) | [图](development/screenshots/design-v2-p2/status-768-light.png) | [图](development/screenshots/design-v2-p2/status-390-light.png) | [图](development/screenshots/design-v2-p2/status-390-dark.png) |
| 订阅管理 | [图](development/screenshots/design-v2-p2/subscriptions-1440-light.png) | [图](development/screenshots/design-v2-p2/subscriptions-768-light.png) | [图](development/screenshots/design-v2-p2/subscriptions-390-light.png) | [图](development/screenshots/design-v2-p2/subscriptions-390-dark.png) |
| 分享管理 | [图](development/screenshots/design-v2-p2/shares-1440-light.png) | [图](development/screenshots/design-v2-p2/shares-768-light.png) | [图](development/screenshots/design-v2-p2/shares-390-light.png) | [图](development/screenshots/design-v2-p2/shares-390-dark.png) |
| 订阅计划 | [图](development/screenshots/design-v2-p2/plans-1440-light.png) | [图](development/screenshots/design-v2-p2/plans-768-light.png) | [图](development/screenshots/design-v2-p2/plans-390-light.png) | [图](development/screenshots/design-v2-p2/plans-390-dark.png) |
| 用户 | [图](development/screenshots/design-v2-p2/users-1440-light.png) | [图](development/screenshots/design-v2-p2/users-768-light.png) | [图](development/screenshots/design-v2-p2/users-390-light.png) | [图](development/screenshots/design-v2-p2/users-390-dark.png) |
| 工单 | [图](development/screenshots/design-v2-p2/tickets-1440-light.png) | [图](development/screenshots/design-v2-p2/tickets-768-light.png) | [图](development/screenshots/design-v2-p2/tickets-390-light.png) | [图](development/screenshots/design-v2-p2/tickets-390-dark.png) |
| 邀请 | [图](development/screenshots/design-v2-p2/invites-1440-light.png) | [图](development/screenshots/design-v2-p2/invites-768-light.png) | [图](development/screenshots/design-v2-p2/invites-390-light.png) | [图](development/screenshots/design-v2-p2/invites-390-dark.png) |

## 未做项

- 到期提醒的定时调度仍保持原状。界面只把「到期提醒」分成独立设置区，并保留「自动定时触发待 cron 修复」说明
- 没有改分享设置和附加配置列表的数据区结构，它们已经是独立设置区
- 没有跑 `template-p3` 浏览器规格。已有配置仍使用「导入／重新导入」和「先保存草稿」，新建配置使用单独的「抓取预览」
- 截图是拦截 API 的界面检查，不是连上 Worker 的业务回归

## 交付与回滚

交付文件为 `/data/tmp/design-v2-p2.bundle`，包含 `refs/heads/task/design-v2-p2`，前置提交为 `b76b5374`。回滚时撤销本线提交即可恢复界面。没有数据库迁移

CODEX_DESIGN_V2_P2_DONE
