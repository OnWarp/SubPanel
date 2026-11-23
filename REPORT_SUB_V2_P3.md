# SubPanel 订阅系统 V2 · P3 交付报告

交付分支 `task/sub-v2-p3`，基底为本地跟踪的 `origin/main` `c78fbc4d32189fc86025edef75a83becbbd6d582`。Git 身份为 Muse / muse@outtw.com。生产迁移与发布由集成方执行，本阶段使用隔离的本地 D1、KV 和 Worker

## 功能与接口

- 管理员从订阅管理页的「兑换码管理」按钮进入独立页面 `/delivery/redemptions`。页面支持批次搜索与分页、创建、停用、尾码分页、单码作废、兑换记录及批次审计。已有一级导航保持原结构。P2 的兑换码占位页签由页面入口按钮替代
- 创建批次时选择启用且允许兑换的模板和固定版本，配置数量、兑换截止时间、每码次数和备注。每码默认一次，每账户对同一码最多兑换一次。已发行批次继续引用同一不可变权益版本，模板发布新版本、停用或归档均不改变该批次权益
- 个人中心 `/me` 提供权益预览、确认、兑换历史及多订阅列表，显示每份订阅的状态、到期时间、流量额度和节点策略。可以复制允许的链接或跳转到已有单份订阅管理，继续使用平台切换、分享及凭据轮换功能。流量计量沿用 P1 语义
- `GET/POST /api/admin/redemption-batches` 管理批次。批次详情、尾码列表和审计分别使用 `GET /api/admin/redemption-batches/:id`、`/:id/codes`、`/:id/audit`。停用使用 `POST /api/admin/redemption-batches/:id/disable`，作废使用 `POST /api/admin/redemption-codes/:id/revoke`，兑换流水使用 `GET /api/admin/redemption-records`
- `POST /api/me/redemptions/preview` 接收兑换码，只返回模板显示名、期限、额度、节点策略类别和短期确认凭据。确认使用 `POST /api/me/redemptions`，提交兑换码、确认凭据和 UUID 幂等键，返回新订阅 ID、名称和到期时间。本人历史使用 `GET /api/me/redemptions`。接口复用会话、RBAC、同源校验、错误结构和 `no-store`，订阅链接由既有本人订阅接口提供
- 过期、用尽、作废、停用、已被本人兑换及无效码共用 `REDEMPTION_CODE_UNAVAILABLE`。预览凭据绑定当前账户和对应码，5 分钟有效，预览不扣次数。批次停用、码作废和码到期只限制后续兑换

## D1 原子性、幂等及限流

- `createSubscription` 共用已有实例配置校验、UTC 到期计算、随机 token、D1 列映射和订阅快照写入。兑换记录关联批次版本作为来源追溯，订阅行及节点映射持有实际生效配置。管理端常规模板发放继续走现有最新版本守护
- 订阅、凭据、扣次数、流水和审计由同一个 `D1.batch()` 提交。扣次数的条件 UPDATE 在库内核验码和批次状态、D1 时钟、额度、账户有效性及单账户限制。紧接的流水 INSERT 检查 UPDATE 的 `changes() = 1`，否则以约束错误使整批回滚。审计写入失败也回滚发放。共享订阅修订发生冲突时有界重试
- D1 的 `UNIQUE(user_id, idempotency_key)` 和 `UNIQUE(code_id, user_id)` 分别防护请求重放和账户复兑。幂等重试返回初次的收据，另有码复用同一请求键返回 409。用于验证相同重试的 HMAC 校验值独立于轮换后的签发密钥，原确认请求在旧密钥移除后仍可重放收据。订阅删除后保留原发放收据，详情访问仍由订阅当前所有权决定
- 单批最多 500 码，按每 50 码分块生成和写入，一次 D1 提交。每管理员每小时最多 5 次生成请求，每码最多 100 次。明文仅由首次成功生成响应下发一次，重复请求键不会产生新批次或释放明文。UI 在首次响应内显示完整码并允许一次 CSV 下载，审计记载服务端释放事件
- 预览和确认共用 D1 固定窗口计数，每账户每 10 分钟 20 次，可信连接 IP 每 10 分钟 80 次，IP 缺失时用会话身份退回。全局请求上限每分钟 1,200 次，全局无效和失败码阈值每分钟 300 次。达到限额返回 429。限流计数用带上限的原子 UPSERT，过期的 P3 窗口随请求做有界清理

