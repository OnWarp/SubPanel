# SubPanel 弹窗重构 P4

分支 `task/sub-modal-p4`，基底 `1c179dd3e`。以仓内《SubPanel_Modal_Interaction_Refactor》§7–§10 为准。兑换码规格为 12 位、三组 `XXXX-XXXX-XXXX`

## 删除与分批回归

行号取自基底 `1c179dd3e`

| 批次 | 文件及行号 | 删除依据 | 回归 |
|---|---|---|---|
| 1 | `src/ui/EditDrawer.tsx` 1–29 | 全仓扫描仅该文件自身声明兼容组件及类型。没有导入、JSX 调用或外部类型引用，`ShareDrawer` 已由 P2 迁移 | 单独删除后 check 0 错、controls 36/36；随后以该构建运行双主题浏览器基线 |
| 2 | `src/styles/app.css` 347–365、368–369、374–377、472 | 旧尺寸、固定高度、右贴边和底贴边、面板、遮罩及旧标题布局均无渲染入口。保留实际用于分享表单的 `.dialog-actions` 样式 | 单独运行 pages-node 235/235，最终双主题覆盖来源、节点、分享和确认框 |
| 2 | `src/styles/app.css` 143、432–442，`src/styles/user-shell.css` 69，`src/styles/tokens.css` 46、107、146 | 旧移动导航面板和遮罩没有 JSX。旧遮罩色及层级令牌仅由废弃规则引用 | pages-node 235/235，包括更新后的现有移动导航样式断言 |
| 2 | `src/styles/app.css` 318，`src/features/admin-resources/resource-card.css` 189–197 | 无 `.drawer-section-title` 或 `.drawer-content` 元素。订阅详情的标题规则仍有引用 | pages-node 235/235，最终浏览器资源页与订阅截图 |
| 2 | `src/styles/pages-apps.css` 533–540，`src/styles/pages-user-d.css` 542–550，`src/styles/components.css` 698 | 旧窗口选择器无匹配元素。保留 `.sp-dialog-close` 的触控尺寸 | pages-node 235/235，最终 P2 APP／账号及 P3 触控与双主题 |
| 2 | `src/styles/pages-shares.css` 22 | `.sh-drawer-lead` 无引用 | pages-node 235/235，最终 P2 分享流程及截图 |
| 3 | `src/ui/focus-field.ts` 2 | 唯一调用者为 `Dialog`，正文由 `.sp-dialog-body` 提供。移除旧正文选择器 | 最终 P0 的初始焦点、ESC 与焦点恢复，以及 P3 视口变化测试 |
| 4 | `src/styles/admin-navigation.css` 363–365，`src/styles/pages-catalog.css` 92 | 顶栏背景滚动锁已由共享 `.sp-dialog:modal` 规则覆盖；同步预览操作位于共享页脚，旧正文动作选择器无匹配元素 | pages-node 235/235；1024px 顶栏双主题专项 2/2，覆盖背景滚动锁、忙时关闭守卫与触发器焦点恢复 |
| 5 | `src/styles/pages-shares.css` 23、40–50、68–89、300、309 | 旧结果卡 `.sh-reveal` 及移动端子规则没有渲染入口。分享空状态改用正文排版，消除嵌套边框 | pages-node 235/235，P2 分享流程双主题修订后复验 |

第三批也同步更新 `Dialog.tsx` 和 `app.css` 中仍在用的标题、操作区、放弃确认类名，更新 `catalog/{AppsPage,GroupsPage,NodesPage,SourcesPage}.tsx` 与 `kb/AdminKbPage.tsx` 的编辑状态命名，以及 `Controls.tsx`、`FormField.tsx` 的注释。导航断言改在 `development/tests/ui/navigation-structure.test.ts`，8 项已知浏览器用例原样保留。业务 API、缓存层、Worker、订阅链及 `public/_headers` 无提交差异

删后扫描涵盖 `EditDrawer`、`ShareDrawer`、Drawer、抽屉、右侧滑入、`right:`、`slide-in`、动画及 `z-index`。活跃代码只有 `src/ui/Dialog.tsx` 渲染原生 `dialog`、调用 `showModal()`。现存进场和遮罩动画在 `components.css` 511–515，分别为缩放和淡入。没有右侧滑入关键帧或业务 CSS 的模态定位、层级覆盖。历史报告、旧测试描述、以及订阅链共用的在用内容类名 `drawer-note`、`drawer-form`、`sh-drawer` 仍可被文字扫描找到。它们用于说明文字、表单标记或分享正文排版

## 52 个业务调用点

对应 `docs/modal-inventory.md` 原表 15–66 行，以下定位均相对于 `src/features/`

