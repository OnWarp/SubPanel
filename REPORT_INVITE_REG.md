# 邀请码注册与用户／邀请拆页交付报告

## 现状审计

基线为 `3364e5d`，工作分支为 `task/invite-registration-codex`

- 原来存在两套开户机制：`worker/accounts/admin-routes.ts` 的 `/api/admin/invites` 要求用户名，将用户名和预留 userId、创建时间、24 小时到期时间写入 KV `invite:<token hash>`，生成邀请时还会推进账户 ID 序列
- 原 `/invite/:token` 页只显示绑定用户名并收集密码，调用 `/api/invites/:token`，由旧接口按预留身份写账户后删除 KV；这条路径没有注册邮箱，也不能将 KV 消费与账户写入放进同一 D1 原子批次
- 另一套 `/api/admin/invitations` 已使用 D1 `invite_codes` 与 `invite_code_redemptions`，保存哈希、前缀、类型、上限、已用次数、有效期、停用状态、创建人，不绑定用户名；支持单个多次码及批量单次码，原管理组件位于系统页
- 原 `/api/register` 在检查邀请码前总是验证邮箱验证码，邀请制和开放注册均要求验证码；邮箱域名白名单非空时对两者都生效
- 原 `/users` 混放用户管理与用户名绑定邀请，系统页另有独立注册邀请码管理，导航只有“用户与邀请”入口

## 新模型落地

- 所有新邀请统一使用 D1 注册资格码；单个多次码仍支持次数上限或不限，批量单次码仍各限一次，过期与停用条件保持不变
- 邀请生成表单不含用户名；服务端生成不要求、不保存用户名或预留账户 ID
- `/api/register` 收集并沿用用户名、密码、邮箱原有格式及唯一性校验；有合法邀请码时完全跳过邮箱验证码验证，不发邮件，邮箱直接设置 `email_verified_at`
- 邀请消费、用户插入、消费记录、可选试用权益及账户元数据仍在同一个 `DB.batch` 中；消费 UPDATE 重查停用、期限与次数条件，用户 INSERT 通过 `changes()` 保护，插入报错使整个批次回滚
- 消费记录紧随用户插入，再执行可选试用权益，防止试用语句覆盖 `changes()` 导致错误的消费记录判断
- 开放注册无码时继续验证并原子消费邮箱验证码，原发送、错误次数、过期与限流流程保留；开放模式持码链接走同一免验证码分支；关闭模式仍拒绝全部自助注册
- **邮箱域名白名单维持原样**：非空时邀请注册与开放注册都受限制；免验证码不代表绕过域名白名单，管理员直改邮箱的既有行为未改
- 注册成功沿用自动登录会话；用户名登录与邮箱登录均可用

## 旧码与旧链接

- 新迁移 `migrations/0012_invite_registration.sql` 将旧 D1 `invitations.id` 哈希导入普通单次资格码，保留到期时间，忽略旧 username/user_id 绑定；已有旧消费记录对应的码直接标为已用一次，避免复活已消费资格
- 旧 KV 邀请在邀请列表、停用或持码注册时自动迁入 D1；只保留哈希、创建与到期时间，忽略用户名及 userId，D1 写入成功后才删除 KV 原记录
- KV 导入采用 `INSERT OR IGNORE`，重复导入不会重置已用次数或停用状态；实际资格消费仅发生在 D1 注册原子批次内
- `/invite/:token` 统一跳转 `/register?inviteCode=<token>`，注册表单预填邀请码，让持有人自定用户名、密码、邮箱，隐藏验证码输入及发送按钮
- 旧 `POST /api/invites/:token` 已移除开户逻辑，返回 410 并提示进入注册页；旧 GET 重定向至带码注册页，不再泄露或执行旧用户名绑定
- 旧管理 `/api/admin/invites` 保留兼容别名，但生成、列表与停用都使用统一 D1 资格码；单个别名生成保留原 24 小时期限，不再接受用户名绑定
- 链接复制沿用主面板域名优先、请求源回退的地址规则；明文邀请码及链接只在生成响应／本次页面显示，列表仍只展示前缀
- 自助注册继续要求账户模块已迁入 D1；未启用 D1 的部署仍保持注册不可用，不恢复旧 KV 开户路径

## 用户与邀请拆页

