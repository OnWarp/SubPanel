# SubPanel UI/UX 2.0 · Phase 2 Grok 线交付报告

工作树 `/data/workspace/subpanel-uiux2-phase2-grok`，分支 `task/sub-uiux2-phase2-grok`，基底 `task/sub-uiux2-phase1` @ `b83614a9d`。范围只限用户列表、邀请、回收站和权益模板编辑弹窗，以及这几页直接用到的共享基础。未改用户详情、订阅授权页、订阅摘要 DTO、token 生成、兑换时长、权限、路由表、数据库语义、侧栏、底栏、Logo 和品牌色。未建遮罩链接或链接行组件。未部署，未合并 main，未碰生产数据

## 改动清单

- `src/app/navigation.ts` 增加 `contentOwnsModuleTabs`。`/users`、`/invites`、`/users/recycle-bin` 由页面自己渲染模块页签，避免和外壳重复。`/users/:id` 仍走外壳页签，详情页留给并行线
- `src/app/AppShell.tsx` 在上述三个列表路由不再重复输出 `SectionTabs`
- `src/features/accounts/UserManagementPage.tsx` 用 `PageContainer`（list，最大 1440px）作页面根。`PageHeader` 只放标题「用户管理」，主操作留在内容区，顶栏保持 48px、标题 20px。内容区放 `ModuleTabs`（用户 / 邀请 / 回收站，保留查询串）和区域「用户管理」里的「批量任务」「邀请用户」
- `src/features/accounts/UsersPage.tsx` 列表改接 `DataTable` 的摘要与紧凑分页，保留每页 20 条和当前页批量范围。状态改用 `StatusBadge`，文案仍是正常 / 已停用 / 已删除。行菜单仍是四字顺序：修改邮箱、重置密码、设管理员、订阅授权、停用账号或启用账号、删除用户。回收站仍是恢复、永久删除。批量栏仍是停用用户、启用用户、删除用户。窄屏保留「选择全部用户」。编辑用户、重置密码和确认框使用 `appearance="content"`。请求语义未改
- `src/features/accounts/InvitesPage.tsx` 与 `src/features/system/InviteCodesSection.tsx` 去掉旧列表。邀请码改用 `Section` 加 `DataTable`（选择、邀请码、类型、使用、到期、创建时间、状态、操作），保留批量停用、创建弹窗 `invite-editor`、风险确认，以及「邀请注册无需邮箱验证码」。邀请接口没有分页，不另造页码
- `src/features/delivery/EntitlementTemplatesPanel.tsx` 继续用 L 号弹窗，不新开路由。编辑、新建、专属新建和版本历史使用 `appearance="content"`。期限与单位并成两列，窄于 640px 时折成一列。高级限制收进 `AdvancedFields`。版本历史用 `content-version` 和 `DetailList`。配置变化时的说明是「保存后，N 位已绑定用户立即按最新配置交付，授权起止时间不变」。专属新建说明是「创建后回到订阅授权，需要再绑定才生效」。版本历史说明是「已绑定用户读取最新版，这里只展示历史配置」。保存、复制、启停、归档和专属创建后的跳转未改。指定节点快照的名称未改。模板列表本身不包进 `PageContainer`，订阅管理外壳页签保持原位
- `src/ui/DataTable.tsx` 增加可选 `summary`，与分页放在同一行。`src/styles/components.css` 增加摘要样式。`src/styles/content-ui.css` 补上内容弹窗分区、两列表单、版本历史，以及 `.usr-table` 的 `overflow: visible`，避免行菜单被表格裁切
- `development/tests/ui/users-page.test.tsx` 把外壳断言从 `data-section` 改为 `content-page`，状态类从 `usr-status-*` 改为 `sp-badge-*`。菜单、批量、加载和邀请文案断言保留

未纳入提交：工作树根的 `SubPanel-UIUX-2.0.md` 与 `prompt-grok.txt` 仍是未跟踪输入。`.dev.vars`、`.wrangler` 和 `dist` 不入库

## 前后截图

对比图在本机，不入库。改前目录 `/data/tmp/sub-uiux2-phase2-grok/before/`，改后目录 `/data/tmp/sub-uiux2-phase2-grok/after/`。两处都有 `users`、`invites`、`recycle`、`templates`、`template-editor`、`template-history` 的 1440 与 390，以及 `shell-1280.png`、`shell-1024.png`、`shell-768.png`

