# SubPanel 全站 UI 文案精简

## 开工审计

基底 `05b50d8d`，与本地 `origin/main` 一致。按路由、页内标签、抽屉和共用界面核对。已有短提示保留。状态词在颜色之外承担辨识和无障碍功能，保留有独立含义的状态词。

| 视图 | 位置、原文及处理 | 保留 |
| --- | --- | --- |
| 管理端共用外壳 | 账户按钮副标「管理员」重复当前控制台身份，删除可见副标，保留按钮可访问名称 | 导航、用户名、账户菜单 |
| /dashboard | 页头「查看系统统计和待处理事项」重复卡片语义，删除已隐藏的导语配置 | 指标、状态与待处理入口 |
| /catalog/sources | 空态「暂无来源」与「添加来源」是状态和操作，保留 | 来源类型、刷新、同步失败原因、操作影响 |
| /catalog/nodes | 空态「暂无节点」与「管理来源」保留 | 输出兼容性、原始记录、停用及保留影响 |
| /catalog/groups | 「暂无分组」和添加按钮保留。规则命中、输出与影响订阅数各有用途 | 规则预览、节点顺序与分组引用数 |
| /catalog/apps | 重复二级标题「客户端下载」由操作行代替。删除已隐藏的「维护名称、简介与各平台下载配置」 | APP 数量由列表页脚呈现，保留平台、简介、下载开关影响和删除警告 |
| /delivery/subscriptions | 批量确认「选中的订阅将改用同一计划」「选中的订阅将改用同一转换配置绑定」说明操作范围，保留 | 输出预估、兼容性、编译诊断、链接失效及转移提示 |
| /delivery/templates | 空态「创建模板以复用有效期、流量额度和节点分配」重复创建入口及编辑字段，删除说明 | 创建入口、权益、版本、停用后果 |
| /delivery/conversions | 草稿退出提示「离开前可保存草稿，或放弃本次修改」描述操作，但具备未保存风险提示作用，保留 | 列表、编辑、版本、规则库、预览、发布与回滚影响 |
| /delivery/redemptions | 表单「最多发放 … 份订阅 · 完整码仅在本次生成后显示」及结果页「请妥善保存，关闭后只能查看尾码」信息关乎发放上限和一次性披露。结果页缩短为「关闭后仅显示尾码，请先保存」 | 期限、权益、版本、次数、导出和停用/作废后果 |
| /delivery/shares | 空态删除「用户创建分享后会在这里显示」。策略卡说明「分享策略在系统设置的订阅分发中维护」由同卡入口代替 | 策略链接、对象、访问状态与撤销影响 |
| /plans | 删除第二个「订阅计划」，保留操作行 | 新增入口、注册试用、计划期限和额度 |
| /delivery/tickets | 删除第二个「工单」；空态删「用户提交的工单会显示在这里」，有筛选时合并为「暂无匹配工单」 | 列表筛选、优先级、状态 |
| /delivery/tickets/:id | 「工单已关闭，发送回复会自动重开」缩为「回复后自动重开」，关闭状态已在页内显示 | 工单身份、回复、关闭确认 |
| /kb/manage | 移除已隐藏导语「维护教程分类与文章」和第二个「知识库管理」。空态无分类时保留前置指引，有分类时合并为「暂无匹配文章」 | 新建入口、分类、Markdown 能力、草稿可见性、删除影响 |
| /users | 删除共用卡片第二个「用户管理」，保留邀请操作行；空态「创建邀请并完成注册后，用户会显示在这里」缩为「暂无用户，请先创建邀请」 | 筛选、权限、停用与删除影响 |
| /users/recycle-bin | 同用户页移除重复卡片标题；空态删「移入回收站的用户会显示在这里」 | 恢复、永久删除后果 |
| /invites | 同用户页移除重复卡片标题；「新用户凭邀请码自定用户名、密码与邮箱完成注册，无需邮箱验证码」缩为「邀请注册无需邮箱验证码」 | 一次性明文、使用期限、停用与删除影响 |
| /operations/notices | 删除第二个「公告」 | 新建、刷新、排序、可见性和删除影响 |
| /audit-logs | 删除第二个「审计日志」 | 筛选、时间、事件与主体 |
| /system/registration | 注册方式下的「任何人都可以注册账户」「只能凭邀请码注册」「暂停新用户注册」重复选项，移除，仅留生效时机 | 注册权限、邮箱白名单及限制 |
| /system/mail | 「SMTP 密码已设置」「Resend API Key 已设置」重复对应字段占位反馈，合并为「密码与 API Key 只写入不回显，留空表示不修改」 | 邮件测试、凭据保护、变量、恢复默认、群发与提醒边界 |
| /system/distribution | 「模板」与入口「打开转换配置」重复且命名不一致，统一节标题「转换配置」，按钮「打开」保留完整可访问名称 | 域名优先级、访问限制、分享策略、订阅平台可见性 |
| /system/status | 「暂无迁移记录，各模块结构版本见上方列表」缩为「暂无迁移记录」 | 服务状态、刷新频率、最近任务和结构版本 |
| 编译任务相关视图 | 基底编译任务只有 Worker API，无独立页面；用户端订阅与管理端订阅详情、转换预览是相关展示入口 | 编译输入、输出、跳过、失败原因与处理方法 |
| /home | 快捷入口「节点 / 可用节点」合并为「节点」 | 当前订阅、流量、到期提醒及入口 |
| /subscriptions | 「重置后旧链接立即失效，请重新添加到客户端」和确认内容同义，但在按下风险按钮前提供影响，保留 | 拉取统计口径、平台能力、订阅链接、编译诊断及重置确认 |
| /nodes | 「暂无可用节点」和订阅入口保留 | 节点与查询条件 |
| /me、用户 /account | 「暂无订阅，可在下方输入兑换码」移除位置描述，保留兑换指引。设置提示缩为「仅在此浏览器生效，到期前 7 天在首页提醒」 | 独立订阅确认、兑换记录、安全设置 |
| 管理员 /account | 「用户名不可修改，头像根据账户信息自动生成；新密码须为 12 至 128 个字符」缩为「用户名不可修改，新密码须为 12 至 128 个字符」 | 会话失效确认、密码约束 |
| /notices | 删「查看最新服务公告」。展开后隐藏同一正文的折叠摘要 | 公告、搜索、折叠预览、阅读全文 |
| /apps（两角色共用） | 删「选择适合设备的客户端」 | 平台选择及下载入口、APP 简介 |
| /kb | 「知识库还没有内容 / 管理员发布文章后会显示在这里」合并为「暂无文章」 | 搜索无匹配时的恢复提示 |
| /kb/:id | 文章卡片重复页头文章标题，删卡片副标题并继续用页头为文章区域命名 | 文章元数据、正文与返回入口 |
| /tickets | 删「查看工单与支持回复」；空态删「遇到订阅或账户问题时，可以新建工单联系管理员」 | 新建按钮、状态与最后回复 |
| /tickets/:id | 删「查看工单处理进度」；关闭态提示缩为「如需继续，请新建工单」 | 回复正文、返回入口、关闭影响 |
| 订阅分享抽屉 | 空态删「创建后可以把链接发给别人」 | 创建入口、搜索恢复提示、链接披露和状态变化影响 |
| /s/:token | 登录、限流、密码和匿名分享的提示决定下步操作，保留 | 访问条件与报错 |
| /login | 标题、字段、注册入口和错误均有独立用途，保留 | 登录与注册指引 |
| /register | 用户名和密码规则及「当前仅接受邀请码注册，请向管理员获取邀请码」保留 | 注册资格、输入限制和错误 |
| /setup | 初始化身份、字段和校验提示保留 | 首次设置与密码约束 |
| /invite/:token | 跳转注册页，由注册表单显示邀请凭据和校验结果 | 错误与下一步操作 |
| 根路径、旧路径和未匹配路径 | 仅重定向；启动错误页保留失败原因和「重试」 | 路由行为与错误恢复 |

