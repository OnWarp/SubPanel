# D1 第六批报告：注册与邀请

基线 4b585b7，分支 task/d1-registration-sub。实现公开注册（邮箱验证码）、三档注册模式、邮箱域名白名单、通用邀请码（单码多次＋批量独立码），邀请码消费与建号在同一个 D1 batch 内原子完成。

## 交付内容

公开接口（worker/accounts/registration-routes.ts，挂 /api）：

- `GET /api/register/config` → `{ mode }`，供注册页/登录页感知模式（新增，简报外但前端模式感知必需）。accounts 未切 D1 时恒为 closed。
- `POST /api/register/send-code`：校验模式（closed → 403 REGISTRATION_CLOSED）、域名白名单（403 EMAIL_DOMAIN_NOT_ALLOWED）后发 register 用途验证码；同一邮箱 1 小时最多 5 次（rate_limits bucket `register_send`）；**邮箱已注册时返回同样的 200 形状但不发码**，防枚举。
- `POST /api/register`：验码＋（邀请模式）验邀请码 → 原子建号 → 直接发会话 Cookie 登录（201，返回公开用户对象）。

管理员接口（挂 /api/admin，走既有 requireAuth＋requireAdmin＋CSRF）：

- `POST /api/admin/invitations` `{ type: 'multi'|'batch', maxUses?, expiresAt?, count? }` → 明文码**仅此一次**出现在响应里；`GET /api/admin/invitations` 只回前缀（前 8 字符）、用量与剩余次数，绝不回明文与哈希；`DELETE /api/admin/invitations/:id` 禁用该码（见偏差 2）。
- `GET/POST/DELETE /api/admin/email-domains[/:domain]`：白名单维护（域名小写归一，重复 409 DOMAIN_EXISTS，删除不存在 404 DOMAIN_NOT_FOUND）。白名单非空时仅表中域名可注册，空表＝不限制。

前端：新增 RegisterPage（/register 路由，与登录页同一守卫）：按 config 显示关闭说明 / 邀请码字段，发送验证码带 60 秒倒计时，注册成功 refresh 会话后回首页；LoginPage 在模式非 closed 时显示「立即注册」入口（config 读取失败时不显示）。

## 设置键

- 注册模式：既有 system_settings 键 `registration_mode`（closed/invite/open），读写走既有 getRegistrationMode/putRegistrationMode。**默认值按简报倾向从 'invite' 改为 'closed'**（settings-repository 的 DEFAULT_REGISTRATION_MODE）；生产当前无该键，部署后即 closed，开放时机由协调者写入该键决定。
- 域名白名单：新表 `allowed_email_domains`（migrations/0002），不占 settings 键。

## 原子建号 batch 的语句组成（worker/accounts/registration.ts 的 registerUser）

建号前先做咨询性预检（用户名/邮箱占用、邀请码可用性、验证码 verify，均不落盘），真正的消费与建号只在下面一个 `db.batch()` 里（任一失败整体回滚）：

- S1 消费验证码：`UPDATE email_verifications SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`（条件更新，重复提交时第二份必然 0 行）。
- S2（仅邀请模式）消费邀请码：`UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ? AND disabled = 0 AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR used_count < max_uses)`。
- S3 建号：`INSERT INTO users (...) SELECT ... WHERE (SELECT changes()) = 1 AND EXISTS (SELECT 1 FROM email_verifications WHERE id = ? AND consumed_at = 本批时间)`。changes() 是紧邻上一条语句（邀请模式＝S2，开放模式＝S1）的受影响行数，任一消费没真正发生，这条就插不进去；用户名/邮箱唯一索引（见迁移）再兜一层。users 的 email 三列与 email_verified_at 在此写入。
- S4（仅邀请模式）兑换记录：`INSERT INTO invite_code_redemptions SELECT ... WHERE (SELECT changes()) = 1`，changes() 此时是 S3 的行数，保证兑换记录只在**本批**建号成功时写入（并发输家与赢家推导出同一个 next user id，无条件插入会把兑换记录误挂到赢家的用户上并已提交——并发用例实测抓到并已按此修复）。
- S5 accounts 元数据：upsert next_user_id＋1、revision＋1、updated_at（既有 upsertSettingStatement）。

