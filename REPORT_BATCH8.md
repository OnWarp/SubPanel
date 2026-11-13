# 第八批报告：管理员用户管理与回收站

基线 4b585b7，分支 task/d1-useradmin-sub。交付：用户列表服务端筛选/分页/计数、用户详情聚合、角色管理（含管理员转移）、重置密码（临时密码一次性展示）、软删除进回收站、恢复、永久删除（purge）级联清理。双模式（D1/KV）行为一致。

## 与简报的两处偏差（先说清）

1. **软删除字段不在 0001 里**。简报称「软删除字段以 migrations/0001_init.sql 的 users 表为准」，但实际核对 0001 与 docs/d1/SCHEMA.md，users 表都没有 deleted_at，第四批也未落该字段。处理：新增 `migrations/0002_user_soft_delete.sql`（`ALTER TABLE users ADD COLUMN deleted_at TEXT` + 索引），不改 0001（生产已应用、不会重跑）。上线时需对生产 D1 执行该迁移（wrangler d1 migrations apply 会按序应用）。测试 helper 改为依次应用 0001+0002，d1-foundation 的迁移断言同步更新为两条（意图不变：全量 schema 应用 + 重放幂等）。
2. **role 语义被单管理员不变量钉死**。users 表有部分唯一索引 `users_single_admin`、快照 superRefine 也强制恰好一名 admin，所以「把 admin 降为 user」与「把 user 升为 admin」都不能单独成立。定版语义：PATCH role=user→admin 是**原子转移**——同一 write 内现任 admin 降为 user、双方 sessionVersion +1（旧会话全灭）；对唯一 admin 的降级/停用一律拒 409 `LAST_ADMIN`（取代旧 PATCH 对 admin 的一刀切 `ADMIN_IMMUTABLE`）；停用中的用户不能被设为管理员（409 `USER_DISABLED`），除非同一次 PATCH 同时启用。

## 最后管理员保护（实现点）

- PATCH /api/admin/users/:id：目标为 admin 且 role→user 或 enabled→false，拒 409 `LAST_ADMIN`（admin-routes，写前校验、基于快照当前状态）。
- DELETE /api/admin/users/:id（软删）：目标为 admin 直接拒 409 `LAST_ADMIN`——单管理员不变量下任何 admin 都是最后一个。
- POST /api/admin/users/:id/purge：已软删是前置（409 `USER_NOT_DELETED`），role=admin 再加一道 409 `LAST_ADMIN` 兜底。
- 转移路径是唯一合法的管理员易手方式，测试覆盖：转移后旧 admin 的会话 401、新 admin 可登录并访问管理区、被降级者仍可作为普通用户登录。

## 软删除的即刻排除（编译/下发路径核对）

逐条核对了所有「按用户取数据」的路径，软删用户（deletedAt 非空）在以下各点被排除，双模式一致：

- **登录**：`findAccountUserForLogin` 两条分支（D1 先 username 后 email_normalized；KV 查 username）对 deleted 用户一律返回 null，登录回 401。
- **会话**：`resolveSessionUser` 新增 `user.deletedAt` 拒绝；叠加软删时 sessionVersion +1，旧 cookie 双重失效。
- **公开订阅下发**：`worker/public-subscriptions.ts` 的 serve() 原先只验订阅本身、不查订阅主——已补：按 subscription.userId 查 owner，owner 不存在或已软删 → 404，与「订阅不存在」同码不泄露状态。已缓存的 compiled 产物因此即刻失效（产物仍在 KV 但不再下发），恢复后自动恢复下发（测试实证 200→404→200）。
- **分享校验**：`worker/shares/service.ts` 的 guard 已有 owner.enabled 检查，补上 `owner.deletedAt` 一并按无效处理。
- **新建订阅**：`worker/delivery/service.ts` 的 assertReferences 已软删用户按 USER_NOT_FOUND 拒。
- **邀请**：软删行仍留在快照/表中，用户名与邮箱唯一性继续占用——同名邀请创建 409，无法冒名重注册（测试覆盖）。
- 未改动的一点（按简报范围）：**停用（enabled=false）用户的已有订阅仍照常下发**，与基线行为一致，本批只处理软删排除。

