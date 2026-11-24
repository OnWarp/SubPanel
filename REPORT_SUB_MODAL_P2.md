# SubPanel 居中窗口 P2

工作分支为 `task/sub-modal-p2`，基底为本地 `origin/main` 的 `7b6921e5f`。Git 身份核对为 Muse。开工时 `/data` 可用约 5.9 GB。以 `git show HEAD:SubPanel_Modal_Interaction_Refactor.md` 和 `docs/modal-inventory.md` 的 52 个历史调用点为准，另扫描当前 JSX、原生 `showModal()`、遮罩选择器、Portal、popover 和路由。仓内方案 §5 与 P1 的 12 位三组兑换码保持原样。

## P0／P1 已经使用共享窗口的入口

| 文件或模块 | 调用点和规格 | 关闭策略 |
|---|---|---|
| `catalog/SourcesPage` | 添加／编辑、同步差异预览 L，批量停用／删除 S | 表单忙时拦截、脏表单提示。确认由共享组件处理 |
| `catalog/NodesPage` | 添加、编辑、批量导入 L，保留／停用 S | 表单忙时拦截、脏表单提示。确认由共享组件处理 |
| `redemption/AdminRedemptionsPage` | 生成 L、一次性结果 M，停用批次／撤销 S | 生成时拦截关闭，一次性结果继续沿用 P1 的明文保护 |
| `delivery/SubscriptionsPage` | 向导／编辑／详情 L，临时分享 M，二维码／删除／令牌重置 S | 编辑继续使用脏检查，分享结果阻止遮罩关闭。确认复用 P0 |
| `delivery/SubscriptionBatchJobs` | 批任务进度 XL、批量更换计划 M、影响确认 S | 执行中拦截关闭，计划选中未提交时共享脏检查 |
| `accounts/UsersPage`、`delivery/UserSubscriptionPlan` | 编辑邮箱、管理员重置密码 M，用户行订阅权益 L，角色／回收／批量操作 S | 编辑脏检查、临时结果防遮罩误关。确认由共享组件处理 |
| `delivery/AdminSharesPage`、`delivery/MySubscriptionsPage`、`user/MinePage`、`accounts/AccountPage` | 禁用／撤销分享、重置订阅链接、退出全部设备 S | 原有共享确认策略 |
| `system/TemplateList`、`system/TemplateEditor` | 默认／归档 S，复制 M，版本历史／发布 XL，离页确认 S | 保留预览和发布的策略，P2 将编辑与发布／离页确认互斥显示 |
| `tickets/TicketsPage`、`TicketDetailPage`、`AdminTicketDetailPage` | 新建工单 M，关闭工单 S | 继续使用共享窗口，新建成功进入详情 |

## 本线迁移

S／M／L／XL 分别对应 400／520／720／960 px。表单统一使用共享 Dialog。默认 X、Escape、窗口内取消和空白遮罩使用同一关闭守卫。忙时拦截关闭，表单更改后遮罩不关闭，X、Escape 或取消进入窗口内放弃状态。带新生成链接、邀请码、二维码或密码的窗口屏蔽遮罩关闭。共享确认窗屏蔽遮罩关闭。