交互图只在改后目录：

- `interact-batch-disabled.png`：勾选 wuyang 后批量停用，状态变为已停用
- `interact-recycle.png`：批量删除后回收站出现该用户，状态已删除
- `interact-restored.png`：从行菜单恢复后回到用户列表，状态正常
- `interact-invites.png`：创建邀请码并关闭明文弹窗后，列表多一行，只显示前缀
- `interact-template-hint.png`：把期限改为 3 后，页脚出现即时生效说明
- `interact-template-v3.png`：保存后版本历史有 v3，有效期由 2 自然月到 3 自然月，列表默认时长同步为 3 自然月
- `interact-private-unbound.png`：专属模板创建后回到该用户订阅授权，表格为暂无绑定模板
- `interact-private-bound.png`：再在原有绑定弹窗里另绑，该专属模板状态为有效

1440、390、1280、1024、768 的 `scrollWidth` 都等于视口宽度，没有横向溢出。`development/screenshots/` 没有被改脏，不需要还原

## 测试结果

| 命令 | 结果 |
|---|---|
| npm run check | 通过。本地 `.dev.vars` 在场时 Wrangler 类型检查会把变量收进类型比较，因此检查前暂移该文件，结束后按原权限复位，没有重新生成 `worker-configuration.d.ts`。Oxlint 64 条警告、0 错误。Phase 1 报告记的是 66 条，本次未再追这两条差额 |
| npm run build | 通过。客户端主 JS 690.38 KB，gzip 197.59 KB。客户端 CSS 163.74 KB，gzip 26.46 KB。既有大 chunk 提示仍在。构建曾把 `.dev.vars` 拷进 `dist/subpanel/`，该副本已删，`dist` 被忽略 |
| npm test | 68 个文件通过，550 通过、1 跳过。跳过项仍是需要开关的兑换批次基准 |
| vitest-pages-node | 15 个文件，234 通过、1 失败。失败仍是订阅管理导航期望含 `/delivery/conversions`，与本线无关 |
| vitest-subscriptions-node | 8 通过、5 失败。仍是旧订阅创建、过期、分享范围和模板断言 |
| vitest.templates | 92 通过、1 失败。仍是模板 HTTPS rule-providers URL 断言 |
| vitest.controls | 8 个文件，36 通过 |

本地浏览器回归用仓根 `vite --host 127.0.0.1 --port 4173`，`SUBPANEL_EXTERNAL_SERVER` 不需要，因为没有走 Playwright 的 webServer。本地 D1 已清空并重放迁移，7 个就绪标志已写入。浏览器里完成了批量停用、批量启用、批量删除、回收站恢复、邀请码创建、模板保存出 v3、专属模板创建后不自动绑定、再单独绑定

## 未解决

- pages-node 1 条、subscriptions-node 5 条、templates 1 条失败是基底既有项，本线没有新增失败
- Phase 1 留下的旧移动底栏脚本入口超时，以及首页空状态文案断言，本线未追
- `/users` 不再使用 `.data-section`。`development/tests/browser/topbar-fill.spec.ts` 若仍用该选择器量用户列表铺满，会和内容区布局不一致。本次没有跑这条规格
- 390 宽的模板弹窗会压住既有移动底栏。底栏不在本线范围，1440 宽的内容弹窗本体是不透明的
- `/users/:id` 仍显示外壳的用户 / 邀请 / 回收站，下面还有详情页自己的基本信息 / 订阅授权 / 操作日志。这是范围划分留下的叠层，详情页和后端字段由另一条线处理，本线没有改 `UserDetailPage.tsx` 或 `UserSubscriptionPlan.tsx`
- 主机名 hwsg 无法解析。本机没有已登录的 instabox 会话，没有签发 SFTP 凭据，也没有把包传到 `/root/xfer`。报告提交即交付，没有用 base64 回传
- 功能与报告提交 `4a3fe360ae9feb774bc25b1626cf9334943e29ef`。本句所在提交是它的直接子提交，远端 `task/sub-uiux2-phase2-grok` 顶端即交付 HEAD

SUB_UIUX2_PHASE2_GROK_DONE