## purge 级联清单（按外键顺序，同一 D1 batch）

前置：用户必须已在回收站。D1 侧顺序（shares 对 owner 与 subscription 都是 RESTRICT，必须最先）：

1. `shares`：owner_user_id = 该用户，或 subscription_id ∈ 其订阅
2. `subscription_groups`：其订阅的分组链接
3. `subscriptions`：其全部订阅（同时先读出 token_hash 列表）
4. `invitation_redemptions`：user_id = 该用户，或 invitation_id ∈ 其创建的 invitations
5. `invitations`：user_id = 该用户（其创建的邀请；invitations.user_id 无外键、靠这一步清理）
6. `email_verifications`（user_id）与 `email_change_requests`（user_id）——表本身是 CASCADE，仍显式删除，不依赖外键执法开关
7. `rate_limits`：subject ∈ {用户名, 邮箱归一形}（登录限流残留）
8. `users` 行本身

简报清单未列 shares 与 invitations/redemptions 的连带删除，是外键 RESTRICT 逼出来的必然补项。第 4、5 步会连带删掉「他人兑换该用户所建邀请」的消费记录与「该用户兑换他人邀请」的记录，语义上与「邀请消费记录一并删除」一致。

跨存储清理（同一次请求内）：D1 订阅的 token_hash → 删 KV `compiled:` 产物；KV 残留（混合模式窗口）一并扫：delivery 快照中该用户的订阅移除并删其 compiled 产物；KV 分享记录按 owner 或 subscriptionId 命中后走 removeShare 全套清理（记录+双索引+compiled）。KV 模式 purge 只走 KV 侧同等清理。最后写回 accounts 快照移除用户行（D1 模式靠 persist 的差集删除落库，此时外键已清干净）。purge 后用户名与邮箱立即释放，可重新邀请同名（测试覆盖），再 purge 回 404。

## 接口与前端

- GET /api/admin/users：新增 q（用户名/邮箱子串，大小写不敏感）、role、status（enabled/disabled）、deleted（缺省 active / only / all）、page/pageSize（缺省 1/20，上限 100）；响应在原 `{ users }` 上增加 total/page/pageSize（向后兼容，SubscriptionsPage 等旧消费方不受影响）。D1 模式计数走一条 LEFT JOIN subscriptions 的聚合 SQL，无 N+1；KV 模式单次读 delivery 快照计数。响应行含 email、emailVerifiedAt、deletedAt、subscriptionCount（KV 模式用户无邮箱列，email 字段缺省）。
- GET /api/admin/users/:id：`{ user（含订阅数）, subscriptions, invitationRedemptions }`；订阅含 groupIds；KV 模式消费记录恒为空数组（KV 兑换后即删邀请、无记录）。
- POST /api/admin/users/:id/reset-password：简报口径新接口，与旧 POST /users/:id/password 同守卫（admin 自助拦截、已软删拒），响应多回 `temporaryPassword` 明文一次；旧接口保留兼容。前端改调新接口，成功后在弹窗内一次性展示临时密码并可复制，关弹窗即消失。
- 前端 UsersPage：用户/回收站页签、服务端搜索与分页（Pagination 组件）、邮箱列、行内动作补设为管理员（确认框写明转移后果）、移入回收站（确认框写明即刻停登停发）、回收站内恢复与永久删除（确认框写明连带删除范围与不可恢复）；邀请区未动。新增文案均无句末句号。

## 测试

新增 development/tests/worker/d1-admin-users.test.ts 共 7 条：列表筛选/分页/计数与详情聚合（含邀请消费记录）、最后管理员四路保护、角色转移与双向会话失效、软删后登录/会话/公开下发三路排除与恢复回归、purge 全级联逐表清零 + KV 侧订阅/compiled/分享清理 + 用户名释放 + 前置 409/重复 404、reset-password 一次性明文与会话轮换 + 旧接口兼容、KV 模式软删/回收/purge 同等行为。

结果：全量 285 条通过（基线 278 + 新增 7），唯一失败文件 smoke.test.ts 是既有环境问题（读 ../../public/_headers ENOENT，简报已除外）。`npm run check` 0 warning 0 error，`npm run build` 通过。