- `/users` 只保留用户列表、筛选、分页、状态、回收站、密码重置、权益与订阅等既有功能，移除邀请请求和界面
- **原编辑用户弹窗、邮箱字段及保存处理未改**
- 新 `/invites` 页面承接原系统页邀请码组件：状态／已用次数／期限列表、单个多次生成、批量单次生成、停用、复制码、复制链接、复制全部
- 保留批量选择及停用能力，显示处理进度与部分失败；DELETE 仍为停用并保留消费历史，符合原 D1 语义
- 系统页移除重复邀请码组件；导航独立提供“用户”“邀请”，移动端邀请入口位于既有更多菜单
- 沿用 PageHeader、系统页布局、BatchToolbar、FormField、StatusBadge、ConfirmDialog 和现有配色，无新增视觉体系

## 检查与测试

全部检查使用 `XDG_CONFIG_HOME=/tmp/invite-config`，仅将 Wrangler 日志缓存移到可写位置

- `npm run check`：通过，包含 Wrangler 类型、TypeScript 与 oxlint
- `npm run build`：通过，仅现有客户端大于 500 kB 的体积提示
- `npx vitest run --config development/vitest-pages-node.config.ts`：11 个文件、97 项全部通过；新增两项真实 React Router 渲染检查，覆盖拆页、独立导航及原邮箱编辑器保留；SSR 中仅模拟会话／主题和浏览器标题 portal
- `node development/test-invite-registration-offline.mjs`：6 项 SQLite + 真实 Hono HTTP 聚焦测试全部通过，覆盖 0012 迁移、无用户名生成、免验证码且已验证／可登录、错误验证码被忽略、单次重用拒绝、多次上限、列表／停用／鉴权、插入失败回滚消费与消费记录、旧 KV 链接自定身份、旧开户接口关闭、开放注册仍需正确验证码、邀请白名单与关闭模式
- `node development/test-admin-email-offline.mjs`：1 项通过，复验刚上线的管理员邮箱直改行为
- `node development/test-entitlements-offline.mjs`：10 项通过，包含注册试用及失败回滚
- `node development/test-pages-offline.mjs`：3 项通过
- `node development/test-stage3-offline.mjs`：7 项通过
- `git diff --check`：通过
- Worker 既有测试用例未删除，静态 `it/test` 声明数由 422 增至 426；原邀请码次数／并发用例改为不发送、不提交邮箱验证码，新增免验证登录、插入失败原子性、白名单／开放与关闭模式、旧 KV 链接兼容测试
- Worker SPA fallback 用例扩展检查 `/users`、`/invites`、邀请深链及带码注册路径；更新迁移序号预期为 12
- 非注册测试原本借用旧“只设密码”接口创建账户的 fixture 改用测试专用仓库写入助手，原业务断言与用例数保留；生产没有新增开户入口
- `npm test` 及聚焦 `npm test -- development/tests/worker/d1-registration.test.ts` 已运行尝试，均在 workerd 启动前被沙箱 `listen EPERM 127.0.0.1` 阻挡，未执行 Worker 断言；不能视为全量 Worker 通过
- 集成环境须复跑全量 Worker，尤其 D1 原生并发与存储隔离行为；本次也未执行浏览器端点击／剪贴板 E2E，路由渲染测试与实际管理 HTTP 测试不等同于完整浏览器 E2E
- 初始 node_modules 链接目标只读，TypeScript／Vite 缓存写失败；验证时使用逐依赖符号链接及本地可写缓存目录，未变更依赖版本或 lockfile，交付后恢复原 node_modules 符号链接

## 提交与交付

原工作树逐文件 `git add` 实际报错 `Unable to create .../index.lock: Read-only file system`，因此依照 brief，在 `/tmp/invite-registration-submit` 可写克隆的同名分支 `task/invite-registration-codex` 提交实现、测试与本报告

原工作树保留全部实现和报告供审阅，其只读分支引用仍为基线；最终已提交分支从 bundle 获取，任务 brief 原文件保持未跟踪，不纳入实现提交

交付 bundle 为 `/tmp/invite-registration.bundle`，从可写克隆执行 `git bundle create /tmp/invite-registration.bundle task/invite-registration-codex` 生成，并以 `git bundle verify` 与 `git bundle list-heads` 核对；未使用 `git add -A`，没有 push 或 scp
