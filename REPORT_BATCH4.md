# Batch 4 报告：账户基础切 D1、双登录、旧账户绑定邮箱

分支 `task/d1-accounts-sub`，基线 `f7226e2`。本批把 accounts（用户、会话校验、登录限流）的线上读写按 `accounts_d1_ready` 标记切到 D1，登录支持用户名/邮箱双通道，并给无邮箱的现有账户加了经验证码确认的绑定邮箱流程。accounts 数据已在 D1（协调者全量迁移完成），本批不写导入器、未置位生产标记。catalog/apps/delivery/shares 的存储行为未改（shares 仅为透传 env 改了一处内部签名，见下）。

## 接口变化清单

内部（worker 内部函数）：
- `readAccounts(kv)` / `writeAccounts(kv, …)` → `readAccounts(env: DataEnv)` / `writeAccounts(env: DataEnv, …)`，与第二批 catalog/apps 的签名变更同型。全部调用点已跟进：`worker/app.ts`（健康检查）、`worker/accounts/{auth,public-routes,admin-routes,account-routes}.ts`、`worker/delivery/service.ts`。
- 新增 `worker/accounts/repository.ts` 导出：`readAccountsKv`、`accountsUseD1`、`findAccountUserById`、`findAccountUserForLogin`。
- 新增 `worker/accounts/d1-repository.ts`：`readAccountsFromD1`、`persistAccountsSnapshot`、`findUserById` / `findUserByUsername` / `findUserByEmailNormalized`、`setUserEmail`、`clearAccountsStorage`。
- 新增 `worker/accounts/rate-limit.ts`：rate_limits 表的固定窗口计数（countWindowHits / recordWindowHit / clearWindowHits）与登录专用封装。
- 新增 `worker/accounts/email.ts`：验证码发送的单一入口 `sendEmailVerificationCode` 与投递器注册点 `setEmailVerificationDeliverer`。
- 新增 `worker/accounts/email-binding.ts`：`requestEmailBind` / `confirmEmailBind`。
- `worker/shares/service.ts`：内部 `guard` / `liveSubscription` 与导出 `verifyShare` 的首参由 `KVNamespace` 改为 `DataEnv`（仅为把 accounts 读取接上切换开关，分享自身存储仍走 KV），`worker/shares/routes.ts` 的一处调用随之改传 `c.env`。**注意与第三批的相邻改动**：第三批会整体重写 shares 存储，合并时这一处以第三批的实现为准即可，本批的改动只是把 accounts 的读取 env 透传进去。
- `worker/db/module-switch.ts` 新增常量 `ACCOUNTS_D1_READY_KEY = 'accounts_d1_ready'` 与 `ACCOUNTS_SETTING_KEYS`（accounts_schema_version / accounts_revision / accounts_updated_at / next_user_id，与 SCHEMA.md 及第一批转换器一致）。

HTTP：
- `POST /api/login`：新增 `identifier` 字段作为单一登录标识（用户名或已绑定邮箱）；原 `username` 字段继续接受并按同一标识处理，现有前端与测试无需改动。错误语义不变（401 INVALID_CREDENTIALS）；新增 D1 模式下的限流 429 TOO_MANY_ATTEMPTS「登录尝试过于频繁，请稍后再试」。
- 新增 `POST /api/account/email/bind`（需登录）：body `{ email }`，返回 `{ email, expiresAt }`。
- 新增 `POST /api/account/email/bind/confirm`（需登录）：body `{ code }`（6 位），返回 `{ user }`（含 email / emailVerifiedAt）。
- 绑定相关错误：409 EMAIL_BIND_UNAVAILABLE（accounts 未切 D1 时）「邮箱绑定暂不可用」、409 EMAIL_ALREADY_BOUND「账户已绑定邮箱」、409 EMAIL_TAKEN「该邮箱已被使用」、400 NO_PENDING_BIND「请先获取验证码」、410 CODE_EXPIRED「验证码已过期」、401 INVALID_CODE「验证码错误」、429 TOO_MANY_ATTEMPTS「验证码尝试次数过多，请重新获取」。文案句末均无句号。

## Accounts Repository（D1 版）设计

- 标记未置位（或 system_settings 表不存在）时走原 KV 快照读写，行为与基线逐字一致；置位后走 D1，不双写。
- D1 读取把快照元数据（schemaVersion/revision/updatedAt/nextUserId）从 system_settings 组装，用户行按 `usr_N` 数字序读出，再过一遍 `accountsSnapshotSchema` 校验，损坏时与 KV 路径同样抛 `Accounts snapshot is corrupt`。空表且无 revision 设置时返回空快照，保证置位后首次读取对现有 2 用户、0 邀请的状态正确（NULL 邮箱在快照形状里不存在，不影响登录）。
- D1 写入是按实体的语句组合（单次 batch 原子提交）：逐用户 upsert、删除快照中已不存在的用户行、回写四个设置键。**upsert 刻意不写 email 三列**——邮箱不在快照形状内，只有绑定流程的 `setUserEmail` 写它们，因此改密码、启停、管理员重置密码等既有写路径不会抹掉已绑定邮箱。
- 密码校验与哈希格式零改动：同一 `verifyPassword`、同一 salt/hash 列映射（与第一批转换器的行形状对齐）。测试中用转换器行形状的原始 SQL 插入了一条 PBKDF2 旧行（100000 迭代、已知口令），经 HTTP 登录验证通过。
- 一个取舍：D1 模式下删除拥有订阅的用户行会被 subscriptions 的外键 RESTRICT 挡下并使整批写入失败（KV 时代无此约束）。当前没有删除用户的接口（用户管理在第八批），本批不处理，留待第八批在删除语义里解决。

