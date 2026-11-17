# Stage 3：系统管理补强

已按 BRIEF_STAGE3_ADMIN.md 和参考方案阶段 3 完成；未修改 UI 配色或布局体系，未涉及知识库、销售系统或部署。

## 数据与迁移

迁移：`migrations/0010_stage3_admin.sql`。

- `audit_logs`：id、actor_user_id、action、target_type、target_id、detail JSON、created_at，支持时间及管理员/操作索引。0001 已存在未使用的旧审计表（entity_type/entity_id）；0010 重建并复制历史数据，转换字段，保留旧 id，解除用户删除级联影响，日志不会因用户永久删除而消失。
- `mail_templates`：key、subject、body、updated_at。键为 verification、expiry_reminder、broadcast；无自定义记录时提供内置模板，删除即恢复默认。
- `mail_broadcasts`：id、subject、body、target、status、total、sent、failed、created_by、created_at、sent_at。
- `user_entitlements.last_reminded_at`：可空 Unix 秒时间戳。该字段保存已成功提醒的**到期日时间戳**作为去重标记，而非发送时刻；与当前 expires_at 的 UTC 日期比较。续期至新日期后可再次提醒，发送失败不写标记。
- 设置 `reminder_days` 默认 3，管理端可改为 1–365。

部署前须应用 0010；邮件模板读取在迁移尚未应用时仍回退内置验证码文案。

## 端点与页面

所有管理端点沿用 requireAuth、requireAdmin、同源写请求和 no-store 中间件。

| 端点 | 行为 |
| --- | --- |
| GET /api/admin/audit-logs | 服务端 page/pageSize 分页，默认 20、上限 100；action、actor 精确筛选，from/to 时间筛选；返回 logs、total、page、pageSize 及 pagination |
| GET /api/admin/stats | 总用户、有效权益、7 日内到期权益、待处理工单、计划、分组、节点 |
| GET /api/admin/mail-templates | 三类模板列表，含默认值 |
| PUT /api/admin/mail-templates/:key | 新建/更新 subject/body |
| DELETE /api/admin/mail-templates/:key | 删除覆盖值，恢复默认模板 |
| GET /api/admin/mail-broadcasts | 最近 100 条发送历史 |
| POST /api/admin/mail-broadcasts | subject/body/target（all、active、expiring）；先建记录，再逐个发送及持久化计数，最后写 sent/partial/failed 和 sent_at |
| GET、PUT /api/admin/system/reminders | 读取和修改 reminder_days |
| POST /api/admin/jobs/expiry-reminders | 手动执行提醒，返回 processed/sent/failed/skipped |

概览顶部新增统计块；侧栏新增「审计日志」只读页；系统目录新增「模板与群发」，包含模板列表编辑、占位符说明、恢复默认、群发撰写与历史、提前天数及手动提醒按钮和结果提示。复用既有样式、PageHeader、DataHeader、FormField、ErrorState、Pagination 等组件。

统计口径：总用户排除软删除用户；有效权益满足 active、starts_at <= now < expires_at、计划启用、用户启用且未删除；7 日内到期在此基础上 expires_at <= now + 7 日；待处理工单是 status=open；计划/分组/节点为现有表的总记录数。无虚构流量或活跃访问统计。

群发全部用户包含未删除用户，无邮箱计失败；有效/即将到期目标使用上述有效权益口径，提醒使用 reminder_days。发送走现有 sendMail，保留原凭据解析和至多一次重试；未配置凭据的 ok=false 及抛出异常都计失败，不假报成功。广播发送过程中逐个写入进度；请求中断可能保留 sending 状态以供核查。

## 审计挂钩与邮件行为

集中 logAudit 和成功管理端变更中间件挂在认证后、管理路由前，涵盖：

- 用户修改、角色/启停、密码重置、软删除、恢复、永久删除。
- 权益 grant/renew/switch/revoke，注册试用设置；计划增删改。
- system 下注册、下载、邮件凭据、域名与平台策略、提醒设置，以及 share-settings。
- invites、invitations、invite-codes、邮箱白名单操作。
- 工单管理回复/关闭/重开，以及公告操作。
- 新增邮件模板、群发、提醒任务操作。

日志记录管理员、HTTP 方法、路径、结果、目标 ID 和白名单字段 action/role/enabled/planId；不存请求正文、密码、验证码、令牌、邮件凭据或邮件正文。动作例：post.users.entitlement.grant、patch.users、post.tickets.replies。创建资源时从响应提取 id。

现有验证码没有模板键体系，本次接入 verification，覆盖全部既有用途（注册、绑定、更换邮箱、找回密码），保留测试 deliverer 和内置中英文回退文案。变量替换为单次替换，正文转义后生成 HTML，标题去除换行。到期模板支持 username/plan/expires_at，群发支持 username/subject/body。

## 验证结果

- `npm run check`：通过（Wrangler 类型检查、TypeScript、oxlint）。
- `npm run build -- --configLoader runner`：通过，Worker 和前端生产构建成功。
- `node development/test-stage3-offline.mjs`：7/7 通过。真实 SQLite 全量迁移与旧审计数据保留、HTTP 管理员鉴权、审计写入/过滤/分页/安全字段/权益动作、stats 与有效/到期筛选、模板列表/更新/删除和实际 mailer 回退、HTML 转义、群发成功/失败/异常/未配置计数、提醒去重/失败重试/续期及设置校验。
- `node development/test-entitlements-offline.mjs`：既有 10/10 通过。
- `npm test`：默认配置加载先遇到 node_modules 的只读缓存目录；使用 `npm test -- --configLoader runner` 后到达 Worker runner，但报 `listen EPERM: operation not permitted 127.0.0.1`，未执行测试。因此基线 397 项 Worker 测试本环境未复验，不能宣称全部通过。已更新测试迁移清单、表清单及迁移数量断言至 0010。
- `git diff --check`：通过。

沙箱适配仅用于检查：XDG_CONFIG_HOME=/tmp/stage3-config；临时将三个 tsconfig 的 tsBuildInfoFile 指向 /tmp，完成后已恢复，未提交配置变化；Vite 用 configLoader runner 避开只读 node_modules/.vite-temp。node_modules 符号链接未改动。

自动定时触发依赖 cron 触发器修复（已知 blocked 项）；本线只交付提醒逻辑与管理员手动触发。未配置真实邮件凭据，实发交付仍依赖阶段 0，测试使用传输打桩。

## 交付

分支：task/stage3-admin-codex。原 worktree 的 .git 指向 `/data/workspace/subpanel-codex/.git/worktrees/subpanel-stage3`，位于沙箱只读区域；直接 git add / commit 报 `Unable to create .../index.lock: Read-only file system`。因此原 worktree 的 branch pointer 无法推进。

为完成可收取的提交与 bundle，使用 `/tmp/stage3-delivery.git` 中的可写 Git 元数据（从原仓库本地复制，保留原历史与同名分支），以当前工作目录为 work tree，逐文件暂存并在 `task/stage3-admin-codex` 上提交报告和全部实现。交付包 `/tmp/stage3.bundle` 由该 Git 目录执行 `git bundle create /tmp/stage3.bundle task/stage3-admin-codex` 并验证。该 bundle 包含同名分支上的新提交；原只读 worktree 仍会显示源码未提交，外部需从 bundle 收取提交。不 push、不 scp。
