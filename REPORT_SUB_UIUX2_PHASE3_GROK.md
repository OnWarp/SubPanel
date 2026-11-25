# SubPanel UI/UX 2.0 · Phase 3 Grok 线交付报告

工作树 `/data/workspace/subpanel-uiux2-phase3-grok`，分支 `task/sub-uiux2-phase3-grok`，基底 `task/sub-uiux2-phase2` @ `b5a697bbcebbac5bd78bde275cd585e80bc067ad`。范围只限概览、系统设置、个人中心与认证、运营与知识库、公开分享。未改节点管理、订阅管理、管理员兑换。未改权限、路由表、数据库语义、侧栏、底栏、Logo、品牌色。未建遮罩链接或链接行组件。未部署，未合并 main，未碰生产数据。冻结组件未改实现，只用已有接口：`PageContainer`、`PageHeader`、`SectionTabs`、`ModuleTabs`、`DetailTabs`、`DetailList`、`StatGroup`、`DataTable`、`FilterBar`、`Pagination`、`RowActions`、`FormField`、`Dialog`、`ConfirmDialog`、`Skeleton`，以及 Phase 2 的 `DataTable.summary`、`Dialog` 的 `appearance="content"`。`contentOwnsModuleTabs` 的函数签名未改，只扩大了路径集合

## 改动清单

- `src/app/navigation.ts` 的 `contentModulePaths` 增加系统设置五页和运营三个列表：`/system/registration`、`/system/mail`、`/system/distribution`、`/system/status`、`/audit-logs`、`/delivery/tickets`、`/operations/notices`、`/kb/manage`。这些列表由页面自己渲染 `ModuleTabs`，外壳不再重复。详情页不在这个集合里
- `src/app/AppShell.tsx` 对 `/delivery/tickets/:id` 不再输出外壳 `SectionTabs`。工单详情只保留返回链接，避免和列表页签叠在一起。`/users/:id` 的既有例外未改
- `src/features/dashboard/DashboardPage.tsx` 改用 `PageContainer`（list）和 `StatGroup`。七个指标都来自 `GET /api/admin/stats`，顺序是待处理工单、7 日内到期、总用户、有效订阅、节点、分组、计划。没有趋势图，没有在线率
- `src/features/accounts/UsersPage.tsx` 在活跃列表读取 `expiry=soon`。这是概览「7 日内到期」的落点，只读筛选，不改用户写接口。清除按钮文案是「7 日内到期」，空态是「暂无 7 日内到期的用户」，摘要是「共 N 位用户，7 日内到期」
- `worker/accounts/d1-repository.ts` 的 `expirySoon` 与概览到期计数使用同一窗口：启用用户、有效绑定、模板启用、访问启用、计划未停用、已开始且未过期；任一永久绑定使该用户不计入；`expires_at` 非空且不晚于现在加 7 日。`worker/accounts/admin-routes.ts` 在 KV 回退路径遇到该参数时返回空列表，避免把无法计算的到期显示成全量用户。没有改表结构
- `src/features/system/SystemPage.tsx` 用 `PageContainer`（list）、`PageHeader`「系统设置」和页内 `ModuleTabs`。注册、邮件、分发、运行按现有主题分区，区块内是标题、字段和保存。`width` 保持 `list`，因为顶栏铺满规格要量列表内容区，并继续找到「邮箱域名白名单」和「系统设置导航」。加载失败走 `ErrorState`，不把空表单交给保存
- `src/features/system/AdminMailSection.tsx` 只有邮件模板读取成功后才渲染模板、群发和到期提醒。恢复默认放在编辑区底部，确认文案是「自定义模板及当前编辑将被清除」。密码和 API Key 仍是密码框，留空表示不修改
- `src/features/system/ShareSettingsSection.tsx` 分享设置仍是一次提交。读取失败时不渲染字段和保存按钮。总开关放在表单底部的危险区
- `src/features/system/DomainSettingsSection.tsx` 域名删除留在行内危险区。备注和平台展示仍各自保存
- `src/features/admin/AuditLogsPage.tsx` 改接列表容器、设置页签、`FilterBar` 和 `DataTable` 摘要。去掉重复的页脚计数
- `src/features/user/HomePage.tsx`、`MyNodesPage.tsx`、`MinePage.tsx`、`src/features/delivery/MySubscriptionsPage.tsx`、`src/features/redemption/PersonalRedemptions.tsx`、`src/features/accounts/AccountPage.tsx` 换上内容区容器。首页仍用 `StatCard`。个人中心先放当前订阅、遮挡后的复制链接、兑换入口和账户信息。显示设置仍走现有外壳偏好
- `src/features/accounts/LoginPage.tsx`、`RegisterPage.tsx`、`SetupPage.tsx`、`EmailBindChangeForm.tsx` 只给表单加上内容区作用域。认证外壳、字段、校验和错误提示未改。邀请页仍是跳到 `/register?inviteCode=`，本线没有改那个文件。没有补公开找回密码
- 工单、公告、知识库列表改接 `PageContainer`（list）、`PageHeader` 和表格或既有卡片。管理员工单详情和用户工单详情用 `width="detail"`，返回文案都是「返回工单」。文章详情返回「返回知识库」。对话和正文只展示已有字段
- `src/features/shares/SharePage.tsx` 在现有公开骨架上加内容区作用域，分组、到期、节点改用 `DetailList`。凭据语义、阶段、登录回跳、客户端下载路径未改
- `src/styles/content-ui.css` 增加危险区上边线和系统表单的水平内边距归零。未改冻结组件的样式文件
- `development/tests/ui/navigation-structure.test.ts` 让页头模拟渲染 `leading`，概览断言七个指标和五个真实链接，工单详情断言侧栏高亮且列表页签为空、正文含「返回工单」
- `development/tests/browser/topbar-fill.spec.ts` 把概览和系统设置的测量目标改成 `content-page[data-width="list"]`，系统设置继续要求「系统设置导航」可见

