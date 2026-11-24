# SubPanel 弹层清单 · P0

基底 `bfdb8a625`。从组件定义追踪导入、JSX 调用和打开状态，再从路由、原生弹层 API、遮罩与固定定位 CSS 反查。共 **52 个业务组件调用点**（17 个 `EditDrawer`、27 个 `ConfirmDialog`、7 个 `Dialog`、1 个 `ShareDrawer` 包装入口），另有 1 个浏览器原生确认、4 处原生锚点 Popover、2 处标题栏 Portal、兼容样式及非模态交互，分别见下表。多个业务入口共用一个 JSX 调用时登记在同一行。

- 规格为内容目标 **S 400 / M 520 / L 720 / XL 960px**。括号内为 P0 实际组件规格。抽屉括号内为现有宽度档位
- **抽**为抽屉 X / ESC 关闭，遮罩保持打开。**确**为确认窗 X / ESC / 取消关闭，遮罩保持打开。**窗**为Dialog X / ESC / 取消（有则适用）/ 空白遮罩关闭。**锁**表示提交或注明的操作期间拦截关闭，**脏**表示X / ESC 进入放弃确认，Dialog 的取消同样走守卫，遮罩保持打开。旧抽屉内容内的取消仍执行现有各自逻辑
- 测试列记录可定位的场景覆盖。`P0` = `modal-p0.spec.ts`，`Admin` = `admin-frontend.spec.ts`，`转换` = `template-p3.spec.ts`，`账号` = `auth.spec.ts`，`订阅` = `user-subscriptions.spec.ts`，`域名` = `system-domains.spec.ts`，均在 `development/tests/browser/`。— 表示未找到该入口的专门弹层断言

## 业务调用

下表文件路径相对 `src/features/`。所有抽屉宽度沿用现有样式，目标规格供后续阶段使用

