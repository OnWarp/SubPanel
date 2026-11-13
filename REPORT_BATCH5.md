# D1 第五批报告：邮件与验证码基础设施

基线 4b585b7，分支 task/d1-mail-sub。交付：统一验证码服务（四用途）、邮件发送层（SMTP＋Resend 双 provider）、找回密码两接口、管理员测试发信接口；第四批邮箱绑定的发码/验码已切换到新服务，行为与错误码不变，第四批测试全部继续通过。

## 交付文件

新增：

- `worker/accounts/email-verification.ts`：统一验证码服务，共同契约见下节
- `worker/accounts/mail-smtp.ts`：基于 `cloudflare:sockets` 的 SMTP 提交客户端
- `migrations/0002_email_verification_purpose.sql`：email_verifications 表重建（加 purpose 列、user_id 改可空）
- `development/tests/worker/d1-mail.test.ts`：21 条新测试

修改：

- `worker/accounts/email.ts`：重写为完整邮件基础设施（配置解析、模板、发送、测试发信），保留既有投递器注册接口
- `worker/accounts/email-binding.ts`：bind/confirm 改走统一服务（错误分型经服务的 findPendingVerification 完成）
- `worker/accounts/public-routes.ts`：新增 POST /api/password/forgot、POST /api/password/reset
- `worker/accounts/admin-routes.ts`：新增 POST /api/admin/mail/test
- `worker/db/settings-repository.ts`：新增 MAIL_SETTING_KEYS 常量
- `worker/app-env.ts`：Env 增加 RESEND_API_KEY／SMTP_URL／MAIL_FROM 三个可选 Secrets
- `development/tests/worker/d1.ts`：测试夹具的模式包含 0002（见「实现说明」第 2 条）

## 共同契约（第六、七批按此对接，签名与简报一致未改）

- `issueVerificationCode(db, { email, purpose, userId? }): Promise<{ expiresAt }>`：发码并发送邮件；同邮箱同用途有未过期码且距上次发送不足 60 秒时抛 429 CODE_TOO_SOON；发新码先作废同邮箱同用途的未消费旧码
- `verifyVerificationCode(db, { email, purpose, code }): Promise<boolean>`：验对即消费（单次有效）；错码累计 5 次后锁定，之后连对码也抛 429 TOO_MANY_ATTEMPTS；无码/已过期/已消费返回 false
- `VerificationPurpose = 'register' | 'bind_email' | 'change_email' | 'reset_password'`
- 另有辅助导出 `findPendingVerification(db, { purpose, email? | userId? })`：取某用途最新未消费记录（含过期记录），供路由区分「未申请 400／已过期 410／码错 401」；`setVerificationCodeSecret()` 为测试覆盖钩子（同 email.ts 投递器注册的模式）
- 存储：6 位码、10 分钟有效；只存 HMAC 哈希——密钥由 SESSION_KEY 经 HKDF-SHA-256 派生（info `subpanel:email-verification-code:v1`），哈希输入含 purpose 与规范化邮箱。密钥解析顺序：测试覆盖 → SESSION_KEY Secret → crypto 材料（Secrets 优先、KV system:crypto 回退，与现有 readCryptoMaterial 一致）

## 实现说明与取舍