未纳入提交：工作树根的 `SubPanel-UIUX-2.0.md` 仍是未跟踪输入。`.dev.vars`、`.wrangler`、`dist` 和截图目录不入库

## 功能对照

### 概览 `/dashboard`

| 能力 | 对照 |
|---|---|
| 数据 | 七个数都来自管理统计接口：用户、有效订阅、7 日内到期、待处理工单、计划、分组、节点。本地种子是总用户 2、待处理工单 1，其余为 0 |
| 顺序 | 待处理工单和 7 日内到期排在前面，其余核心指标同一行横向排列，窄屏再折行 |
| 可点击 | 待处理工单进入 `/delivery/tickets?status=open`；7 日内到期进入 `/users?expiry=soon`；总用户进入 `/users`；节点进入 `/catalog/nodes`；分组进入 `/catalog/groups`。链接包在数字上。有效订阅没有独立的有效订阅筛选，计划旧地址会转到模板，这两项保持纯数字 |
| 加载与失败 | 加载中数字是骨架，链接仍在。失败显示「加载概览失败」和重试，不显示可当作 0 保存的空表 |
| 未画的东西 | 没有历史序列，不画趋势。没有健康探测接口，不画在线率 |

本地改后探针：五个可点击指标各 1 个链接，有效订阅和计划为 0。点击待处理工单落到待回复筛选，点击 7 日内到期落到用户列表并出现清除按钮，清除后回到普通列表。改前同一统计下 `expiry=soon` 被旧接口忽略，返回 2 位用户；改后返回 0

### 系统设置

| 页面 | 对照 |
|---|---|
| 注册 `/system/registration` | 注册模式仍是开放、邀请、关闭，用现有组合框，切换后立即保存。域名白名单仍是同一区块里的增删，空名单不限制域名。删除放在危险区。本地把模式切到关闭再切回邀请，并完成 `example.com` 的添加和删除 |
| 邮件 `/system/mail` | SMTP 设置一次保存。密码和 API Key 默认遮挡，本次输入长度为 0。模板、群发、到期提醒只在模板读取成功后出现。提醒天数单独保存，群发单独发送。恢复默认在编辑区底部，并说明会清除自定义模板和当前编辑。模板接口被拦截时只见「加载失败」和重试，群发与提醒按钮不出现 |
| 分发 `/system/distribution` | 分享设置一次保存。读取失败时字段和保存按钮都不出现。总开关在表单底部，说明它控制普通用户的分享权限，关闭期间分享链接暂停访问。域名限制和平台展示保持各自的保存 |
| 运行 `/system/status` | 标题仍是「服务健康与定时任务」，展示已有就绪标志和迁移文件名。不另造在线率 |
| 审计 `/audit-logs` | 设置页签、原筛选、操作 / 管理员 / 目标 / 详情四列保留。摘要和分页只出现一次 |