| 文件 | 组件 / 触发入口 | 规格 | 关闭策略 | 测试 |
|---|---|---|---|---|
| catalog/SourcesPage.tsx | EditDrawer · 添加来源 / 行编辑 | L（medium） | 抽，预览、保存锁 | P0 / Admin |
| catalog/SourcesPage.tsx | EditDrawer · 单个同步 / 批量刷新中的同步差异预览 | L（medium） | 抽、锁，取消同步队列或应用后推进 | Admin 有刷新错误路径 |
| catalog/SourcesPage.tsx | ConfirmDialog · 批量停用 / 删除 | S | 确、锁 | — |
| catalog/NodesPage.tsx | EditDrawer · 添加节点 / 行编辑 | L（compact） | 抽、锁 | — |
| catalog/NodesPage.tsx | ConfirmDialog · 批量保留 / 停用 | S | 确、锁 | Admin 停用 |
| catalog/GroupsPage.tsx | EditDrawer · 添加分组 / 行编辑，含关联节点 | M / L（wide） | 抽、锁 | Admin |
| catalog/GroupsPage.tsx | ConfirmDialog · 批量删除 | S | 确、锁 | Admin |
| catalog/AppsPage.tsx | EditDrawer · 添加 APP / 行编辑 | L（large） | 抽、锁 | — |
| catalog/AppsPage.tsx | ConfirmDialog · 行删除 | S | 确、锁 | — |
| delivery/SubscriptionsPage.tsx | EditDrawer · 添加订阅向导 / 行编辑 | L（medium） | 抽、锁、脏，底部取消沿用原逻辑 | Admin / 转换 |
| delivery/SubscriptionsPage.tsx | EditDrawer · 行查看详情 / 创建后的订阅详情 | L（medium） | 抽，由详情关闭动作清理二维码及错误 | Admin |
| delivery/SubscriptionsPage.tsx | EditDrawer · 行临时分享，含创建及链接结果 | M（medium） | 抽、锁 | — |
| delivery/SubscriptionsPage.tsx | ConfirmDialog · 详情内客户端二维码 | S | 确，复制动作关闭 | Admin |
| delivery/SubscriptionsPage.tsx | ConfirmDialog · 批量删除 | S | 确、锁 | — |
| delivery/SubscriptionsPage.tsx | ConfirmDialog · 详情重置令牌 | S | 确、锁 | Admin |
| delivery/SubscriptionsPage.tsx | ConfirmDialog · 批量更换计划 | M（S） | 确、锁，预览后切换至批量影响 | — |
| delivery/SubscriptionsPage.tsx | ConfirmDialog · 批量更换转换配置绑定 | XL（S） | 确、锁，预览后切换至批量影响 | — |
| delivery/SubscriptionBatchJobs.tsx | EditDrawer · 批量任务入口 / 任务详情和进度 | XL（medium） | 抽、锁，影响预览打开时隐藏 | — |
| delivery/SubscriptionBatchJobs.tsx | ConfirmDialog · 批量请求和影响预览 | XL（S） | 确、锁，取消清理待执行请求 | — |
| delivery/EntitlementTemplatesPanel.tsx | EditDrawer · 新建模板 / 行编辑 | XL（medium） | 抽、锁、脏 | — |
| delivery/EntitlementTemplatesPanel.tsx | EditDrawer · 行版本历史 | XL（medium） | 抽 | — |
| delivery/EntitlementTemplatesPanel.tsx | ConfirmDialog · 行停用 / 归档 | S | 确、锁 | — |
| delivery/PlansPage.tsx | EditDrawer · 新增计划 / 行编辑 | M（medium） | 抽、锁、脏，底部取消沿用原逻辑 | — |
| delivery/PlansPage.tsx | ConfirmDialog · 行删除计划 | S | 确、锁 | — |
| delivery/AdminSharesPage.tsx | ConfirmDialog · 行禁用 / 撤销分享 | S | 确、锁 | Admin 窄屏 |
| delivery/MySubscriptionsPage.tsx | ConfirmDialog · 重置订阅令牌 | S | 确、锁，显式恢复触发按钮 | 订阅 |
| delivery/MySubscriptionsPage.tsx | ShareDrawer · 管理分享按钮 | M（包装入口） | 同下方 ShareDrawer 的 EditDrawer | — |
| shares/ShareDrawer.tsx | EditDrawer · 我的订阅传入所选订阅，含创建、结果、列表 | M（large） | 抽、创建或变更时锁，内部完成仅清理结果 | — |
| shares/ShareDrawer.tsx | ConfirmDialog · 分享行禁用 / 重置链接 / 删除 | S | 确、锁，关窗回到抽屉 | — |
| delivery/UserSubscriptionPlan.tsx | EditDrawer · 用户行的订阅计划操作 | L（medium） | 抽、锁，保存后回到列表 | — |
| accounts/UsersPage.tsx | Dialog · 用户行编辑邮箱 | M | 窗、锁、脏，改动后取消也需确认 | P0 |
| accounts/UsersPage.tsx | Dialog · 用户行重置密码，含临时密码结果 | M | 窗、锁、脏，一次性密码结果屏蔽遮罩，X / ESC / 完成关闭 | P0 / Admin 有提交中 ESC |
| accounts/UsersPage.tsx | ConfirmDialog · 用户行提升为管理员 / 移至回收站 / 永久删除 | S | 确、锁，危险操作聚焦取消 | 账号有角色与禁用流程，未逐项覆盖 |
| accounts/UsersPage.tsx | ConfirmDialog · 用户表批量动作 | S | 确、锁 | — |
| accounts/AccountPage.tsx | ConfirmDialog · 账号安全中退出所有会话 | S | 确、锁 | 账号安全流程 |
| user/MinePage.tsx | ConfirmDialog · 我的页面重置订阅链接 | S | 确、锁 | — |
| redemption/AdminRedemptionsPage.tsx | EditDrawer · 生成兑换码，批次表单 | L（medium） | 抽、锁、脏，底部取消沿用原逻辑 | — |
| redemption/AdminRedemptionsPage.tsx | EditDrawer · 批次生成成功，完整码结果 `XXXX-XXXX-XXXX`（12 位 3 组） | M（medium） | 抽，未导出时 X / ESC 需确认放弃，导出后可关闭，卸载时清除结果 | — |
| redemption/AdminRedemptionsPage.tsx | ConfirmDialog · 停用批次 / 撤销单码 | S | 确、锁 | P0 停用批次 |
| system/TemplateEditor.tsx | Dialog · 发布附加配置，含差异和忽略字段 | XL | 窗、锁，取消清理错误 | 转换 |
| system/TemplateEditor.tsx | Dialog · 编辑有草稿时导航离开 | S | 遮罩关闭禁用，X / ESC / 继续编辑留在当前页，可保存或放弃，忙时锁 | 转换 |
| system/TemplateList.tsx | Dialog · 更换默认配置 / 行复制为新配置 / 行归档 | S / M / S | 窗、锁 | 转换 |
| system/TemplateList.tsx | Dialog · 行版本历史，含回退按钮 | XL | 窗、锁，取消回退清除选择，留在历史窗口 | P0 / 转换 |
| system/DomainSettingsSection.tsx | ConfirmDialog · 行删除域名 | S | 确、锁 | 域名保留行操作 |
| system/InviteCodesSection.tsx | ConfirmDialog · 删除已停用的单条邀请码 | S | 确、锁 | — |
| system/InviteCodesSection.tsx | ConfirmDialog · 停用单条 / 批量停用邀请码 | S | 确、锁 | Admin 批量 |
| system/NoticesSection.tsx | ConfirmDialog · 删除公告 | S | 确、锁 | — |
| kb/AdminKbPage.tsx | EditDrawer · 新增 / 行编辑文章 | XL（large） | 抽、锁 | — |
| kb/AdminKbPage.tsx | ConfirmDialog · 删除文章 / 分类 | S | 确、锁 | — |
| tickets/TicketsPage.tsx | Dialog · 页头或空态新建工单 | M | 窗、锁，成功后进入详情 | P0 |
| tickets/TicketDetailPage.tsx | ConfirmDialog · 用户关闭工单 | S | 确、锁 | — |
| tickets/AdminTicketDetailPage.tsx | ConfirmDialog · 管理员关闭工单 | S | 确、锁 | — |