## HMAC 密钥与轮换

- Workers Secret 名为 `REDEMPTION_HMAC_KEYS`。内容为 JSON 对象，字段 `active` 是当前版本，`keys` 为从版本名到无填充 base64url 编码密钥的映射。每个版本使用独立的 256 bit CSPRNG 密钥，版本名为 1 到 16 位小写字母或数字，最多同时载入四个版本
- 每个兑换码为 28 个独立等概率字符，从 30 个无歧义符号用拒绝采样产生，约 137 bit 随机熵。显示为七组四字符。D1 保存 HMAC-SHA256 摘要、`digest_key_version` 和四位尾码。预览和确认仅从同源 JSON 请求接收完整码，响应校验错误不回显输入，审计只持有标识和计数
- 首次上线先在 Workers secrets 中配置当前版本。轮换时先把新版本加入密钥映射，再切换 `active`。新批次只用新版本签发，旧版本在重叠期仍可查验。按旧密钥版本对照启用批次和截止时间，等可兑换的旧码全部过期、用尽、停用或作废后再删除旧密钥。精确重放已成功的确认仍能返回原收据。每次轮换使用全新的版本名

## 迁移与本地差异

`migrations/0023_subscription_v2_p3.sql` 仅新增三张表、六个显式索引及一个触发器。节点组仍被可用码引用时拒绝删除，避免模板更新后旧发行码失去节点组。既有结构无改写，迁移不回填旧订阅

用 0022 本地数据库加一条历史订阅、一条归属、一条节点组映射及其来源记录制作基线。两次本地 Wrangler 执行都成功。dry-run 基于只读输入复制到内存，逐表比较原有行及结构，对账不输出凭据。旧结构和原有行均无差异，新增外键违规 0，重放和实际本地执行结果均与模拟一致。详见 [dry-run 差异 JSON](docs/subscription-v2-p3-dry-run.json)

```bash
wrangler d1 execute DB --local --persist-to /path/to/local-state --file migrations/0023_subscription_v2_p3.sql
python3 development/scripts/subscription-v2-p3-migration.py --dry-run /path/to/before.sqlite --compare /path/to/after.sqlite
```

## 验证

| 验证 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误 |
| `npm run build` | 通过，Worker 约 1,099 KB，客户端主 JS 约 683 KB。保留 Vite 大代码块和 Node `punycode` 弃用提示 |
| `CI=1 npm test` | 64 个文件，548 项全部通过 |
| `CI=1 npx vitest run --config development/vitest-pages-node.config.ts` | 15 个文件，229 项全部通过 |
| Playwright 与真实本地 Worker | 验证管理端生成和单次 CSV 导出、尾码、作废、停用、审计，及 390 px 用户预览、确认、复制、历史和新订阅详情 |

- **原子性**。10 个不同账户先预览同一个单次码，再并发确认，恰好一次 200，另九次统一 422。数据库只有一次扣次数、一份独立订阅、一条流水和一条成功审计。对成功请求并行重试 5 次只返回原收据。另验同账户并发重放、不同幂等键复兑、审计故障整批回滚、过期边界、跨用户与管理权限、模板停用和密钥轮换
- **旧链接与格式**。同一既有订阅在兑换前后用原 token 拉取 18 条自动识别、显式格式和别名路径。18 条均为 200，正文摘要、MIME、下载文件名和 ETag 保持一致。Worker 套件覆盖条件 304、到期和旧计划兼容
- **视觉**。两页在 1440 px、1024 px 和 390 px 使用真实本地数据验证。1024 px 覆盖系统暗色，390 px 使用分行展示操作与状态。截图中仅包含本地夹具与掩码尾码

