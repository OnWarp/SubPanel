# 订阅模型改造报告

基线：`3364e5d`，分支：`task/subscription-model-codex`

## 现状审计

- 创建绑定：`worker/delivery/schema.ts` 的 `subscriptionSchema.userId`、`worker/delivery/service.ts` 的 `SubscriptionInput.userId`、管理端创建请求 schema 原来均要求用户；`assertReferences` 要求用户存在且未软删除。D1 `subscriptions.user_id` 原为 NOT NULL 外键。管理端默认选第一个用户，保存时验证用户必填
- 拉取：`worker/public-subscriptions.ts` 按当前 token hash 查订阅，检查启用状态、归属用户存在且未删除，随后检查用户权益、订阅时间窗、编译缓存版本并按当前权益渲染。原实现无有效权益时提前返回空配置，可能绕过订阅到期判断；本次将到期拒绝放到权益分支之前，未分配订阅始终拒绝
- 到期：`worker/delivery/expiry.ts` 原来仅在拉取时抛出 SUB_EXPIRED，没有持久化禁用。管理端与用户端已有到期徽章，列表没有主动过滤删除。`worker/operations/cron.ts` 原来只刷新远程来源，没有订阅到期清理。未发现自动按订阅到期删除的路径；显式管理员删除、账户永久清除与迁移回滚清理属于其他用途，保留原行为
- 分享：已有 `ShareRecord.expiresAt`（ISO 时间）及 D1 `shares.expires_at TEXT NOT NULL`；`worker/shares/service.ts` 的 guard 在访问时检查到期。入口包括用户端“我的订阅”的 `ShareDrawer` → POST `/api/shares`，管理员分享页原来主要提供列表与禁用/撤销。现有分享数据模型没有 NULL/永久有效期分支，因此没有新增第二套分享表，也不迁移或缩短任何旧分享的有效期
- 计划/配额：Subscription 自身只有归属、分组、令牌、开关、客户端、revision 与时间窗等字段，没有独立的 planId、限额或用量字段。计划、限额及权益属于用户权益服务。本次转移完整保留订阅业务字段，不修改任何计划、权益或用量记录；实际可下发节点仍遵循新归属用户现有权益，这是原有用户权益模型的行为，不会把原用户权益转给目标用户

## 四项落地

1. 创建时 `userId` 可省略或为 null，归一化为未分配。管理端默认“未分配”，列表展示“未分配”或“已分配 · 用户名”，详情显示归属。未分配令牌不可拉取。用户列表中的订阅计数与用户节点类型已兼容空归属
2. 管理端订阅行增加“转移”弹窗，使用已有 `loadAdminUserOptions` 全分页加载用户，允许回收进池。POST `/api/admin/subscriptions/:id/transfer` 校验目标，生成新令牌，将归属与令牌在同一 D1 batch（KV 模式为同一快照写入）保存，清理旧令牌编译产物。公共请求始终检查当前记录，旧缓存无法独立提供旧令牌内容。保留名称、分组、默认客户端、启用状态、生效/到期、创建时间；只改变归属、令牌与变更元数据。复用既有管理员审计中间件，记录目标用户，不记录明文令牌；兼容 delivery 路由别名。转移后原归属的分享亦因现有归属校验失效
3. 管理端订阅行增加“临时分享”，复用用户端同一个 `CreateShareForm`、有效期预设（7/30/90 天或自填天数）、访问控制、分享服务和存储。新增管理员 POST `/api/admin/shares`，以订阅当前归属创建分享；未分配时要求先分配。用户端原入口仍使用 POST `/api/shares`。分享列表原有到期列保留，用户分享抽屉补“已到期”状态，管理员分享列表原有到期状态沿用。到期按每次访问校验，不依赖定时任务删除
4. 新增 `disableExpiredSubscriptions`，在 cron、管理端/用户端订阅列表和公共订阅到期访问时将到期记录持久化为 disabled，增加 revision，保留记录及分组。用户与管理员仍能查看到期记录；拉取拒绝服务。管理员现有编辑弹窗可延期并勾选启用，保存后重新编译恢复。到期订阅仍可转移；未修改 entitlement 到期逻辑