1. **为什么要 0002 迁移**：0001 的 email_verifications 没有 purpose 列，且 user_id 是 NOT NULL 外键——register 的码在建号前发出、无用户可挂。0002 重建表：purpose 带 CHECK（四用途、默认 'bind_email'）、user_id 改可空、加 (email_normalized, purpose) 索引；存量行按 bind_email 迁入。部署时 wrangler 按序应用，生产自动升级。注意：第四批用明文 SHA-256 存的码与新 HMAC 哈希不兼容，未消费的绑定码会在部署后失效（10 分钟内自然过期，影响面仅限正在绑定中的用户重新获取一次）
2. **测试夹具的处理**：第一批的 d1-foundation 测试钉死了 d1_migrations 只能有一行（0001）。夹具的 initMigration 因此把 0002 的语句并入 0001 名下执行（测试库直接得到最终模式），同时导出 baseInitMigration 与 emailVerificationPurposeMigration，新测试里有专门一条走「先 0001 建库＋塞旧行 → 应用 0002 → 行保留且 purpose=bind_email」的真实升级路径。生产路径不受影响（wrangler 用真实迁移文件）
3. **重发冷却语义**：只有「上一枚码仍未过期且发送不足 60 秒」才触发 429；已过期的残留码不挡重发——这是第四批既有测试（把码改过期后立即重绑须成功）的硬约束，精确化后写进本批测试
4. **错码计数**：复用 rate_limits 表，新 bucket `email_code_attempt`，subject 为验证码行 id、窗口起点为行创建时间（沿用第四批方案，计数随码过期自然失效）
5. **SMTP 客户端**：465 端口隐式 TLS；其余端口服务器宣告 STARTTLS 时升级，未宣告且配了账号密码时拒绝明文发信（无凭据的本地中继才允许明文）；仅 AUTH LOGIN；MIME multipart/alternative（纯文本＋HTML 双 part、base64、主题 RFC 2047 编码）；单命令 15 秒超时。AUTH PLAIN/CRAM-MD5 中继不在支持范围
6. **配置解析顺序**（resolveMailConfig）：环境 Secrets（RESEND_API_KEY → Resend；SMTP_URL → SMTP）优先，其次 system_settings 的 mail_* 键（MAIL_SETTING_KEYS：mail_provider、mail_from、mail_smtp_host、mail_smtp_port、mail_smtp_user、mail_smtp_pass、mail_resend_api_key）；发件人 MAIL_FROM Secret 优先于 mail_from 设置。任一路径下配置不完整或非法（provider 未知、from 非邮箱、port 越界、SMTP 账号密码不成对）即视为未配置并记日志，发送返回 `{ ok: false, provider: null }`，不抛错。第九批设置页写这些键即可生效
7. **验证码邮件模板**：中英双语，纯文本＋简单 HTML 两版；含用途行（注册账号/绑定邮箱/更换邮箱/重置密码）与 10 分钟有效提示；文案最后一句末尾无句号（全局文案规范）。有用户名时带称呼
8. **找回密码**：forgot 恒回 200 `{ ok: true }` 防枚举——未知邮箱、未绑定邮箱、KV 模式都同形；仅 D1 模式且用户存在且邮箱已验证才发码。限流走 rate_limits：来源（cf-connecting-ip）20 次/小时超限回 429；单邮箱 5 次/小时超限静默跳过；冷却错误在 forgot 内吞掉（不泄露邮箱存在性）。reset 校验顺序：D1 门（409 PASSWORD_RESET_UNAVAILABLE）→ 无待验记录 401 INVALID_CODE → 过期 410 CODE_EXPIRED → 验码（含 5 次锁定 429）→ 改密（PBKDF2）并 session_version+1（旧会话全失效）、清该用户登录失败计数（用户名与邮箱两个键）
9. **管理员测试发信**：POST /api/admin/mail/test `{ email }`，挂既有 /api/admin 中间件（requireAuth＋requireAdmin）；回 200 `{ ok, provider, error? }`，未配置时为 `{ ok: false, provider: null, error: '邮件服务未配置' }`，发送失败也以数据返回不抛错
10. **出站纪律**：全部发信只由用户动作触发（绑邮箱、找回密码、管理员测试），单封单发；sendMail 内部失败最多重试 1 次；无任何定时/循环发信

## 验证结果

- `npm run check`：通过（wrangler types、tsc、oxlint 0 错误 0 警告）
- `npm test`：299/299 通过——基线 278 条零回退（含第四批 d1-accounts 全部测试），新增 21 条全过（服务单测 9：发放/单次消费、错码、5 次锁定、过期、冷却、作废旧码、用途隔离、HMAC 存储与无用户发码、0002 升级路径；配置与发送 6：未配置空操作、SMTP_URL Secret 优先、settings SMTP 回退、settings Resend、非法 port 拒绝、Resend 发送请求形状；找回密码 4：防枚举、完整重置＋旧会话失效、过期 410、KV 模式惰性；管理员测试发信 2：权限三态中的未登录 401＋非管理员 403、未配置返回数据）
- 唯一失败套件为 smoke.test.ts 的 `../../public/_headers` ENOENT，是 worktree 环境的既有问题（基线同样失败），按简报口径除外
- `npm run build`：通过

## 遗留与后续批次注意

- 生产尚未配置任何邮件凭据（RESEND_API_KEY／SMTP_URL／MAIL_FROM Secrets 与 mail_* 设置均为空）：上线后发信为空操作，找回密码对任何邮箱都只回 200 不发码（且当前生产用户都还没有已验证邮箱，绑定流程本身也不发不出码）。配好 Secrets 或等第九批设置页落地后即生效，无需改代码
- 第六批注册、第七批换邮箱直接调 issueVerificationCode/verifyVerificationCode（purpose 分别为 register/change_email）；注册场景 userId 不传，行 user_id 为 NULL
- 第九批设置页写邮件设置时用 MAIL_SETTING_KEYS 的键名；SMTP 密码以 settings 值存储（与现行 system_settings 的敏感键处理方式一致）
