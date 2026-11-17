# 项目表单控件替换报告

## 范围与结果

基线：origin/main 3364e5d；交付分支：task/project-controls-codex

先用 `rg -n '<(input|select|textarea)\b' src` 搜索，再用 TypeScript JSX AST 按节点记录清单（同一行多个元素分别记录）。原始共 125 个渲染位置：98 个 input、15 个 select、12 个 textarea，覆盖 29 个业务文件及 3 个已有共享组件。循环产生的实例以渲染位置计数。未发现 radio、date、time、range 等其他类型

全部位置已替换。注册逻辑、页面结构、业务处理函数、API、数据库和迁移未改；原有值、name、约束、disabled、搜索/分页及批量选择处理保留

## 共享组件

- 复用 `src/ui/Select.tsx` 的视觉与选项菜单；扩展 id、错误关联、键盘方向键/Home/End/Enter/空格、首字符定位、Escape/Tab 关闭、活动项滚动与点击后焦点恢复
- 新建 `src/ui/Controls.tsx`：Input、Textarea、Checkbox、DateTimeInput、FileInput、FormSelect
- FormSelect 仅适配原 option/Fragment/map 数据到已有 Select，不另建菜单样式；保留字符串值、数值分页转换、空选项和 disabled；required 通过不可见的项目 Input 校验代理阻止空值提交并关联内联错误
- Input / Textarea 保留浏览器编辑、密码、数字和约束语义，拦截 invalid 气泡，以项目 `sp-form-field-error` 和 aria-invalid / aria-describedby 显示内联提示；复用已有错误样式，不引入新业务校验体系
- Checkbox 使用原生可访问与表单语义，但用项目令牌绘制勾选、focus、disabled；DateTimeInput 保留 datetime-local 的本地时间格式与原事件
- FileInput 用项目按钮和文件名展示，原文件读取回调及 accept 保留
- SearchInput、PasswordInput、Switch 内部均改用新共享组件；FormField、Dialog/EditDrawer 与现有 Switch 外部 API 继续复用
- `src/styles/controls.css` 只用现有配色、圆角和焦点令牌；入口最后引入，统一默认样式并兼容已有搜索框及开关布局

## 原始逐项清单与替换结果

下列行号为替换前基线。每行代表一个原生 JSX 控件位置；属性摘要含 id、name、aria-label、placeholder 等，可用于定位具体字段。页面/表单标在每个文件标题中。全部行的结果为已完成

### src/features/accounts/AccountPage.tsx — 账户 / 修改密码

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 76 | input / password | id="account-current-password"; name="currentPassword" | Input / 已完成 |
| 79 | input / password | id="account-new-password"; name="newPassword" | Input / 已完成 |
| 82 | input / password | id="account-confirm-password"; name="confirmPassword" | Input / 已完成 |

### src/features/accounts/EmailBindChangeForm.tsx — 账户 / 绑定或更换邮箱

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 67 | input / text | id="account-email-code"; name="code" | Input / 已完成 |
| 97 | input / email | id="account-email-address"; name="email" | Input / 已完成 |

### src/features/accounts/InvitePage.tsx — 邀请接受 / 设置密码

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 49 | input / password | id="invite-password"; name="password" | Input / 已完成 |
| 50 | input / password | id="invite-confirm-password"; name="confirmPassword" | Input / 已完成 |

### src/features/accounts/LoginPage.tsx — 登录表单

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 43 | input / text | id="login-username"; name="username" | Input / 已完成 |

### src/features/accounts/RegisterPage.tsx — 注册 / 账号、邮箱验证码与邀请码

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 117 | input / text | id="register-username"; name="username" | Input / 已完成 |
| 120 | input / email | id="register-email"; name="email" | Input / 已完成 |
| 123 | input / text | id="register-code"; name="code" | Input / 已完成 |
| 130 | input / text | id="register-invite-code"; name="inviteCode" | Input / 已完成 |

### src/features/accounts/SetupPage.tsx — 首次设置 / 管理员账号

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 41 | input / text | id="setup-username"; name="username" | Input / 已完成 |
| 44 | input / password | id="setup-password"; name="password" | Input / 已完成 |