## 改动文件

- `development/tests/ui/` · `navigation-structure.test.ts`、`user-pages-style.test.tsx`
- `src/app/` · `AppShell.tsx`
- `src/features/accounts/` · `AccountPage.tsx`、`UserManagementPage.tsx`、`UsersPage.tsx`
- `src/features/admin/` · `AuditLogsPage.tsx`、`OperationsCard.tsx`
- `src/features/apps/` · `AppsPage.tsx`
- `src/features/catalog/` · `AppsPage.tsx`
- `src/features/dashboard/` · `DashboardPage.tsx`
- `src/features/delivery/` · `AdminSharesPage.tsx`、`EntitlementTemplatesPanel.tsx`、`PlansPage.tsx`
- `src/features/kb/` · `AdminKbPage.tsx`、`KbArticlePage.tsx`、`KbPage.tsx`
- `src/features/notices/` · `NoticesPage.tsx`
- `src/features/redemption/` · `AdminRedemptionsPage.tsx`、`PersonalRedemptions.tsx`
- `src/features/shares/` · `ShareDrawer.tsx`
- `src/features/system/` · `InviteCodesSection.tsx`、`NoticesSection.tsx`、`SystemPage.tsx`
- `src/features/tickets/` · `AdminTicketDetailPage.tsx`、`AdminTicketsPage.tsx`、`TicketDetailPage.tsx`、`TicketsPage.tsx`
- `src/features/user/` · `HomePage.tsx`、`MinePage.tsx`
- `src/styles/` · `admin-navigation.css`、`components.css`、`pages-adminshares.css`、`pages-kb.css`、`pages-tickets.css`
- `src/ui/` · `DataHeader.tsx`、`PageHero.tsx`、`QuickEntryCard.tsx`

