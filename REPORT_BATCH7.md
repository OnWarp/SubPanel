# Batch 7 报告：个人中心

分支 `task/d1-profile-sub`，基线 `4b585b7`。本批把用户端「我的」与 `/account` 升级为完整个人中心：资料聚合、头像规则、换邮箱、会话信息与退出全部设备。改密码接口为基线既有（第四批前已存在），本批未改其行为，仅在前端个人中心里继续使用并补了会话失效测试。

## 接口清单

新增：

- `GET /api/account/profile`：一次聚合返回 `{ user, emailBound, avatar, session }`。`user` 为 PublicAccountUser（id、username、role、enabled、createdAt、updatedAt、email、emailVerifiedAt）；`session` 为当前会话的签发/过期时间（由当前 Cookie 的 HMAC 载荷解出，秒级 epoch 转 ISO），前端不再拼多个请求
- `POST /api/account/email/change`：已绑邮箱用户向**新邮箱**发 `change_email` 验证码，返回 `{ email, expiresAt }`
- `POST /api/account/email/change/confirm`：验码后替换 email 三列，返回 `{ user }`
- `POST /api/account/logout-all`：session_version + 1 并清当前 Cookie，返回 `{ ok: true }`

未改：`POST /api/account/password`（验旧密码→设新密码→session_version+1→当前会话重新签发）、`POST /api/account/email/bind` 与 `/confirm`（第四批行为原样）、`POST /api/account/logout`、`GET /api/account`。

## 头像种子与回退规则

`worker/accounts/avatar.ts` 的 `resolveAvatar` 在服务端算出描述符 `{ kind, url, seed }`，前端只渲染：

- 种子固定为**用户 id**（`usr_N`），不随任何资料变更而变
- 普通用户：永远 DiceBear `https://api.dicebear.com/9.x/notionists-neutral/svg?seed=<id>`，绑没绑邮箱都一样，无上传入口
- 管理员：已绑邮箱时 Gravatar `https://www.gravatar.com/avatar/<md5(email_normalized)>?s=160`；未绑邮箱回退 DiceBear（同一种子），资料卡同时给出绑定提示
- Gravatar 需要 MD5 而 WebCrypto 不提供，`worker/accounts/md5.ts` 为自研最小实现，已用 RFC 1321 向量（含多块输入）与 Gravatar 官方示例（`myemailaddress@example.com` → `0bc83cb571cd1c50ba6f3e8a78ef1346`）验证

## 换邮箱语义

- 未绑邮箱的用户调 change 返回 409 `EMAIL_NOT_BOUND`，前端按状态自动切到第四批 bind 组件流程（同一组件、按 `emailBound` 选端点）
- 新邮箱与当前相同返回 409 `EMAIL_UNCHANGED`；被他人占用或被他人未消费验证码占用返回 409 `EMAIL_TAKEN`（请求与确认两段都查）
- 验证码发往新邮箱；确认成功即写 email/email_normalized/email_verified_at，旧邮箱即刻不能再登录（测试覆盖新旧地址登录对照）
- 换邮箱不 bump session_version，现有会话保持；只有改密码与退出全部设备动会话版本

## 会话失效语义

会话为无状态 HMAC Cookie，唯一的服务端会话状态是 users.session_version：

- 改密码：session_version+1，其他设备会话全部失效，当前设备由服务端重新签发新版本 Cookie 保持登录（基线既有选择，本批沿用）
- 退出全部设备：session_version+1 且不重新签发，当前 Cookie 同时清除，所有设备（含当前）必须重新登录
- 个人中心展示当前会话签发与过期时间（24 小时 TTL）；登录历史按既定口径不做

## 与第五批契约对齐情况

按前置契约新建 `worker/accounts/email-verification.ts`，导出 `issueVerificationCode` / `verifyVerificationCode`，purpose 为 `'bind_email' | 'change_email'`，换邮箱流程构建在其上。存储形状与第四批 bind 完全一致：验证码 SHA-256 哈希存 email_verifications、10 分钟过期、尝试次数经 rate_limits 计数（bind 沿用 `email_bind_attempt` 桶，change 用 `email_change_attempt` 桶），占用判定同时看 users 与他人的未消费验证码。第四批 email-binding.ts 本批未重构、行为零漂移；第五批可把 bind 也收编到本服务，无需数据迁移。发送仍走 `worker/accounts/email.ts` 的投递器注册口，未注册时为空操作，第五批在此接 SMTP/Resend。`email_change_requests` 表本批未用：占用判定需要跨 bind/change 两条流统一看 email_verifications，分表会留下竞态口子。

## 前端

- 新增共享件：`ProfileCard`（头像＋用户名＋角色＋邮箱状态＋注册时间，管理员未绑邮箱给提示）、`profile.ts`（useAccountProfile 与日期格式化）、`EmailBindChangeForm`（按绑定状态自动选 bind/change 端点的两步验证码表单）
- 「我的」页：顶部换成真实头像资料卡，加会话与安全卡（本次登录/过期时间＋退出全部设备，ConfirmDialog 确认），原有菜单入口（账户安全、我的分享、我的节点、APP 下载、退出登录）保持
- `/account` 页更名为个人中心：资料卡＋修改密码＋绑定/更换邮箱＋会话与安全三段，管理员视角走 Gravatar 分支

## 测试与构建

- 新增 `development/tests/worker/d1-profile.test.ts` 9 条：MD5 向量、头像分支选择（普通用户/管理员未绑/管理员已绑）、profile 聚合（含会话 24 小时窗口）、管理员 Gravatar 端到端、换邮箱成功并迁移登录、未绑/相同/占用/过期四种拒绝、退出全部设备双会话失效、改密后当前会话保持而其他会话失效
- 全量：287 条通过（基线 278＋新增 9），42 个文件通过；唯一失败仍是 `smoke.test.ts` 收集阶段的 `public/_headers` ENOENT 环境问题，与本批无关
- `npm run check` 0 warning 0 error；`npm run build` 通过