## 会话落 D1 的设计与 SCHEMA.md 对应

现行会话是无状态 HMAC 签名 Cookie（payload 含 subject / role / sessionVersion / issuedAt / expiresAt，24 小时），**服务端没有会话存储**，这与 SCHEMA.md 一致：文档没有 sessions 表，会话在存储层的全部状态就是 users 行上的 `session_version` 列（字段对照表有明确映射），外加 crypto 的 sessionKey（属 `system:crypto`，不入 D1，文档「不进表的 KV」已列明）。

因此本批的「会话切 D1」= 会话校验的用户读取接入 accounts Repository 开关：`resolveSessionUser` 改用 `findAccountUserById` 按实体查当前后端（D1 模式单行查询、KV 模式读快照），enabled / role / sessionVersion 三项校验与基线完全一致；登出仍是清 Cookie；改密码仍靠 sessionVersion +1 让旧 Cookie 失效（D1 模式测试覆盖：改密后旧会话 401、新会话 200、登出 200）。与 SCHEMA.md 无偏差。

## 双登录与限流

- 标识解析：先按 username 查（标识 trim + 小写，与原 usernameInputSchema 的规范化一致），未命中再按 email_normalized 查（trim + 小写，与绑定/注册规范化一致）。邮箱大小写混合输入可登录（测试覆盖）。
- 限流现状说明：**基线代码里没有登录限流**（rate_limits 表此前只有 share_verify 一个用途的设计）。按简报「限流落 D1、按账户与来源双维度」的要求，本批新落登录限流，仅 D1 模式启用，KV 模式行为不变：固定窗口 15 分钟，账户维度（规范化标识）失败 10 次、来源维度（cf-connecting-ip）失败 30 次，超限在验密前直接 429；登录成功清账户维度计数。阈值是本批新定的保守值，上线后可按观测调整，报告在此明示以便协调者知情。

## 绑定邮箱与验证码发送现状

- 流程：已登录且 email_verified_at 为空的用户发起绑定 → 邮箱规范化与格式校验 → 占用检查（其他用户的 email_normalized，或其他用户未消费未过期的验证码行，都算占用，409）→ 作废本人旧的待验证行 → 生成 6 位码、SHA-256 哈希后写入 email_verifications（10 分钟过期）→ 发送 → 验码：过期 410、错码 401 并计数、同一验证码行 5 次错码后锁定 429、成功时再次复查占用，单 batch 内标记消费并写 users 的 email / email_normalized / email_verified_at。管理员账户同样适用。
- 验证码以哈希入库（与邀请令牌同等待遇）；6 位码哈希可离线爆破这一点留待第五批在通用验证码设计里改用带密钥的 HMAC，本批按简报的「最小可用实现」执行并在此注明。
- **发送现状**：项目当前没有任何邮件发送设施（无 SMTP/Resend 代码、无邮件设置项）。发送被抽象为 `worker/accounts/email.ts` 的单一函数 `sendEmailVerificationCode`，内部经可注册的投递器 `setEmailVerificationDeliverer` 出站；**第五批接 SMTP/Resend 的位置就是这里**——实现真实投递器并在启动时注册即可，绑定流程与本批代码不用再动。当前未注册投递器时发送为带警告日志的空操作，所以在第五批落地前，绑定流程可走通但用户收不到码（测试通过注册捕获型投递器完成全流程验证）。

## grep 自证

`grep -rn 'env\.DATA\|c\.env\.DATA' worker/accounts/*.ts`（排除 crypto 材料读取后）的剩余命中只有两类，都不是账户状态直读写：
- `worker/accounts/repository.ts` 内的 KV 回退分支（readAccountsKv 与 writeAccounts 的 KV 支路，标记未置位时才执行）；
- `worker/accounts/public-routes.ts` 里 invite:{tokenHash} 邀请键的 get/delete——邀请键属第六批范围，本批未迁，仍走 KV。

auth.ts 的会话校验、public-routes 的登录、admin/account 路由的用户读写全部经 repository 或按实体查找函数，无绕过。

## 测试与构建

- 新增 `development/tests/worker/d1-accounts.test.ts`（6 条）：用户名/邮箱双登录（含大小写混合与 identifier 字段）、错密码与限流（10 次失败后正确口令也 429）、会话生命周期（改密失效旧会话/登出）、绑定全流程负例（错码 401、过期 410、重复绑定 409、他人占用 409）、验证码 5 次错码锁定、迁移旧哈希行登录＋绑定。
- 既有测试的调用点跟进签名变更（assertions 未动）：`accounts-repository.test.ts`、`setup.test.ts` 中 readAccounts/writeAccounts 改传 env。
- 全量：278 条通过（基线 272＋本批 6），`npm run check`、`npm run build` 全绿。唯一失败文件是 `smoke.test.ts` 的套件加载错误（`../../public/_headers` ENOENT），与前几批相同、与本批改动无关，单独计。