| 页面 | 1440 px | 1024 px | 390 px |
| --- | --- | --- | --- |
| 兑换码管理 | [桌面](development/screenshots/sub-v2-p3/admin-1440.png) | [笔记本](development/screenshots/sub-v2-p3/admin-1024.png) | [移动](development/screenshots/sub-v2-p3/admin-390.png) |
| 个人中心 | [桌面](development/screenshots/sub-v2-p3/personal-1440.png) | [笔记本](development/screenshots/sub-v2-p3/personal-1024.png) | [移动](development/screenshots/sub-v2-p3/personal-390.png) |

## 文件

| 位置 | 内容 |
| --- | --- |
| `worker/redemption/{credentials,limits,service,routes}.ts` | 生成、密钥轮换、限流、批次与管理操作、预览及确认 |
| `worker/delivery/{service,repository,d1-repository,entitlement-templates,schema,routes}.ts` | 统一订阅创建、原子扩展、来源、版本引用计数及节点策略摘要 |
| `worker/{app,app-env}.ts`、`worker/admin/audit.ts`、`worker/catalog/repository.ts` | 路由与 secret 类型、事务内审计、可用码引用保护 |
| `src/features/redemption/`、`src/features/user/MinePage.tsx`、`src/features/delivery/{SubscriptionsPage,MySubscriptionsPage,EntitlementTemplatesPanel}.tsx` | 管理页、个人中心、订阅详情入口及占位页移除 |
| `src/app/{api,navigation,router}.*`、`src/styles/pages-delivery.css` | DTO 类型、导航路由与响应式布局 |
| `migrations/0023_subscription_v2_p3.sql`、`development/scripts/subscription-v2-p3-migration.py`、`docs/subscription-v2-p3-dry-run.json` | 单文件迁移、只读对账和差异证据 |
| `development/tests/worker/{d1,subscription-v2-p3.test,d1-foundation.test}.ts`、`development/tests/ui/navigation-structure.test.ts`、`development/test-sub-v2-p3.mjs`、`development/screenshots/sub-v2-p3/` | D1 台账、并发与故障注入、导航及浏览器回归 |

## 上线、风险与回滚

1. 集成方先备份生产 D1，用离线副本跑 dry-run，确认 D1 订阅和目录模块已就绪，安装 `REDEMPTION_HMAC_KEYS`。生产 D1 的迁移台账为空，使用 `wrangler d1 execute DB --remote --file migrations/0023_subscription_v2_p3.sql` 单文件执行后再发布 Worker。生产禁用 `migrations apply --remote`。本阶段未连接或写入生产 D1
2. 生成批次一经提交便只释放一次完整码，若成功响应在网络中丢失，管理员需要先确认并停用无法交付的批次，再另建批次。D1 保留创建和释放记录用于核对
3. 已发行版本若包含后来禁用或移除的指定节点，新发放会沿用 P2 的节点有效性校验并拒绝发放，扣次数与发放同时回滚。运营可停用该批次并从已修订的模板版本重新签发
4. 兑换沿用 P1 的订阅快照写入和修订保护，并行写入不同订阅时仍可能引发 409。生产规模、全局限流阈值和大体量写入成本留待 P4 测量
5. 紧急回滚时切换 Worker 到 `c78fbc4`，保留 0023、新订阅、密钥和审计记录。回退期间兑换 UI 和接口暂停，已兑换的独立订阅继续使用现有订阅行、节点配置和 token。旧 Worker 不读取兑换来源，前台显示会按旧来源逻辑处理。触发器仍保护可用批次引用的分组。恢复 P3 时使用原密钥映射并复查批次与到期时间

交付物为 `/data/tmp/sub-v2-p3.bundle`

SUB_V2_P3_DONE