批后校验 S3 的 meta.changes＝1，否则按邀请码最新状态/用户名/邮箱占用诊断出明确错误（409 INVITE_CODE_EXHAUSTED / USERNAME_TAKEN / EMAIL_TAKEN 等）；批次抛错时走同样的诊断路径。

## 迁移 0002（migrations/0002_registration.sql，尚未应用生产）

- 新表 `invite_codes`（token_hash UNIQUE 存 SHA-256 哈希、token_prefix、type multi/single、max_uses 可空＝不限、used_count、expires_at 可空、disabled、created_by、created_at）与 `invite_code_redemptions`（(code_id, user_id) 主键、外键 RESTRICT）与 `allowed_email_domains`。
- 重建 `email_verifications`：user_id 改为可空（注册码没有用户），新增 purpose 列（默认 'bind' 兼容第四批既有行），其余列与索引保持。第四批的绑定流程读写不受影响（其代码按 user_id 查询，新列有默认值）。
- 给 users 补 `username` 唯一索引与 `email_normalized` 部分唯一索引（WHERE email_normalized IS NOT NULL）——0001 时代缺失，原子建号靠它兜底。

## 与第五批的契约对齐

新建 worker/accounts/email-verification.ts（基线无此文件，按简报前置契约先建最小实现）：导出 `issueVerificationCode(db, { email, purpose }, now?)` 与 `verifyVerificationCode(db, { email, purpose, code }, now?)`，purpose ∈ 'register' | 'bind' | 'reset'。6 位码、SHA-256 哈希入库（与平台 hashToken 同一函数）、10 分钟过期、同一邮箱＋用途的新码取代旧码、错码计数走 rate_limits（窗口起点＝验证码 created_at，5 次锁定）、单次消费。发送仍经第四批的 email.ts 投递抽象（setEmailVerificationDeliverer），第五批替换传输实现时本文件接口不变。

与字面契约的两点扩展（都是为原子性服务）：verify 只校验**不消费**，返回 `{ ok: true, verificationId }`；消费由导出的 `consumeVerificationStatement` 作为 batch 语句完成。另导出 `clearVerificationAttempts` 供成功路径清计数（注册路径在批后调用）。

## 偏差与说明

1. **邀请码用新表而非 0001 的 invitations 表**：旧表是「预建账户＋一次性令牌」的旧模型（id 即令牌哈希、绑 user_id 与 username），承载不了通用邀请码；旧的 KV 邀请链接流程（/api/invites/:token、/api/admin/invites）原样保留、未改动，两条线并存。
2. **DELETE 邀请码＝禁用而非物理删除**：兑换记录外键 RESTRICT，物理删除会破坏历史；禁用后列表带 disabled 标记、不可再兑换。
3. **注册成功即登录**（发会话 Cookie），与首次设置流程一致。
4. 注册的密码哈希在 batch 外先算（PBKDF2 较慢），batch 内只落结果。

## 测试与验收

- 新增 development/tests/worker/d1-registration.test.ts 共 13 条：默认 closed 拒绝、三模式流转、白名单拦截与管理员维护、非管理员拒绝、单码多次到上限、批量码单次使用、禁用/过期码、验证码错码/过期/5 次锁定、已注册邮箱防枚举、注册后用户名与邮箱双登录、**并发同码双提交只成一号**（断言 users 数、used_count、兑换记录数）、**并发同资料重复提交只成一号**。
- 全量：291 条通过（基线 278＋新增 13），唯一失败文件仍是 smoke.test.ts 的套件加载（../../public/_headers ENOENT，盒子环境既有问题，与本批无关）。
- `npm run check`、`npm run build` 均退出码 0（oxlint 0 警告）。

## 待协调者处理

- 部署前把 0002 应用到生产 D1（subpanel-d1）；部署后 registration_mode 默认 closed，按 Roye 决定再置 invite/open；如需白名单，用管理员接口录入域名。