## 构建与测试

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误 |
| `npm run build` | 通过。Worker 约 1,111 KB，客户端主 JS 约 681 KB，主 CSS 约 154 KB。保留基线已有的 Vite 大块提示与 Node 弃用提示 |
| `CI=1 npm test` | 65 个文件，551 项通过，默认跳过 1 项可选性能基准 |
| `CI=1 VITE_CORE_F_BENCH=1 npm test` | 终版通过，65 个文件，552 项通过 |
| `CI=1 npx vitest run --config development/vitest-pages-node.config.ts` | 15 个文件，232 项通过 |
| `CI=1 npx vitest run --config development/vitest.controls.config.ts` | 8 个文件，36 项通过 |
| `git diff --check` | 通过 |

## 浏览器回归

- 使用 Chromium 对照基底和修改后构建。在 1440、1024 和 390 px 各检查 49 个页面或界面状态，共 147 组、294 张截图。截图按版本存于 [改前](development/screenshots/ui-copy-trim/before/) 和 [改后](development/screenshots/ui-copy-trim/after/)。检查了图片尺寸、页面横向溢出和主要操作的位置，并目视对照三种宽度下的标题、空态、抽屉与正文
- 管理端逐页验证导航、搜索和筛选、创建与编辑入口、设置控件和操作确认。用户端验证订阅与节点跳转、分享创建表单、公告展开收起、知识库文章与返回、客户端下载平台切换、工单入口及个人中心到期提醒持久化。独立检查了登录、注册、邀请跳转、初始化表单和公开分享入口
- 兑换码在独立本地 Worker 验证生成、单次 CSV 导出、尾码、作废、停用与审计，以及用户预览权益、确认兑换、复制链接、兑换历史和新订阅。先对照两版构建，再核对兑换前后既有订阅的 18 条自动识别、显式格式与别名路径。对应状态码均为 200，正文摘要、MIME、下载文件名和 ETag 一致
- 编译相关界面验证了用户和管理端的兼容诊断展开，以及三个宽度下以合成节点生成转换预览。编译任务的 API 行为由 Worker 测试覆盖
- 浏览器访问限制为本机。外部头像因隔离而未加载，截图遮盖了可复用的链接、二维码和完整码。初始化页改后截图用模拟的未初始化状态；真实本地 Worker 完成其余兑换、订阅和导航检查。危险入口检查至确认界面，既有账户、数据和生产环境均未操作

## 风险与回滚

布局风险集中在删除重复标题后的操作行、长标题折行和移动端抽屉。用三档宽度覆盖这些界面，保留筛选、按钮和必要说明。保留原有状态文字的可访问语义，知识库文章区域继续引用页头标题。源代码改动限于展示层与对应 UI 测试，交付的是本地 Git bundle。

集成后若需撤回，使用 `git revert <精简提交>` 生成反向提交，再运行 `npm run check`、`npm run build` 和测试。必要时重新发布此前已知正常的构建产物。回滚无需数据恢复或迁移。

UI_COPY_TRIM_DONE