| 原清单行 | 当前入口 |
|---|---|
| 15 | `catalog/SourcesPage.tsx:425` · 添加／编辑来源 Dialog |
| 16 | `catalog/SourcesPage.tsx:468` · 同步差异 Dialog |
| 17 | `catalog/SourcesPage.tsx:485` · 停用／删除 ConfirmDialog |
| 18 | `catalog/NodesPage.tsx:366` · 添加／编辑节点 Dialog |
| 19 | `catalog/NodesPage.tsx:433` · 保留／停用 ConfirmDialog |
| 20 | `catalog/GroupsPage.tsx:292` · 分组表单与节点选择共用 Dialog |
| 21 | `catalog/GroupsPage.tsx:345` · 删除分组 ConfirmDialog |
| 22 | `catalog/AppsPage.tsx:380` · APP 表单 Dialog |
| 23 | `catalog/AppsPage.tsx:434` · 删除 APP ConfirmDialog |
| 24 | 旧管理端订阅添加向导与行编辑随 PR4 退役 |
| 25 | 旧管理端订阅详情随 PR4 退役，用户详情现见 `delivery/UserSubscriptionPlan.tsx` |
| 26 | 旧管理端临时分享入口随 PR4 退役 |
| 27 | 旧管理端二维码入口随 PR4 退役，用户二维码见 `delivery/LegacySubscriptionsPage.tsx:286` |
| 28 | 旧管理端订阅批量删除入口随 PR4 退役 |
| 29 | 旧管理端详情重置入口随 PR4 退役，用户绑定处重置见 `delivery/UserSubscriptionPlan.tsx:255` |
| 30 | 旧管理端批量更换计划入口随 PR4 退役 |
| 31 | 旧管理端批量更换转换配置绑定入口随 PR4 退役 |
| 32 | `delivery/SubscriptionBatchJobs.tsx:143` · 批量任务 Dialog，从 `accounts/UserManagementPage.tsx:29` 挂载 |
| 33 | `delivery/SubscriptionBatchJobs.tsx:192` · 批量影响 ConfirmDialog |
| 34 | `delivery/EntitlementTemplatesPanel.tsx:205` · 权益模板表单 Dialog |
| 35 | `delivery/EntitlementTemplatesPanel.tsx:259` · 权益版本 Dialog |
| 36 | `delivery/EntitlementTemplatesPanel.tsx:274` · 模板停用／归档 ConfirmDialog |
| 37 | 旧计划表单随 PR4 退役，计划路由跳转到权益模板 |
| 38 | 旧计划删除入口随 PR4 退役，权益模板归档见第 36 项所在行 |
| 39 | `delivery/AdminSharesPage.tsx:290` · 禁用／撤销 ConfirmDialog |
| 40 | `delivery/LegacySubscriptionsPage.tsx:291`、`delivery/MySubscriptionsPage.tsx:100` · 旧版／统一订阅重置 ConfirmDialog |
| 41 | `delivery/LegacySubscriptionsPage.tsx:294` · ShareDialog；`delivery/MySubscriptionsPage.tsx:96` · 统一订阅分享 Dialog |
| 42 | `shares/ShareDialog.tsx:375` · 列表、创建、结果共用 Dialog |
| 43 | `shares/ShareDialog.tsx:448` · 禁用、重置、删除 ConfirmDialog |
| 44 | `delivery/UserSubscriptionPlan.tsx:115` · 用户权益绑定 Dialog |
| 45 | `accounts/UsersPage.tsx:645` · 邮箱 Dialog |
| 46 | `accounts/UsersPage.tsx:668` · 密码与临时结果 Dialog |
| 47 | `accounts/UsersPage.tsx:712` · 角色与账户处置 ConfirmDialog |
| 48 | `accounts/UsersPage.tsx:723` · 批量用户操作 ConfirmDialog |
| 49 | `accounts/AccountPage.tsx:150` · 退出所有会话 ConfirmDialog |
| 50 | `user/MinePage.tsx:195` · 重置订阅链接 ConfirmDialog |
| 51 | `redemption/AdminRedemptionsPage.tsx:115` · 生成兑换码 Dialog 表单态 |
| 52 | `redemption/AdminRedemptionsPage.tsx:115` · 同一 Dialog 的敏感结果态 |
| 53 | `redemption/AdminRedemptionsPage.tsx:324` · 停用／撤销 ConfirmDialog |
| 54 | `system/TemplateEditor.tsx:364` · 发布配置 Dialog |
| 55 | `system/TemplateEditor.tsx:378` · 离开编辑 Dialog |
| 56 | `system/TemplateList.tsx:168` · 更换默认、复制、归档 Dialog |
| 57 | `system/TemplateList.tsx:224` · 历史与回退 Dialog |
| 58 | `system/DomainSettingsSection.tsx:378` · 删除域名 ConfirmDialog |
| 59 | `system/InviteCodesSection.tsx:270` · 删除邀请码 ConfirmDialog |
| 60 | `system/InviteCodesSection.tsx:280` · 停用邀请码 ConfirmDialog |
| 61 | `system/NoticesSection.tsx:258` · 删除公告 ConfirmDialog |
| 62 | `kb/AdminKbPage.tsx:439` · 文章编辑 Dialog |
| 63 | `kb/AdminKbPage.tsx:508` · 删除文章／分类 ConfirmDialog |
| 64 | `tickets/TicketsPage.tsx:105` · 新建工单 Dialog |
| 65 | `tickets/TicketDetailPage.tsx:128` · 用户关闭工单 ConfirmDialog |
| 66 | `tickets/AdminTicketDetailPage.tsx:159` · 管理员关闭工单 ConfirmDialog |