普通开关不再复述字面意思。开放注册、分享权限、恢复默认、域名删除保留限制和影响说明。新增说明的末句都不以句号结尾。两处原有提示中间仍有分句：「失败可重试。自动定时触发待 cron 修复」和「管理员仍可分享。关闭期间所有分享链接暂停访问」

### 个人中心与认证

| 页面 | 对照 |
|---|---|
| 首页 `/home` | 内容区容器，标题「首页」，主操作「打开订阅」仍去 `/subscriptions`。订阅状态、节点入口、公告轮播和原有类名保留。仍用 `StatCard`，以免用户页样式断言失效 |
| 订阅 `/subscriptions` | 标题「我的订阅」。分享、重置订阅链接、导入和到期时间保留。链接展示把末段换成遮挡符，复制按钮仍拿到真实地址。弹窗使用内容区外观 |
| 节点 `/nodes` | 标题「我的节点」。筛选、表格和页脚逻辑未改 |
| 个人中心 `/me` | 先是当前订阅或「暂无订阅」，再是遮挡后的复制链接和「兑换订阅」，然后是「账户信息」。设置菜单不把兑换再列成后台入口。本地页显示未开通、到期为「—」、遮挡链接、复制链接、兑换订阅，以及安全、通知、显示、帮助 |
| `/me` 子页 | 安全、通知、显示、帮助、订阅详情、兑换各自保留原字段。子页页头带回「个人中心」。显示设置继续调用外壳偏好。兑换页是用户自己的兑换，不是管理员兑换 |
| `/account` | 独立打开时用表单宽度容器和标题「个人中心」。密码、邮箱、会话与安全仍在。修改密码和退出全部设备保留，确认框使用内容区外观。嵌在「我的」里时不重复套页头 |
| 安装、登录、注册 | 外壳不变。关闭注册仍是「当前未开放注册，请联系管理员」。用户名和密码长度提示保留。错误登录仍提示「用户名或密码错误」。没有削弱校验 |
| `/invite/:token` | 仍跳到注册页并带上邀请码查询。截图前邀请码输入已遮挡，画面和报告都不含邀请码。探针只记录落在 `/register` 且查询存在 |

### 运营与知识库

| 页面 | 对照 |
|---|---|
| 管理工单 `/delivery/tickets` | 运营页签、状态筛选、标题 / 等级 / 状态 / 最后回复 / 时间。空态区分「暂无工单」和「暂无匹配工单」。行操作仍是「查看工单」。本地有一条「无法导入」，等级普通，状态待回复，摘要「共 1 条」 |
| 工单详情 | 管理端和用户端都是详情宽度，页头行内，返回文案「返回工单」，没有模块页签。回复字段仍是「回复用户」，提交「发送回复」。本地管理员回复后，用户详情能看到同一条回复 |
| 公告管理 `/operations/notices` | 运营页签加原有公告编辑。不新造状态 |
| 用户公告 `/notices` | 仍是卡片，外面套列表容器 |
| 用户工单 `/tickets` | 列表容器、页头和表格。详情返回 `/tickets` |
| 知识库管理 `/kb/manage` | 运营页签、筛选和文章表。分类与文章字段未删 |
| 知识库 `/kb` | 仍按分类分组 |
| 文章 `/kb/:id` | 详情容器，返回「返回知识库」，正文用已有字段。本地文章是已发布的「如何导入订阅」 |

### 公开分享 `/s/:token`

凭据格式、公开拉取和未知令牌的 JSON 404 保持工人原行为。短令牌直接打开的截图是兼容 JSON，正文含 `SUBSCRIPTION_NOT_FOUND`。43 位未知令牌在客户端导航下进入访问验证，不显示令牌本身，按钮是「登录后查看」。点击后只检查回跳键以前缀 `/s/` 开头，不读取值。本地目录没有节点，没有创建真实分享，因此没有拍到带密码的真实凭据页。客户端下载和页面路径仍走原来的导入组件

## 前后截图

对比图在本机，不入库。改前目录 `/data/tmp/sub-uiux2-phase3-grok/before/`，75 张，对应基底 `b5a697bbc`、端口 4174。改后目录 `/data/tmp/sub-uiux2-phase3-grok/after/`，85 张，对应当前功能提交、端口 4173。两处都是 0 张因疑似敏感串跳过，横向溢出列表为空