| 文件 | 调用点与规格 | 补充策略 |
|---|---|---|
| `catalog/GroupsPage.tsx` | 添加／编辑 M，关联节点选择 L | 原窗口切换规格，保留来源、包含／排除节点和顺序。删除维持共享 S |
| `system/InviteCodesSection.tsx` | 邀请码创建／结果 M | 同窗口呈现结果、逐条复制和批量复制。停用和删除维持共享 S |
| `system/NoticesSection.tsx` | 公告新建／编辑 L | 保存错误在窗口中显示，删除维持共享 S |
| `tickets/AdminTicketDetailPage.tsx` | 重开工单 M | 显示重开结果，关闭工单继续用共享 S，工单回复保留页内 |
| `kb/AdminKbPage.tsx` | 新建／编辑文章 XL | 表单内容独立滚动，分类维护继续用页内表单。文章／分类删除使用共享 S |
| `catalog/AppsPage.tsx`、`styles/pages-apps.css` | 客户端添加／编辑 L | 窄屏平台字段单列，删除使用共享 S |
| `system/DomainSettingsSection.tsx` | 面板／订阅域名添加、域名备注编辑 M | 保留验证、设为主域名和启用等原行操作，删除用共享 S |
| `system/AdminMailSection.tsx` | 邮件模板编辑 XL，恢复默认 S | 带模板变量提示，恢复确认与编辑窗互斥。群发和提醒设置继续用页内表单 |
| `system/TemplateEditor.tsx`、`TemplateList.tsx`、`TemplatesSection.tsx` | 转换模板新增／编辑／预览 XL | 保留深链和浏览器返回守卫，发布预览和路由离开确认分别占用同一时刻的唯一窗口 |
| `system/RuleLibrary.tsx` | 自建规则与远程规则源 XL | 保留系统规则浏览和引用查询，失败保留当前输入 |
| `shares/ShareDialog.tsx`、`delivery/MySubscriptionsPage.tsx`、`SubscriptionsPage.tsx` | 替换 ShareDrawer。用户分享列表／创建／结果 M，禁用／重置／删除 S | 用户分享步骤原窗口切换，确认期间关闭列表层。管理员临时分享沿用 P1 |
| `delivery/PlansPage.tsx`、`EntitlementTemplatesPanel.tsx` | 计划新建／编辑 M。订阅权益模板新建／编辑、历史 XL | 直接调用共享 Dialog，保留输入检查和版本信息，停用／归档／删除确认沿用共享 S |
| `accounts/AccountPage.tsx`、`EmailBindChangeForm.tsx` | 修改密码、绑定／更换邮箱 M | 邮箱填写和验证使用同一窗口。个人信息只读部分继续在账户资料区显示 |
| `delivery/SubscriptionImports.tsx`、`MySubscriptionsPage.tsx`、`user/MinePage.tsx` | 导入客户端 M。用户订阅二维码 S | 复用原客户端链接和复制处理。按打开状态生成二维码，二维码无 Footer |
| `ui/Dialog.tsx`、`focus-field.ts`、`styles/components.css` | 共享窗口内切换步骤时重置正文滚动并移动焦点 | 保留原生顶层、焦点圈定／恢复和 P0 尺寸、滚动锁定及安全区 |

公开分享 `/s/:token`、公开订阅路径、登录、注册、邀请与初始化已检查。公开网页的访问验证、客户端链接和诊断为页内交互，未发现旧抽屉、底部面板或运行中的自定义遮罩。两个页头 Portal 和锚点菜单保留，兼容样式和 `EditDrawer` P4 兼容组件保留。复核时业务 JSX 中已没有 `EditDrawer` 调用。

## 验证

- `npm run check` 通过，0 错误。现有 Oxlint 警告仍有输出
- `npm run build` 通过。Vite 保留产物体积告警
- `CI=1 npm test` 通过。67 个文件，576 项通过，4 项为测试配置已有的跳过
- Chromium 的 `modal-p2.spec.ts` 在 1440、1024、390 px 各通过 12 项，域名旧入口回归另通过 1 项。覆盖新增、编辑、保存失败重试、同窗口步骤、共享危险操作、关闭策略及焦点。42 张截图位于 `development/screenshots/sub-modal-p2/`，约 2.1 MB
- Chromium 的 P0、P1 模态回归共通过 18 项，转换配置 `template-p3.spec.ts` 通过 11 项
- 补跑三套旧的串行浏览器场景时，`auth.spec.ts` 在访客主题存储键断言处终止。`admin-frontend.spec.ts` 与 `user-subscriptions.spec.ts` 在初始化表单缺少必填初始化密钥时停留在 `/setup`。这些旧套件未到达 P2 入口，P2 独立场景以本地浏览器 API 测试数据覆盖相应交互

## 风险与回滚

变更集中于前端交互及其浏览器测试。主要集成风险在于窗口切换后焦点、异步失败反馈、长内容与窄屏组合。真实客户端协议交给外部应用的行为取决于设备，浏览器断言验证了正确的链接格式。

本机不推送，交付文件位于 `/data/tmp/sub-modal-p2.bundle`。集成侧可在拥有仓库与部署权限的环境导入 `task/sub-modal-p2`，再按现有上线流程执行。回滚使用 `git revert <P2 提交>` 后重建和重新部署前端，无数据库迁移或令牌处理步骤。

SUB_MODAL_P2_DONE