未改变配色或页面布局体系；操作使用现有按钮与 EditDrawer。新增面向用户文案末尾不加句号

## 迁移

- 新增 `migrations/0014_subscription_pool.sql`，未使用 0012/0013
- 重建 subscriptions，使 user_id 可为 NULL，同时保留用户外键、约束与索引
- 先保存 subscription_groups，再重建并恢复，避免删除旧父表时级联丢失分组或顺序
- KV schema、KV→D1 转换、D1 读写和用户锚点同步支持空归属
- 分享复用原 expires_at，无需分享迁移
- Worker 测试迁移注册包含 0014，迁移数量断言由 11 更新为 12
- 部署时需先应用 0014，再启用新版本的空归属写入

## 验证

| 检查 | 结果 |
| --- | --- |
| `XDG_CONFIG_HOME=/tmp/subs-config npm run check` | 通过，类型生成检查、TypeScript、oxlint |
| `XDG_CONFIG_HOME=/tmp/subs-config npm run build` | 通过，保留现有客户端大包体提示 |
| `npx vitest run --config development/vitest-pages-node.config.ts` | 10 文件、95 测试通过；同一基线 3364e5d 在 /tmp 克隆运行也是 10 文件、95 测试通过 |
| `npx vitest run --config development/vitest-subscriptions-node.config.ts` | 新增 2 文件、6 测试通过 |
| `npm test` | 无法启动 Worker pool：`listen EPERM ... 127.0.0.1`；未执行完整 Worker suite，不宣称全量通过或全量基线数量已验证 |
| `git diff --check` | 通过 |

新增聚焦测试实际运行真实订阅/分享服务、KV 序列化与加密、Hono 公共拉取路由；仅以内存 KV 与固定账户/权益依赖替代 Cloudflare 运行时和 D1。覆盖未分配不可用、分配/转移/回收时令牌轮换、业务字段保留、无效目标不变更、精确到期禁用与保留、延期启用恢复、无权益时到期不能绕过、临时分享到期与旧分享不受影响、转移后原归属分享失效。另用 Node SQLite 在外键开启且有存量订阅/分组的数据库上跑 0001–0011 → 0014，验证存量字段和顺序保留、空归属可写、非法用户外键被拒绝与 foreign_key_check 无异常

按原 Worker 测试模式在 `delivery-api.test.ts` 新增三个集成场景，覆盖 D1 空归属创建、双用户转移、旧/新令牌、回收、权益记录不变、审计、管理员临时分享、到期边界、cron 保留禁用及延期恢复；已有到期测试更新为新禁用语义，未删除原测试。由于上述 Worker pool 限制，D1 批处理、真实认证和管理员审计的 Worker 集成测试及浏览器交互未在本沙箱验证，集成环境应重跑 `npm test`

环境处理：原 node_modules 链接指向只读目录，构建工具无法写 .vite-temp/.tmp，已复制依赖到 /tmp 并将本地链接临时指向可写副本后完成验证；该链接不提交。Wrangler 配置/日志定向到 /tmp。既有 KV 后端继续具有自身的跨地区最终一致性；D1 模式下每次拉取查当前归属与令牌，旧 KV 编译缓存不能绕过该检查

## 交付

`.git` 受只读限制，按 brief 在 `/tmp/subscription-model-commit` 可写克隆的同名分支提交；工作区源文件与报告均保留。未添加用户提供的 BRIEF_SUBSCRIPTION_MODEL.md，未提交 node_modules，未使用 `git add -A`，未 push/scp

交付 bundle：`/tmp/subscription-model.bundle`，包含 `task/subscription-model-codex` 分支及其历史；使用 `git bundle verify` 校验。最终提交 ID 见交付消息和该克隆的 `git log -1`
