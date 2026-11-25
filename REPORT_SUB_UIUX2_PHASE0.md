# SubPanel UI/UX 2.0 · Phase 0 仓库审计

基底 main ab885ce1f，审计工作树 task/sub-uiux2-phase0。依据《SubPanel-UIUX-2.0.md》全文、入口与页面源码、Worker 路由及服务、迁移和本地基线。示例数据仅用于理解布局。本文的迁移指内容层迁移，权限、计算、接口与兼容入口继续沿用现有实现

## 路由、页面、权限与 API 对照

入口为 index.html → src/main.tsx → src/app/App.tsx → src/app/router.tsx。下表同时是可见与操作矩阵。A 为管理员，U 为普通用户，A/U 为两种已登录角色，G 为访客或持有效公开凭据者。每行列出的操作受同一行角色约束，附加对象限制见该行及后文。API 路径均相对于 /api，公开订阅入口例外。分页注明其来源，未注明分页的详情和弹窗为当前对象视图

| 路径与实际页面 | 可见与可操作 | 实际内容、操作和列表行为 | API 依赖 |
|---|---|---|---|
| /dashboard DashboardPage | A | 总用户、有效订阅、7 日内到期、待处理工单、节点、计划、分组。待处理工单可进入工单列表，7 日内到期仍指向已重定向的旧订阅列表。加载和重试 | GET /admin/stats |
| /catalog/nodes NodesPage | A | 选择、序号、名称及服务器、协议、来源、状态、分组、最后同步、操作。名称/服务器/协议搜索，另筛协议、来源、状态，前端分页与页长，表头只选当页。添加/编辑大 Dialog 含名称、启用、无来源时保留、协议/地址/端口及协议相关凭据、TLS、传输和插件配置。编辑内有克隆、转换测试及诊断。批量启停与保留策略 | GET /admin/catalog，/admin/catalog/nodes 的创建、修改、details 和 test-output |
| /catalog/sources SourcesPage | A | 选择、名称、类型、格式、节点数、状态、同步信息与行操作。关键词/状态筛选。手工粘贴、文件、远程 URL 导入，名称、启用、内容、刷新间隔。预览格式、节点与解析警告，远程同步有差异预览确认。编辑、同步、启停、删除及批量反馈 | /admin/catalog，/preview、/sources 及其 preview-diff、同步子操作 |
| /catalog/groups GroupsPage | A | 选择、名称、来源数、节点数、单独包含、排除、更新时间、操作。名称搜索，前端过滤。创建/编辑分步 Dialog，名称、来源、单独纳入/排除节点、顺序、规则预览与匹配节点。删除含依赖反馈及批量选择 | /admin/catalog，/admin/catalog/groups 及 /preview，兼容关联 /admin/subscriptions |
| /catalog/apps 管理 AppsPage | A | 客户端列表，名称/简介、平台、排序、状态、更新时间、操作，前端分页；新建/编辑大 Dialog，名称、排序、简介、启用、平台及下载/文档链接和排序。启停、删除与下载展示配置 | /admin/apps 及平台子资源；下载开关见系统分发 |
| /delivery/templates EntitlementTemplatesPage，含 ?owner=用户ID | A | 表列名称、资源数、绑定用户数、默认时长、状态、操作。名称和状态前端过滤，无服务端翻页。创建/编辑大 Dialog，名称、管理员备注、日/月/年、流量 GiB、动态组、固定节点、Mbps、允许兑换。行编辑、启停、归档、复制、版本历史。owner 深链接打开专属创建，成功返回订阅授权，仍须绑定 | /admin/subscription-templates 及版本/启停/归档/复制，/admin/catalog，专属创建 /admin/users/:id/template-bindings/private-template |
| /delivery/shares AdminSharesPage | A | 所属用户、关联订阅、备注、状态、访问次数、到期、创建时间、操作。搜索备注/前缀/用户，按状态、用户、订阅筛选及列表分页。禁用/启用、撤销确认；保留旧分享关联 | /admin/shares 及状态子操作，/admin/subscriptions |
| /delivery/redemptions AdminRedemptionsPage | A | 批次、批次详情、兑换记录、操作日志。批次列名称、模板版本、码数、已兑和剩余次数、兑换截止、状态、创建人；名称/状态筛选。详情按尾码显示次数、状态与作废操作；记录按用户 ID 筛选，列批次、尾码、用户、订阅、订阅 ID、时间；日志列动作、操作者、时间和可展开详情，各数据视图按 API 分页。生成 Dialog 含批次名、模板、版本、数量、每码次数、兑换截止、备注；首次结果复制，单码和批次作废需确认 | /admin/redemption-batches、/admin/redemption-codes/:id/revoke、/admin/redemption-records、/admin/redemption-batches/:id/audit，/admin/subscription-templates 和版本 |
| /users UserManagementPage → UsersPage | A | 用户列用户名/邮箱、角色、账户状态、订阅数量和菜单，选择框、搜索用户名/邮箱、状态筛选、服务端分页。入口为邀请用户。行详情、编辑邮箱、设为管理员、启停、重置密码（自填/生成及一次性复制）、移入回收站。批量启停/回收逐行请求与失败反馈。管理员目标/自操作限制见后文 | /admin/users，PATCH/DELETE /admin/users/:id，POST /:id/reset-password |
| /invites UserManagementPage → InvitesPage | A | 注册邀请码列表、遮挡前缀、类型、可用状态、使用次数/上限、到期、创建时间及操作，首次结果复制、停用确认与批量停用，已停用且未使用允许删除；创建/结果 Dialog，单次、多次、批量单次，次数上限、生成数量、可选过期。无按邮箱发邀请流程 | /admin/invites 及停用子操作 |
| /users/recycle-bin UserManagementPage → UsersPage | A | 同用户列表，回收范围与删除时间，搜索及分页。恢复、永久删除确认；永久删除独立于软删除 | /admin/users，/admin/users/:id/restore、/purge |
| /users/:id UserDetailPage，?tab=subscription / ?tab=logs | A | 返回、账号摘要、基本信息/订阅授权/操作日志。基本信息为用户名、邮箱、账户状态的只读资料，列表承担编辑。授权表列模板名、状态、到期、操作；最远到期、聚合节点及复制/重置、节点预览。绑定/更新 Dialog 选模板、期限、追加/替换指定/替换全部、预览变更，替换全部额外确认。暂停、恢复、撤销按授权。节点 Dialog 为名称、协议。日志时间/操作，最近 50 条，无分页 | GET /admin/users/:id，/template-bindings、/subscription/summary、模板清单；授权 PUT、replace、preview 及 /subscription/reset-token |
| /delivery/tickets AdminTicketsPage | A | 状态筛选、服务端分页；标题、等级、状态、最后回复、时间、操作，打开详情 | GET /admin/tickets |
| /delivery/tickets/:id AdminTicketDetailPage | A | 工单标题、等级、状态及对话时间/发件角色/正文；回复、关闭、重开确认，关闭工单的管理员回复可重开 | /admin/tickets/:id 及 /replies、/close、/reopen |
| /operations/notices AdminNoticesPage → NoticesSection | A | 公告列表及创建/编辑，标题、正文、启用、排序与日期配置以表单为准；删除确认 | /admin/notices |
| /kb/manage AdminKbPage | A | 分类管理与文章列表，文章标题、分类、状态、排序、操作，按分类和发布状态筛选、服务端分页。分类名称、排序；文章分类、标题、Markdown 正文、排序、发布开关，编辑/预览、删除确认 | /admin/kb/categories、/admin/kb/articles 及 ID 子资源 |
| /system/registration RegistrationSection | A | 注册模式（关闭、邀请码、邮箱），切换立即保存；邮件域名限制清单、添加和删除确认 | /admin/system/registration、/admin/email-domains |
| /system/mail MailSection + AdminMailSection | A | 邮件服务商、发件人、SMTP 主机/端口/用户名/密码/TLS、Resend Key；凭据状态、保存和测试收件人；邮件模板、群发、到期提醒及手动运行提醒任务 | /admin/system/mail、/admin/mail/test、/admin/mail-templates、/admin/mail-broadcasts、/admin/system/reminders、/admin/jobs/expiry-reminders |
| /system/distribution DomainSettingsSection + ShareSettingsSection | A | 按主/订阅/分享域名管理、添加和移除、主域切换，面板分享开关及应用分发相关设置；保留各配置的保存边界 | /admin/system/domains、/admin/system/domain-restriction、/admin/system/subscription-platforms、/admin/share-settings |
| /system/status HealthSection + StatusSection | A | 健康及运行、存储后端、迁移与就绪状态，刷新/重试。只读状态展示 | /admin/system/status、/admin/operations/status |
| /audit-logs AuditLogsPage | A | 操作与时间、管理员 ID、目标类型/ID、详情；操作、操作者筛选，服务端分页 | GET /admin/audit-logs |
| /account AccountPage | A；U 重定向 /me | 账户资料，已绑定/未绑定邮箱，绑定与修改邮箱验证码流程，修改密码 Dialog（当前/新/确认），全端退出确认、保存与失败重试 | /account/profile、/account/email/bind、/account/email/change 及验证码子路径、/account/password、/account/logout-all |
| /home HomePage | U，仅自身 | 公告横幅、当前订阅与到期、可见流量与未知状态、节点和分组数、到期提醒与快捷入口；历史订阅存在兼容分支 | /user/subscription、/account/subscriptions、/user/nodes、/notices |
| /subscriptions MySubscriptionsPage | U，仅自身 | 统一订阅状态、到期、节点可用提示、遮挡链接、复制、导入/分享/兑换 Dialog、重置与撤销全部分享确认、客户端下载；含旧订阅回退，按各自状态保留格式/导入/分享能力 | /user/subscription、/nodes、/reset-token（后两者为该资源子路径），/account/subscriptions、旧订阅 token/分享相关接口 |
| /nodes MyNodesPage | U，仅自身 | 统一节点表名称、协议；旧数据表另有状态、所属组/订阅，关键词、组/订阅筛选及服务端分页 | /user/subscription/nodes 与 /user/nodes |
| /me MinePage | U，仅自身 | 头像/账户摘要、订阅概览、设置入口及登出；订阅不可用时区分无授权和旧订阅回退 | /account/profile、/user/subscription、/account/subscriptions、/logout |
| /me/subscription SubscriptionInfo | U，仅自身 | 订阅状态、到期、节点与链接，复制、导入、重置确认，旧订阅详情兼容 | 同 /subscriptions |
| /me/security AccountPage embedded | U，仅自身 | 安全设置、邮箱绑定/变更与验证码、密码修改和反馈 | 同 /account |
| /me/notifications NotificationSettings | U，仅自身 | 到期提醒开关，浏览器本地保存，首页到期前 7 天提示 | localStorage |
| /me/display DisplaySettings | U，仅自身 | 移动底栏显示风格和浏览器偏好 | MobileBarOptions、localStorage |
| /me/redemption RedemptionSettings + PersonalRedemptions | U，仅自身、受功能门控 | 输入兑换码、预览、确认、结果及个人兑换记录；保留失败原因与重试 | GET/POST /me/redemptions、POST /me/redemptions/preview |
| /me/support SupportSettings | U | 公告、知识库、工单、下载启用时的下载入口 | 下载展示配置 |
| /notices NoticesPage | U | 公告标题、正文、时间；关键词查询和服务端分页 | GET /notices |
| /kb KbPage | U | 发布文章按分类展示，关键词远程搜索，进入文章；索引独立加载及错误状态 | GET /kb、/kb/search |
| /kb/:id KbArticlePage | U | 标题、分类、Markdown 正文、返回与加载失败 | GET /kb/articles/:id，仅发布内容 |
| /tickets TicketsPage | U，仅自身 | 工单卡片标题、等级、状态、回复时间；创建弹窗含标题、等级、正文；打开详情 | GET/POST /tickets |
| /tickets/:id TicketDetailPage | U，仅自身 | 工单状态/等级和对话，追加回复及关闭确认，已关闭限制操作 | /tickets/:id 及 /replies、/close |
| /apps 用户 AppsPage | A/U，受下载开关 | 客户端名称、介绍及平台下载/文档入口；登录用户可读 | GET /apps、下载展示配置 |
| /setup SetupPage | G，仅未初始化 | 管理员用户名、密码、初始化密钥，提交及错误处理，已初始化转登录 | GET /bootstrap，POST /setup |
| /login LoginPage | G，已初始化 | 标为用户名的登录标识实际支持邮箱，密码、登录及按注册模式展示入口；已登录按角色或分享返回 | /bootstrap、/login、公开注册策略 |
| /register RegisterPage | G，已初始化，依注册模式 | 用户名、邮箱、密码及确认、验证码和邀请码按模式显示，发送验证码、提交与字段错误处理。关闭时拒绝注册 | /register/config、/register/send-code、POST /register |
| /invite/:token InvitePage | G，依凭据/状态 | 跳转到带邀请码参数的注册页，保留旧邀请深链接 | 邀请/注册公开端点 |
| /s/:token SharePage | G，依凭据；部分旧分享需登录 | 公共分享/订阅入口。来源状态、可用客户端、复制/导入及不可用提示；登录回跳留存，客户端下载与页面路径共用 | /s/:token/:client?，分享公开元数据及下载门控 |