## 原生弹层、Portal 与兼容样式

| 文件 | 入口 | 规格 | 关闭策略 / 性质 | 测试 |
|---|---|---|---|---|
| src/features/delivery/SubscriptionsPage.tsx | 已自定义字段时更换模板 | S | `window.confirm`，由浏览器处理取消，确认后覆盖模板字段 | — |
| src/ui/Dialog.tsx | 上表 Dialog 与 ConfirmDialog | S/M/L/XL | 原生 `showModal()` 顶层和 ::backdrop，共用关闭守卫 | P0 / 转换 |
| src/ui/EditDrawer.tsx | 上表 EditDrawer | 旧档位 | 原生 `showModal()` 顶层和 ::backdrop，遮罩不关闭 | P0 / Admin / 转换 |
| src/ui/ConfirmDialog.tsx | 上表确认调用 | S | 复用 Dialog，遮罩不关闭 | P0 / Admin / 账号 / 订阅 |
| src/ui/PageHeader.tsx | 页面标题和右侧操作 | — | 各一个 Portal 到 AppShell 顶栏插槽，随页面卸载 | `topbar-fill.spec.ts`、Admin 顶栏断言 |
| src/ui/BatchToolbar.tsx | 更多批量操作 | — | 锚点 Popover，ESC / 外点 / 动作 | Admin 批量流程 |
| src/theme/ThemeMenu.tsx | 外观按钮 | — | 锚点 Popover，ESC / 外点 / 选择 | 账号主题流程 |
| src/features/admin/OperationsCard.tsx | 运营操作的省略号入口（含计划行操作） | — | 锚点 Popover，ESC / 外点 / 动作 | — |
| src/features/admin-resources/ResourceCard.tsx | 行更多操作（节点、来源、分组、订阅、配置等） | — | 锚点 Popover，ESC / 外点 / 动作，动作前恢复菜单触发按钮 | Admin / 转换 |
| src/styles/app.css、src/styles/user-shell.css、src/styles/pages-user-d.css | `dock-backdrop`、`dock-sheet`、`reset-dialog`、旧 `confirm-dialog` | — | 样式兼容规则，未发现对应的渲染调用或打开状态 | `development/tests/ui/navigation-structure.test.ts` 有移动导航样式契约 |

另核对 `AppShell.tsx` 的账号菜单、`UsersPage.tsx` 的行菜单、`FilterBar.tsx` 高级筛选、`Controls.tsx` 的选择列表、固定定位 Toast / 表单反馈和移动导航。它们是 disclosure、锚点选择或反馈组件，无自定义模态遮罩。源码中无运行中的自定义全屏遮罩和 Sheet 实例

## 公开与用户页面核对

- `src/app/router.tsx` 的公开分享 `/s/:token`、邀请 `/invite/:token`、注册、登录、初始化及启动错误，分别核对 SharePage、InvitePage、RegisterPage、LoginPage、SetupPage 和路由错误区。分享访问验证、复制链接和客户端操作均在页内，诊断为原生 disclosure，邀请与认证使用页内表单及路由跳转。无独立 Drawer / Dialog / Modal / Sheet / Portal 或运行中的自定义遮罩，认证路由覆盖见 `auth.spec.ts`
- 用户侧 `src/features/redemption/PersonalRedemptions.tsx` 的兑换码输入、匹配、确认与记录使用 `/me` 下页内状态，码规格记为 12 位 3 组 `XXXX-XXXX-XXXX`，无独立弹层。管理员结果抽屉仅展示 API 返回内容，12 位格式由兑换码收敛线提供
- 公告编辑、邀请码创建、域名新增、知识库分类编辑为页内表单，用户侧公告、知识库、客户端下载、节点列表为独立页面或行内操作。相关确认弹层已列在上表