### src/features/accounts/UsersPage.tsx — 用户管理 / 批量选择、邀请、编辑邮箱、重置密码

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 440 | input / checkbox | aria-label={\`选择用户 ${user.username} | Checkbox / 已完成 |
| 539 | input / checkbox | aria-label={\`选择邀请 ${invite.username} | Checkbox / 已完成 |
| 593 | input / text | aria-label="邀请链接" | Input / 已完成 |
| 612 | input / text | id="invite-username"; name="username"; placeholder="输入用户名" | Input / 已完成 |
| 645 | input / checkbox | aria-label="选择全部用户" | Checkbox / 已完成 |
| 679 | input / checkbox | aria-label="选择全部邀请" | Checkbox / 已完成 |
| 708 | input / email | id="edit-user-email"; name="email" | Input / 已完成 |
| 735 | input / text | aria-label="临时密码" | Input / 已完成 |
| 745 | input / password | id="reset-new-password"; name="newPassword" | Input / 已完成 |
| 748 | input / password | id="reset-confirm-password"; name="confirmPassword" | Input / 已完成 |

### src/features/admin/AuditLogsPage.tsx — 审计日志 / 操作、管理员与时间筛选

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 11 | input / text | &lt;input value={action} onChange={e=&gt;{setAction(e.target.value);setPage(1)}}/&gt; | Input / 已完成 |
| 11 | input / text | &lt;input value={actor} onChange={e=&gt;{setActor(e.target.value);setPage(1)}}/&gt; | Input / 已完成 |
| 11 | input / datetime-local | &lt;input type="datetime-local" value={from} onChange={e=&gt;{setFrom(e.target.value);setPage(1)}}/&gt; | DateTimeInput / 已完成 |
| 11 | input / datetime-local | &lt;input type="datetime-local" value={to} onChange={e=&gt;{setTo(e.target.value);setPage(1)}}/&gt; | DateTimeInput / 已完成 |

### src/features/catalog/AppsPage.tsx — 客户端管理 / 基本信息与平台下载配置

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 371 | input / text | id="app-name" | Input / 已完成 |
| 374 | input / text | id="app-sort" | Input / 已完成 |
| 377 | textarea / — | id="app-description" | Textarea / 已完成 |
| 392 | select / — | id={\`app-platform-${index} | FormSelect / 已完成 |
| 397 | input / text | id={\`app-download-${index}; placeholder="https://…" | Input / 已完成 |
| 400 | input / text | id={\`app-doc-${index}; placeholder="https://…" | Input / 已完成 |
| 403 | input / text | id={\`app-platform-sort-${index} | Input / 已完成 |

### src/features/catalog/GroupsPage.tsx — 分组管理 / 选择分组与包含、排除规则

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 203 | input / checkbox | aria-label={\`选择分组 ${group.name} | Checkbox / 已完成 |
| 250 | input / text | aria-label="分组名称" | Input / 已完成 |
| 252 | input / checkbox | aria-label={\`包含来源 ${source.name} | Checkbox / 已完成 |
| 254 | input / checkbox | aria-label={\`单独包含节点 ${node.displayName} | Checkbox / 已完成 |
| 256 | input / checkbox | aria-label={\`排除节点 ${node.displayName} | Checkbox / 已完成 |

### src/features/catalog/NodesPage.tsx — 节点管理 / 批量选择、筛选、分页与重命名

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 194 | input / checkbox | aria-label={\`选择节点 ${node.displayName} | Checkbox / 已完成 |
| 236 | select / — | aria-label="节点协议" | FormSelect / 已完成 |
| 237 | select / — | aria-label="节点来源" | FormSelect / 已完成 |
| 255 | input / checkbox | aria-label="选择当前页节点" | Checkbox / 已完成 |
| 259 | select / — | aria-label="每页显示" | FormSelect / 已完成 |
| 270 | input / text | aria-label="节点名称" | Input / 已完成 |

### src/features/catalog/SourcesPage.tsx — 来源管理 / 批量选择与来源编辑、文件导入

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 332 | input / checkbox | aria-label={\`选择来源 ${source.name} | Checkbox / 已完成 |
| 388 | input / checkbox | aria-label="选择全部来源" | Checkbox / 已完成 |
| 399 | input / text | aria-label="来源名称" | Input / 已完成 |
| 400 | select / — | aria-label="来源类型" | FormSelect / 已完成 |
| 402 | input / text | aria-label="远程 URL"; placeholder={drawer === 'create' ? 'https://example.com/source' : '留空保持当前 URL'} | Input / 已完成 |
| 403 | textarea / — | aria-label="请求 Headers"; placeholder={drawer === 'create' ? '{"User-Agent":"SubPanel"} | Textarea / 已完成 |
| 404 | input / number | aria-label="刷新周期" | Input / 已完成 |
| 406 | input / file | aria-label="来源文件" | FileInput / 已完成 |
| 407 | textarea / — | aria-label="来源内容"; placeholder="粘贴订阅或节点内容" | Textarea / 已完成 |

### src/features/delivery/AdminSharesPage.tsx — 分享管理 / 用户与订阅筛选

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 268 | select / — | aria-label="按用户筛选" | FormSelect / 已完成 |
| 275 | select / — | aria-label="按订阅筛选" | FormSelect / 已完成 |

### src/features/delivery/MySubscriptionsPage.tsx — 我的订阅 / 新令牌展示

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 186 | input / text | aria-label="新订阅令牌" | Input / 已完成 |

### src/features/delivery/SubscriptionsPage.tsx — 订阅管理 / 批量选择、订阅编辑、有效期与链接展示

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 389 | input / checkbox | aria-label={\`选择订阅 ${subscription.name} | Checkbox / 已完成 |
| 486 | input / text | aria-label="新订阅令牌" | Input / 已完成 |
| 515 | input / text | aria-label="订阅名称" | Input / 已完成 |
| 516 | select / — | aria-label="所属用户" | FormSelect / 已完成 |
| 517 | input / checkbox | aria-label={\`使用分组 ${group.name} | Checkbox / 已完成 |
| 518 | select / — | aria-label="默认客户端" | FormSelect / 已完成 |
| 521 | input / datetime-local | id="exp-starts-at"; aria-label="生效时间" | DateTimeInput / 已完成 |
| 528 | input / datetime-local | id="exp-expires-at"; aria-label="到期时间" | DateTimeInput / 已完成 |
| 551 | input / text | aria-label={\`${CLIENT_LABELS[client] ?? client} | Input / 已完成 |

### src/features/entitlements/PlansPage.tsx — 权益计划 / 注册试用、计划编辑与绑定分组

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 66 | select / — | id="trial-plan" | FormSelect / 已完成 |
| 67 | input / number | id="trial-days" | Input / 已完成 |
| 72 | input / text | id="plan-name" | Input / 已完成 |
| 73 | textarea / — | id="plan-description" | Textarea / 已完成 |
| 74 | input / number | id={\`plan-${key} | Input / 已完成 |
| 75 | input / checkbox | &lt;input type="checkbox" checked={draft.groupIds.includes(g.id)} onChange={(e) =&gt; setDraft({ ...draft,groupIds: e.target.checked ? [...draft.groupIds,g.id] : draft.groupIds.filter((id) =&gt; id !== g.id) })} /&gt; | Checkbox / 已完成 |
| 76 | input / checkbox | &lt;input type="checkbox" checked={draft.enabled} onChange={(e) =&gt; setDraft({ ...draft,enabled: e.target.checked })} /&gt; | Checkbox / 已完成 |

### src/features/entitlements/UserEntitlement.tsx — 用户权益 / 开通、续期、换计划、收回与备注

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 40 | select / — | id={\`action-${userId} | FormSelect / 已完成 |
| 41 | select / — | id={\`plan-${userId} | FormSelect / 已完成 |
| 42 | textarea / — | id={\`note-${userId} | Textarea / 已完成 |

### src/features/kb/AdminKbPage.tsx — 知识库管理 / 分类与文章编辑

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 366 | input / text | id="kb-category-name" | Input / 已完成 |
| 377 | input / number | id="kb-category-sort" | Input / 已完成 |
| 468 | input / text | id="kb-article-title-input" | Input / 已完成 |
| 479 | textarea / — | id="kb-article-content" | Textarea / 已完成 |
| 491 | input / number | id="kb-article-sort" | Input / 已完成 |

### src/features/shares/ShareDrawer.tsx — 分享抽屉 / 备注、有效期、密码与链接展示

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 138 | input / text | id="share-remark" | Input / 已完成 |
| 141 | input / text | id="share-days"; placeholder="留空使用默认有效期" | Input / 已完成 |
| 156 | input / password | id="share-password"; placeholder="留空表示不设密码" | Input / 已完成 |
| 379 | input / text | aria-label="分享链接" | Input / 已完成 |

### src/features/shares/SharePage.tsx — 分享页 / 密码访问与手动复制链接

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 237 | input / password | id="share-access-password"; name="password" | Input / 已完成 |
| 299 | input / text | aria-label="订阅链接" | Input / 已完成 |

### src/features/system/AdminMailSection.tsx — 邮件管理 / 模板、群发与到期提醒

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 20 | input / text | &lt;input required maxLength={500} value={t.subject} onChange={e=&gt;setTemplates(templates.map((v,j)=&gt;j===i?{...v,subject:e.target.value}:v))}/&gt; | Input / 已完成 |
| 21 | textarea / — | &lt;textarea required value={t.body} onChange={e=&gt;setTemplates(templates.map((v,j)=&gt;j===i?{...v,body:e.target.value}:v))}/&gt; | Textarea / 已完成 |
| 25 | select / — | &lt;select value={target} onChange={e=&gt;setTarget(e.target.value)}&gt; | FormSelect / 已完成 |
| 26 | input / text | &lt;input required maxLength={500} value={subject} onChange={e=&gt;setSubject(e.target.value)}/&gt; | Input / 已完成 |
| 26 | textarea / — | &lt;textarea required maxLength={50000} value={body} onChange={e=&gt;setBody(e.target.value)}/&gt; | Textarea / 已完成 |
| 28 | input / number | &lt;input type="number" min={1} max={365} required value={days} onChange={e=&gt;setDays(Number(e.target.value))}/&gt; | Input / 已完成 |

### src/features/system/DomainSettingsSection.tsx — 域名设置 / 已有域名备注与新增域名

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 119 | input / text | aria-label={\`${item.hostname}; placeholder="备注" | Input / 已完成 |
| 141 | input / text | id={\`${idPrefix}; placeholder="例如 panel.example.com" | Input / 已完成 |
| 144 | input / text | id={\`${idPrefix} | Input / 已完成 |

### src/features/system/InviteCodesSection.tsx — 邀请码设置 / 生成数量、次数与过期时间

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 166 | input / number | id="sys-invite-max-uses" | Input / 已完成 |
| 180 | input / number | id="sys-invite-count" | Input / 已完成 |
| 194 | input / datetime-local | id="sys-invite-expires" | DateTimeInput / 已完成 |

### src/features/system/NoticesSection.tsx — 公告管理 / 标题、正文、排序与发布时间

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 189 | input / text | id="ntc-title" | Input / 已完成 |
| 200 | textarea / — | id="ntc-body" | Textarea / 已完成 |
| 212 | input / number | id="ntc-sort" | Input / 已完成 |
| 225 | input / datetime-local | id="ntc-published" | DateTimeInput / 已完成 |

### src/features/system/ShareSettingsSection.tsx — 分享设置 / 限额、访问控制与公开地址

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 167 | input / number | id="sys-share-max-shares" | Input / 已完成 |
| 170 | input / number | id="sys-share-max-active" | Input / 已完成 |
| 173 | input / number | id="sys-share-max-days" | Input / 已完成 |
| 176 | select / — | id="sys-share-access-control" | FormSelect / 已完成 |
| 183 | input / url | id="sys-share-public-base"; placeholder="https://share.example.com" | Input / 已完成 |

### src/features/system/SystemPage.tsx — 系统设置 / 站点与邮件配置、测试邮件

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 195 | input / text | id="sys-domain-input"; placeholder="example.com" | Input / 已完成 |
| 301 | select / — | id="sys-mail-provider" | FormSelect / 已完成 |
| 307 | input / text | id="sys-mail-from"; placeholder="SubPanel &lt;no-reply@example.com&gt;" | Input / 已完成 |
| 310 | input / text | id="sys-mail-host"; placeholder="smtp.example.com" | Input / 已完成 |
| 313 | input / number | id="sys-mail-port"; placeholder="465" | Input / 已完成 |
| 316 | input / text | id="sys-mail-user" | Input / 已完成 |
| 319 | input / password | id="sys-mail-pass"; placeholder={settings.smtpPasswordSet ? '••••••••' : '未设置'} | Input / 已完成 |
| 331 | input / password | id="sys-mail-resend-key"; placeholder={settings.resendApiKeySet ? '••••••••' : '未设置'} | Input / 已完成 |
| 356 | input / email | id="sys-mail-test-to"; placeholder="you@example.com" | Input / 已完成 |

### src/features/tickets/AdminTicketDetailPage.tsx — 管理工单详情 / 回复

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 129 | textarea / — | id="tk-admin-reply-body"; placeholder="输入处理结果或需要用户补充的信息" | Textarea / 已完成 |

### src/features/tickets/TicketDetailPage.tsx — 用户工单详情 / 回复

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 108 | textarea / — | id="tk-reply-body"; placeholder="补充说明或回应管理员" | Textarea / 已完成 |

### src/features/tickets/TicketsPage.tsx — 工单列表 / 新建工单

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 117 | input / text | id="tk-create-title" | Input / 已完成 |
| 136 | textarea / — | id="tk-create-body"; placeholder="请描述遇到的问题、发生时间和已尝试的处理" | Textarea / 已完成 |

### src/ui/PasswordInput.tsx — 共享密码输入 / 可见性切换

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 5 | input / {visible ? 'text' : 'password'} | &lt;input {...props} type={visible ? 'text' : 'password'} /&gt; | Input / 已完成 |

### src/ui/SearchInput.tsx — 共享搜索输入

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 16 | input / search | placeholder={placeholder}; aria-label={label ?? placeholder ?? '搜索'} | Input / 已完成 |

### src/ui/Switch.tsx — 共享开关

| 原行 | 原控件 | 字段属性摘要 | 项目组件 / 结果 |
| --- | --- | --- | --- |
| 16 | input / checkbox | aria-label={ariaLabel ?? label} | Checkbox / 已完成 |

## 原生实现与例外说明

`src/features` 不再直接渲染 input/select/textarea。共享组件底层仍必须使用标准 HTML 编辑元素，这些有统一项目样式和状态，不属于裸控件

最终全 src 搜索只有 `src/ui/Controls.tsx` 内 4 个 JSX 原生位置：

1. Input 的底层 input：统一项目输入实现，包含 Checkbox、DateTimeInput、SearchInput、PasswordInput、Switch 的最终底层
2. Textarea 的底层 textarea：统一项目多行输入实现
3. FileInput 的 `type="file" hidden`：唯一业务文件上传位于 SourcesPage 来源文件，浏览器文件选择必须以原生 file input 承载，可见 UI 为项目按钮及文件名
4. FormSelect 的 `type="hidden"`：当配置 name 时承载表单提交值，当前迁移的业务 selects 没有 name；这是共享组件的通用能力

required 代理使用项目 Input，屏幕不可见、不可 Tab 聚焦，invalid 时焦点移到可见 Select，提示使用内联项目样式。未保留业务页面裸控件，也没有原生 select 渲染

## 最终搜索与检查

- `rg -n '<(input|select|textarea)\b' src/features`：0 命中（rg 退出码 1 表示无匹配）
- `rg -n '<(input|select|textarea)\b' src`：仅上面 4 个组件实现位置；0 原生 select
- `git diff --check`：通过
- `XDG_CONFIG_HOME=/tmp/controls-config npm run check`：通过（Wrangler 类型检查、tsc、oxlint）
- `XDG_CONFIG_HOME=/tmp/controls-config npm run build`：通过；Vite 仅提示客户端 chunk 超过 500 kB
- `node node_modules/vitest/vitest.mjs run --config development/vitest.controls.config.ts`：5 文件、17 测试通过；其中原有前端 API、诊断、catalog counts、markdown 共 13 测试，新组件表单约束/选项转换/复选语义/文件上传配置共 4 测试
- `npm test`：已尝试完整现有 Cloudflare worker 测试入口，但运行器启动即因 `listen EPERM 127.0.0.1` 中止，未运行任何 worker 用例。无法在此沙箱验证 main 的全量运行测试数与全量不回退，不把聚焦测试数冒充全量基线；原有 worker 测试文件未修改、删除或跳过
- 浏览器验证：默认 Playwright 浏览器未安装；另尝试已有 `/usr/bin/chromium`，被沙箱 `setsockopt: Operation not permitted` 阻止启动。未声称完成交互、截图、端到端或实际键盘行为验证。已更新 admin-frontend 中本次迁移 select 的选项选择操作，测试数不变

依赖目录原为外部只读 node_modules 符号链接。检查期间临时使用本地目录、将包逐项符号链接回原包目录，仅让 .tmp/.vite 等缓存可写；未修改依赖、锁文件或构建配置，交付前恢复原 node_modules 链接。Wrangler 日志位置通过 XDG_CONFIG_HOME 指到 /tmp

## 交付

原工作树 .git 实际位于只读的 `/data/workspace/subpanel-pages/.git/worktrees/subpanel-controls`，逐文件 git add 被 EROFS 拒绝。按 brief 在 `/tmp/project-controls-delivery` 可写本地克隆的同名分支提交；原目录保留所有修改和本报告，原只读分支指针无法更新

提交仅逐文件 add，未使用 git add -A。未 push/scp。bundle 从该克隆运行：

```sh
git bundle create /tmp/project-controls.bundle task/project-controls-codex
git bundle verify /tmp/project-controls.bundle
```

bundle 包含同名分支和本报告，提交号以 bundle 的 `git bundle list-heads /tmp/project-controls.bundle` 为准