### 兼容路由与后端边界

| 路径 | 行为与权限 |
|---|---|
| / | 分享返回优先，否则 A → /dashboard，U → /home，访客按初始化状态去 /setup 或 /login |
| /delivery/conversions | A → /delivery/templates，U → /subscriptions |
| /delivery/subscriptions/* | A → /users，U → /subscriptions。旧列表和详情组件仍在树中 |
| /delivery/migration | A → /users，U → /subscriptions |
| /plans | A → /delivery/templates，U → /home |
| /system、/system/:section | A。默认 registration，兼容 section/tab/hash；admin-mail → mail，share/domain → distribution，app-downloads → /catalog/apps，notices → /operations/notices，templates → /delivery/templates；未知项回 registration |
| /entitlement、/entitlements | U → /subscriptions，A → /dashboard |
| /me/:section | U。已列有效子页，subscriptions → subscription 且保留查询串和 hash，未知项 → /home |
| * | 按角色回首页或登录/初始化；/audit-logs 对普通用户例外回登录，经登录路由再回角色首页；/kb/manage 对普通用户先去 /dashboard 再跟随其重定向 |

管理页一般将普通用户送至 /subscriptions，用户专属页把管理员送至 /dashboard，访客先经初始化/登录判断。InvitePage 直接跳到 /register?inviteCode=…，邀请码有效性在注册流程验证，无独立表单。/s/:token 跳过 SPA 的会话加载阻塞，但 Worker 仍校验公开访问类型、有效凭据和域名；/s/:token/:client? 及 /sub 族属于内容分发/兼容端点，无额外管理页面。没有独立节点详情、模板详情或编辑、公开找回密码页面。目录中存在未挂载的 LegacySubscriptionsPage、MigrationPage、旧转换模板编辑组件，文件存在不代表现行 UI 入口

权限证据为 worker/app.ts 的 /api/admin/* requireAuth → requireAdmin → auditAdminMutation，以及各资源路由。账户、自助订阅、节点、工单、应用、知识库走登录态或资源本身的访问校验；工单校验所有者，个人订阅以 principal 为准，知识库用户端只读发布内容。写入受 originGuard、资源校验和冲突保护。管理员用户操作遵守最后一名管理员保护，管理员密码只能自助修改，软删除与永久清除各有保护。页面按钮状态不能替代后端权限

## 公共组件与外壳

| 职责 | 实现与复用 |
|---|---|
| 大小不同的弹窗与类似抽屉的编辑 | src/ui/Dialog.tsx 统一原生 dialog 及 S/M/L 等变体，已有忙碌状态、脏表单、Escape、返回焦点和敏感内容控制。节点、来源、分组、模板、知识库、认证后安全设置、兑换码及工单共用。来源与复杂模板使用大 Dialog，无单独公共 Drawer 路由 |
| 风险确认 | ConfirmDialog 复用 Dialog，用于回收、撤销授权、链接重置、节点/来源操作、工单和兑换；各业务负责对象、影响、并发与确认动作 |
| 表格与工具栏 | DataTable 提供列、行键、对齐、断点隐藏、空状态和滚动；资源 ResourceCard/ResourceRowActions 复用选择、工具栏、popover 和 footer；用户列表有自己的表格与分页，邀请码及若干用户页另有本地布局。FilterBar、SearchInput、FilterChip、BatchToolbar、Pagination 服务目录、运营和其他列表，各页选择和翻页范围由数据源决定 |
| 页面标题、分区与标签 | PageFrame、PageHeader、PageHero、DataHeader、SectionTabs；PageHeader 的槽位机制与 AppShell/WorkspaceTopbar 共用，详情另用链接标签。迁移时复用已渲染的唯一标题，页级标签治理需兼顾导航选中状态 |
| 表单控件 | Button、Controls 的 Input/Textarea/Checkbox/FormSelect、FormField、Select、SegmentedControl、Switch、PasswordInput；账户、登录、模板、系统、目录与工单复用，仍有手写 label/fieldset |
| 状态反馈与任务卡 | StatusBadge、StatusPill、StatusMessage、InlineMessage、EmptyState、GateEmptyState、LoadingState、ErrorState、Toast、CopyButton；StatCard、PlanCard、QuickEntryCard、NoticeCarousel 用于摘要和个人首页等。客户端导入、绑定表单、协议字段由业务组件保管 |

保护边界由 src/app/AppShell.tsx、navigation.ts、admin-layout.tsx、mobile-bar.ts、MobileBarOptions.tsx 和 theme 定义。桌面侧栏含 /logo.png 的 brand-mark、SubPanel 字样、Lucide 图标、角色菜单和折叠；管理员另有可切换的顶部导航和账户菜单。管理员移动底栏为概览、节点、订阅、用户，运营和系统通过账户菜单；用户桌面/移动为首页、订阅、节点、我的。保留账号菜单、主题/显隐、菜单层级和键盘行为、激活规则、移动栏尺寸/样式/安全区与偏好存储。认证使用 AuthLayout，公共分享使用自身页面布局

主样式从 src/main.tsx 全局导入。app.css 管 .app-layout、.sidebar、.workspace、.workspace-content、.dock 与安全区，admin-navigation.css 管管理导航布局、菜单与规则，user-shell.css、pages-user-d.css 有用户布局规则，tokens.css 和全局 controls/components 仍被多个区域共享。侧栏 Logo 基础为 28px，顶部布局另有覆盖。内容 token 放内容槽位，portal/dialog 独立限定作用域。不要修改 :root 共用品牌色、全局 table/button、侧栏/底栏 DOM 或其断点来实现内容设计。管理模块标签位于上部内容导航，处理详情重复标签时应保留主导航的选中语义

## 第 7 节逐页映射

| 规范与实际页 | 保留 | 迁移 | 待确认 |
|---|---|---|---|
| 概览 /dashboard | 现有指标与入口 | 概览骨架、紧凑摘要 | 7 日内到期入口最终进入用户列表，专门筛选的落点待确认；无历史趋势或节点在线率支撑 |
| 7.1 节点 /catalog/nodes | 真列、导入入口、启停/保留、转换测试与诊断 | 列表工具栏，现有编辑 Dialog 内容 | 分组筛选目前只有列，单独节点详情路由为新入口，是否需要另定 |
| 7.1 来源 /catalog/sources | 手工/文件/远程、差异预览、失败反馈 | 列表及导入表单 | 无 |
| 7.1 分组 /catalog/groups | 动态规则、纳入/排除、顺序、关联限制 | 列表、分步编辑 | 无 |
| 7.2 权益模板 /delivery/templates | 状态、版本、使用数、专属归属、复制/归档与配置 | 列表及独立编辑视觉骨架，兼容 owner 查询串 | 编辑是独立路由还是同路径的独立内容视图；当前为 Dialog，历史也是 Dialog |
| 7.2 分享 /delivery/shares | 旧关联、过滤、撤销/禁用 | 列表、风险确认 | 无 |
| 7.3 用户 /users | 角色、账户状态、订阅数、权限及邀请入口 | 列表与批量工具栏 | 无管理员直接创建用户入口，订阅计数也不可冒充有效授权数 |
| 7.3 用户详情 /users/:id | 账户只读信息、授权和日志字段、兼容旧分支 | 移除重复列表标签、对象级动作归位、近距离反馈 | 有效授权计数来源、同名模板区分、是否从列表复用账户编辑；日志现有 DTO 没有操作者/结果 |
| 7.3 邀请 /invites | 邀请码及有效范围、复制/停用、批次 | 列表和生成对话框 | 规范的邀请对象在现有注册邀请码中无对应字段 |
| 7.3 回收站 /users/recycle-bin | 恢复、永久删除、删除时间、分页 | 列表和风险确认 | 无 |
| 7.4 兑换 /delivery/redemptions | 批次、固定版本、两种期限、一次性完整码、撤销及记录 | 批次和各下钻视图 | 视图是否额外展示已固定的授权时长；不增导出接口 |
| 7.5 设置 /system/registration | 注册模式与邮箱域规则 | 设置区块 | 无 |
| 7.5 设置 /system/mail | 凭证、测试、邮件模板、群发、到期提醒 | 独立配置区块及必要说明 | 无 |
| 7.5 设置 /system/distribution | 域名添加、验证、主域、启用、备注、移除、访问限制，客户端订阅平台、分享配置 | 分组及保存边界 | 无 |
| 7.5 运行 /system/status 与 /audit-logs | 运行只读与系统审计分页 | 状态区块及独立审计表 | 无 |
| 7.6 /home、/subscriptions、/nodes | 自助及旧数据兼容、节点和链接门控 | 概览、订阅详情与节点列表 | 无 |
| 7.6 /me、/me/subscription、/me/security、/account | 个人订阅、账户安全、邮箱验证及全端退出 | 详情与设置表单 | 无 |
| 7.6 /me/notifications、/me/display、/me/redemption、/me/support | 本地偏好、真实兑换与帮助入口 | 设置和兑换内容 | 显示设置继续调用现有外壳偏好 |
| 7.6 /setup、/login、/register 与邀请跳转 | 模式、验证码、登录回跳、初始化保护 | 认证内容 | 公开找回密码无现有流程；不进入本次迁移 |
| 额外运营 /delivery/tickets 与详情、/operations/notices | 状态、工单操作和公告发布 | 列表、对话、公告编辑 | 无 |
| 额外自助 /tickets 与详情、/notices | 自身工单、发布公告 | 列表、对话和反馈 | 无 |
| 额外知识库 /kb/manage、/kb、/kb/:id | 发布权限、分类、Markdown 和正文 | 管理列表/编辑、用户索引/文档 | 无 |
| 客户端 /catalog/apps、/apps | 下载配置、平台选择和可用性 | 管理表与用户下载目录 | 无 |
| 公开 /s/:token，其他兼容路径 | 公开凭据语义、格式、兼容跳转 | 分享内容区采用现有骨架 | 重定向路由无可迁移页面 |

## 业务差异与需确认事项

1. §6.1 更新。UserSubscriptionPlan.BindingEditor 行按钮打开选定模板的编辑器，默认提交 assign 并标为「更新现有绑定」。先预览，后按 expectedRevision、requestId 提交；另可换模板、替换指定、替换全部。bindings.ts 的 assign 默认从本次开始时间重新算到期（规则可为模板默认、相对、自定绝对或永久），可将同模板暂停状态变为 active，现存非撤销永久授权继续永久。单独的后端 renew 走 max(现在, 旧到期) 的计算，目前该按钮不调用。建议按现有动作命名「更新绑定」并保留效果预览，避免误称续期。暂停/恢复/撤销只作用于目标用户的目标模板，替换全部是单独高影响动作
2. §6.2 有效授权数。aggregate.ts 要求账户和统一访问可用、绑定 active、模板启用、关联旧计划未禁用、专属归属匹配、已开始且未到期。摘要 DTO 无有效数；绑定列表状态与客户端时间判断缺少聚合的全部条件。要展示权威计数，应先确认可否扩展后端显式字段，不能以列表长度或节点数代替。额度不可验证或策略冲突时有效授权仍可能无可交付节点
3. §6.2 聚合及到期。聚合取动态组和固定节点的有效配置，排除不可用节点，按节点 ID 和连接身份去重，部分原始 URI 还参与身份。非空额度和旧流量限制授权因无权威计量不贡献节点，冲突限速/旧限速或设备策略也可能使节点为空。当前预览显示 summary.nodes 的名称和协议，是聚合节点列表；另有按客户端渲染的 /preview API，客户端实际输出可不同。expiresAt 取当前有效授权最晚有限时间；任一永久则 permanent=true、到期为 null；全无或仅过期同为 null，管理摘要也没有总体 status/lastExpiredAt。不要推断所有节点可用至最晚日期，待定的是无授权/过期摘要是否需要正式补字段
4. §6.2 同名模板、链接。表和模板选择目前以名称为主，实际 API 返回 templateId、scope、时间与修订，列表以模板 ID 作键，同一用户/模板同一绑定槽位。可用稳定真实模板标识和共享/专属信息，待确认给管理员展示的最短可辨识字段。当前管理 UI 只显示复制按钮，不渲染完整链接文本；用户统一订阅已有遮挡。若新增管理链接行，默认遮挡并原值复制。resetUserToken 原子替换散列并增修订，旧 token 立即失效，审计写空详情；保留提示，勿将真实链接加入日志、遥测、错误和截图
5. §7.2 版本。readBindings 查询模板最新版本，配置资源、限额和策略随版本变化，动态组成员也可变化；绑定开始/到期为单独持久化字段，改默认期限不会回写。停用/归档即时影响现有交付资格。旧版本历史和旧订阅发放路径存在，不应把其快照语义套在当前统一授权。专属模板仅属目标用户且不允许兑换，创建成功不等同绑定
6. §7.4 两种期限。redeemDeadline 是码的可兑截止与服务端判断；duration_json 从生成批次时所选版本快照提取，兑换时按该相对时长计算或叠加已有期限并保留永久，而当前模板仍须启用、允许兑换，最终统一绑定交付读最新版。固定版本用于批次与时长，不能承诺资源永久固定。界面保留仅首次返回完整码、每账户单码一次、批量上限及作废范围。完整码可复制，清单仅尾码，不凭空增导出
7. §8 文案。可删重复标题、空泛操作说明和成功套话。保留注册关闭/邀请码/邮箱验证及失败恢复、密码和邮件凭据规则、SMTP 保存和测试边界、域名验证与主域影响、导入警告及来源保留策略、无计量或部分客户端限速、批量选区、链接立即失效、停用/撤销/永久删除影响、码仅首次可见、两种期限及时间单位。用户级日志只有时间和动作，系统日志才有管理员及目标，授权/账户/模板/分享状态各自独立
8. §5 页面形态。节点详情和模板编辑目前使用 Dialog，模板详情拆成编辑与历史；筛选状态有本地和 URL 两种来源，分页有前端与服务端两类，选择作用域也各异。详情返回列表恢复状态和专属编辑离开保护可作为视觉迁移设计，需维持旧地址与参数。现有启停不是健康检查；不补虚构趋势、计划、用户创建、节点在线率或找回密码

## 实施顺序

- Phase 1 建立内容区域 token、标题槽、表格/表单/状态复用方式；对比侧栏、顶部管理员导航、两种移动底栏与 Logo 的基线，验证主题、菜单和安全区
- Phase 2 依次做用户详情/订阅授权、用户列表、模板编辑三个基准页；用真实授权分支、批量与回收、版本、专属创建后另绑跑通，再冻结通用接口
- Phase 3 按节点及来源分组 → 订阅/分享 → 用户邀请与回收 → 兑换及运营 → 概览和设置 → 个人中心、认证与公开分享迁移；逐模块附功能对照、前后截图与回归结果
- Phase 4 确认无引用后清理样式和组件，复跑类型、lint、构建、单测与端到端。回归登录/兑换/分发/模板变动及各权限，覆盖 1440、1280、1024、768、390 和响应式壳状态、键盘、焦点、对比度、溢出和触控

## 本地基线

截图位于 /data/tmp/sub-uiux2-phase0/screenshots/。以「下列名称-1440.png」「下列名称-390.png」成对存放，视口为 1440×1000 与 390×844，共 24 张，约 1 MB。名称为 user-authorization、users、template-editor、templates、dashboard、nodes、registration-settings、my-subscriptions、me、setup、login、register。浏览器使用 Chromium。授权截图中两条同名授权分别为有限和永久，聚合为一个节点，移动端可见两层标签；模板编辑截图记录现行大 Dialog。图片使用纯本地合成业务数据，管理员授权页只展示复制控件，普通用户订阅页遮挡链接

从仓根手动启动 Vite development，绑定 127.0.0.1:4173，设置 SUBPANEL_EXTERNAL_SERVER=1，避免 Playwright 从 development/ 启动时模块解析失败。重置本工作树的本地 D1 并重新执行 0001–0028，核对七个本地就绪标志。向本地 KV 注入独立加密材料，使用临时 64 字符初始化密钥。截图产物直接写入 /data，随后执行 git checkout -- development/screenshots/，仓内截图无差异。截图期间未连接生产或部署

| 命令或套件 | 结果 |
|---|---|
| 初始工作树 npm run check | 预装 Wrangler 4.114.0 判定类型声明过期，命令停止 |
| 初始工作树 npm run build | 通过，提示大 chunk |
| 初始工作树 Vitest 默认配置 | 预装依赖缺 @cloudflare/vitest-plugin，未启动 |
| 锁定依赖 npm run check | 通过，Wrangler 4.166.0 类型声明校验与 TypeScript 通过，Oxlint 输出 66 条警告 |
| 锁定依赖 npm run build | 通过，Worker 和客户端均产出。客户端主 JS 687.72 KB，gzip 196.61 KB；有 Node 弃用、外部输出目录和大 chunk 警告。输出 /data/tmp/sub-uiux2-phase0/build-locked/，占用约 4.3 MB |
| 锁定依赖 npm test，development/vitest.config.ts | Worker 全量 68 文件通过，550 通过、1 跳过。跳过项是需 VITE_SUB_V2_P4_BENCH=1 的兑换批次基准 |
| vitest.controls.config.ts | 8 文件、36 测试通过 |
| vitest-pages-node.config.ts | 14 文件通过、1 文件失败；234 通过、1 失败。navigation-structure 对订阅管理标签的路径集合预期与实际不同 |
| vitest-subscriptions-node.config.ts | 1 文件通过、2 文件失败；8 通过、5 失败。旧订阅创建/过期相关三例返回 500，分享范围一例失败，另有下述模板断言 |
| vitest.templates.config.ts | 4 文件通过、1 文件失败；92 通过、1 失败，templates-lifecycle 缺预期 HTTPS rule-providers URL。该用例也由上项选中，结果不可重复合计 |

npm ci 在 /data 下隔离安装锁定依赖，使用同一基底的源码快照复测，未替换工作树的依赖符号链接。测试与构建日志在 /data/tmp/sub-uiux2-phase0/。浏览器范围为真实本地 API 数据装载和截图，未运行全套 Playwright 端到端测试，也未把截图视为交互、无障碍或所有断点均通过的证明

SUB_UIUX2_PHASE0_DONE