旧管理订阅和计划页面的删除来自合并 `1bbe9f6`，路由见 `src/app/router.tsx:86` 与 `:91`。原清单的原生切换模板确认亦随旧管理订阅页面退役。Popover、标题栏 Portal 和移动导航仍按原组件实现

## 自动回归

| 命令 | 结果 |
|---|---|
| `npm run check` | 退出 0，0 错误，66 条既有 lint 警告 |
| `npm run build` | 退出 0，保留既有前端分块体积警告 |
| `CI=1 npm test` | 68 文件通过，591 项通过、4 项跳过 |
| `CI=1 npx vitest run --config development/vitest-pages-node.config.ts` | 15 文件、235 项通过 |
| `CI=1 npx vitest run --config development/vitest.controls.config.ts` | 8 文件、36 项通过 |
| Chromium 1024px 顶栏补测 | 浅色 1/1、深色 1/1 通过，单一模态、背景滚动锁、提交中的 X／取消／ESC／遮罩守卫、请求失败后草稿守卫和关窗焦点恢复 |

浏览器用仓内锁定依赖与 Chromium Headless Shell 1255。每次构建准备时重建 P4 工作树的本地 D1 状态、应用迁移并写入 5 个就绪标志，预览和测试在同一次执行中运行。工作树初始缺少依赖，已有共享依赖版本与锁文件不一致，本线以 `npm ci` 安装锁定版本

浏览器套件覆盖 1440／1024／390px 浅深主题。P3 另覆盖 320／768／1920px、顶栏与侧栏、模拟键盘遮挡、视觉视口平移、横竖屏、非对称安全区及主题对比度

| 套件 | 浅色通过／总数 | 深色通过／总数 | 已知失败位置 |
|---|---:|---:|---|
| modal-p0 | 9/9 | 9/9 | — |
| modal-p1 | 6/9 | 6/9 | 201 行 ×3 |
| modal-p2 | 33/36 | 33/36 | 423 行 ×3 |
| modal-p3 | 16/16 | 16/16 | — |
| template-p3 | 9/11 | 9/11 | 178、285 行 |
| 合计 | 73/81 | 73/81 | 每种主题均为同 8 个用例 |

8 项已知失败归属 PR4 测试债，旧管理订阅和计划路由重定向后测试仍走旧入口。本线保留用例，逐一对照基线与清理版失败集合。最后一批分享样式变更后，以命令行筛除这 8 项并重跑全部其余场景，浅色 73/73、深色 73/73，合计 146/146，P3 专项每轮 16/16。P0 核对滚动隔离、Tab 环、ESC、焦点回归和敏感结果；P1 核对节点、来源与兑换码复制、批量导出、关闭保护和结果清理；P2 核对客户端导入、二维码和分享；P3 核对居中、滚动、触控和视口适配

## 截图与复验边界

最终截图目录为 `/data/tmp/sub-modal-p4-evidence/delivery-light-screens/` 与 `delivery-dark-screens/`，各目录内按以下文件名查阅。测试产生的仓内截图已复原，交接截图单独留存

| 页面 | 文件 | 视口 |
|---|---|---|
| 我的订阅 · 导入客户端 | `client-import-{1440,1024,390}.png` | PC、窄桌面、移动端 |
| 节点 · 添加节点 | `node-create-{1440,1024,390}.png` | PC、窄桌面、移动端 |
| 兑换码 · 生成表单与单码／批次结果 | `redemption-{create,single,batch}-{1440,1024,390}.png` | PC、窄桌面、移动端 |
| 我的订阅 · 分享空状态 | `share-{1440,1024,390}.png` | PC、窄桌面、移动端 |
| APP · P3 双主题表单 | `app-editor-{1440,1024,390,320}-{light,dark}.png` | PC、窄桌面、移动端 |

已目视抽查 1440px 与 390px 的上述关键页面，两主题均为居中单层窗口，长正文独立滚动，分享空状态无内嵌边框。对照图存于 `/data/tmp/sub-modal-p4-evidence/delivery-contact.png`（216.31 KB）。截图使用本地模拟数据，兑换码批次结果背景的日期异常来自测试夹具。真实设备软键盘、Safari／iOS Safari 尚未实测。原 8 项已知债务仍由 `task/sub-testfix8` 跟进

## Git 交接

便于独立复核代码的包为 `/data/tmp/sub-modal-p4-evidence/sub-modal-p4-code.bundle`，含至 `790b6f1` 的代码提交，大小 38.78 MB，SHA-256 为 `773585231efadd132fae866c3edec4660f5083f7fcbb5e095eef525149624305`

正式包为 `/data/tmp/sub-modal-p4.bundle`，包含完整分支历史及本报告。其 SHA-256 写入旁置文件 `/data/tmp/sub-modal-p4.bundle.sha256`，因为把正式包自身摘要写回其中的已提交报告会改变包内容和摘要

SUB_MODAL_P4_DONE