页面图覆盖 1440 和 390：`setup`、`login`、`login-error`（仅 1440）、`register`、`register-closed`、`invite`、`dashboard`、`users`、`users-expiry`、`registration`、`mail`、`distribution`、`status`、`audit`、`admin-tickets`、`admin-tickets-open`、`admin-ticket`、`admin-notices`、`user-tickets`、`user-ticket`、`user-notices`、`kb-manage`、`kb`、`kb-article`、`home`、`subscriptions`、`nodes`、`me`、`me-security`、`me-notifications`、`me-display`、`me-support`、`me-subscription`、`me-redemption`、`share-invalid`、`share-locked`。另有 `share-direct-1440`，以及外壳 `shell-1280`、`shell-1024`、`shell-768`（视口截图，页面为概览）

交互图只在改后目录，都是 1440：

- `interact-tickets-open-1440.png`：从概览进入待回复工单
- `interact-expiry-1440.png` 与 `interact-expiry-cleared-1440.png`：7 日内到期筛选及清除
- `interact-admin-reply-1440.png` 与 `interact-user-reply-1440.png`：管理员回复后用户可见
- `interact-domain-added-1440.png`：域名白名单写入 `example.com`，随后已删除
- `interact-registration-closed-1440.png`：注册模式切到关闭，随后已切回邀请
- `interact-mail-load-failed-1440.png`：模板加载失败，群发和提醒不出现
- `interact-share-load-failed-1440.png`：分享设置加载失败，保存不出现
- `interact-share-login-return-1440.png`：访问验证页点击登录后查看

`development/screenshots/` 没有被改脏，不需要还原。截图脚本在入库前遮挡了密码、邀请码和密钥类输入。状态页上的迁移文件名是仓库里的文件名，不含密钥

## 测试结果

| 命令 | 结果 |
|---|---|
| npm run check | 通过。本地 `.dev.vars` 在场时 Wrangler 类型检查会把变量收进类型比较，因此检查前暂移该文件，结束后按原权限复位，没有重新生成 `worker-configuration.d.ts`。Oxlint 64 条警告、0 错误 |
| npm run build | 通过。客户端主 JS 691.10 KB，gzip 198.66 KB。客户端 CSS 165.32 KB，gzip 26.77 KB。既有大 chunk 提示仍在。本次构建没有把 `.dev.vars` 拷进 `dist` |
| npm test | 68 个文件通过，552 通过、1 跳过。跳过项仍是需要开关的兑换批次基准。同一命令在 `.dev.vars` 留在工作树时会多失败 2 条：目录导入在加密材料被测例删掉后仍读到进程环境里的材料，以及 D1 基础测例期望两边密钥都缺席时写入 KV。移开该文件后这两条通过，不是本线产品回归 |
| vitest-pages-node | 15 个文件，234 通过、1 失败。失败仍是订阅管理导航期望含 `/delivery/conversions` |
| vitest-subscriptions-node | 8 通过、5 失败。仍是空池订阅、精确过期停用、公开过期拒绝、既有分享存储，以及模板 HTTPS rule-providers |
| vitest.templates | 92 通过、1 失败。仍是同一条 HTTPS rule-providers |
| vitest.controls | 8 个文件，36 通过 |

浏览器回归没有走 Playwright 的 webServer。仓根 `vite --host 127.0.0.1 --port 4173` 和基底工作树的 4174 分别提供页面。两套本地 D1 都清空后重放迁移，并写入 7 个就绪标志。交互覆盖概览跳转、到期筛选、工单回复、域名增删、注册模式、邮件和分享的加载失败，以及分享登录回跳

## 未解决

- pages-node 1 条、subscriptions-node 5 条、templates 1 条失败是基底既有项，本线没有新增失败
- 390 宽模板编辑弹窗与底栏垂直交叠约 35px、旧移动底栏脚本入口超时、一处旧首页空状态文案断言，都是基底既有项，本线未追
- 未知分享令牌的整页导航仍由工人返回 JSON 404，React 访问验证只在真实分享令牌或客户端导航下出现。本地没有节点，没有创建真实分享
- 工单表把标题和用户名排在同一标题单元格，这是现有表格的拼接，本线未改 `DataTable`
- 主机名 hwsg 无法解析。本机没有 instabox 密钥，没有签发 SFTP 凭据，也没有把包传到 `/root/xfer`。报告提交即交付，没有用 base64 回传
- 功能提交 `1a8a22f034ac00ac99bd5e1973de03cfa54d6180`。本报告是它的直接子提交，推送后 `origin/task/sub-uiux2-phase3-grok` 的顶端即交付 HEAD

SUB_UIUX2_PHASE3_GROK_DONE
