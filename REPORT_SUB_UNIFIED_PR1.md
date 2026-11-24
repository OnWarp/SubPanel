# 统一订阅 PR1 · 依赖盘点、迁移预检与目标 schema

## 基线与范围

- 仓库 `onwarp/SubPanel`，分支 `task/sub-unified-pr1`。开工时 HEAD、本地 `origin/main`、`git ls-remote origin refs/heads/main` 均为 `7b6921e5fccddb95bab8d14842aedd68c02484c4`。方案所引用的旧对象不作为盘点基底。
- 交付仅此报告，附录 SQL 为设计草案。未连接生产数据面，未自行执行 D1 迁移或采集生产样本。生产行数、实际输出、备份点与恢复结果由集成协调员在授权环境核验。生产切换当前为 **NO-GO**，主要阻断是 §5.1 和逐条映射尚未验证。

## 1. 代码、路由和存储依赖

附录 C 给出固定提交的逐文件逐行引用索引，覆盖 Worker、前端、测试、脚本、SQL、文档及配置。下表给出迁移时需要追踪的间接调用与持久化边界。

| 边界 | 证据与迁移影响 |
|---|---|
| 路由挂载与别名 | `worker/app.ts:41–106`。管理订阅挂载在 `/api/admin/subscriptions`、`/api/admin/delivery/subscriptions`、`/api/admin/delivery`；用户挂载在 `/api/account/subscriptions`、`/api/account/delivery/subscriptions`、`/api/account/delivery`、`/api/me/subscriptions`、`/api/subscriptions`、`/api/user/subscriptions`。`worker/delivery/routes.ts:309–450` 含列表、输出预览、创建、详情、修改和删除、两个重置后缀。复制、转移须连同批量入口一起核对。 |
| 相邻 API | `worker/app.ts:46–106`。覆盖 `/api/me/redemptions`、管理兑换及计划、账户计划、用户节点、管理权益模板、独立系统转换模板、编译任务、分享及管理分享。鉴权与域名分流也在 app 层。公开路径为 `/sub/:token` 及 `/sub/:token/:client`（`worker/public-subscriptions.ts:178–180`、`worker/delivery/links.ts:3–16`），兼容必须保留两种现有路径和现有域名解析。 |
| 读写、渲染与账号 | `worker/delivery/service.ts` 负责创建/修改、Token 和计划写入，`d1-repository.ts` 负责行与 DTO 转换，`compiler.ts:146–182` 负责资格与节点输出，`user-nodes.ts` 与分享消费同类授权逻辑。账号软删/恢复和订阅归属联动看 `worker/accounts/admin-routes.ts`、`d1-repository.ts`；分组删除除服务检查外还见 0022/0023 触发器。 |
| KV 主数据及导入 | `worker/delivery/repository.ts:10–70` 的 `state:delivery`，`worker/shares/repository.ts:23–275` 的 `share:<hash>`、`state:share-settings`、`state:share-seq`。`worker/db/module-switch.ts` 的模块 ready 标志决定权威存储；D1 行数须与标志及 KV 对照。导入 `worker/migration/{run,delivery,shares}.ts` 保留旧 ID、归属和映射，恢复流程需同步扩展。 |
| 编译缓存、统计与限流 | `worker/delivery/{artifacts,dependencies,schema}.ts`。产物 v2 使用 `compiled:<tokenHash>:f:<revision>:<catalogRelevant>:<profile-or-base>:r<rendererVersion>:<client>`（`repository.ts:83–92`），含私密节点的分支使用加密后缀；目录还有按 DB 缓存的快照。ETag 来自响应体摘要，公开入口先鉴权/限流（`worker/public-subscriptions.ts:73–174`）。`fetch-stats.ts:4,54,120–211` 有 `fetch-stats:<subscriptionId>`、`fetch-stats:session` 与进程内暂存和刷新。D1 `rate_limits` 以 bucket、subject 摘要、时间窗计数（`public-rate-limit.ts`、0024），保留旧入口限流与历史统计映射。 |
| 密钥、备份及 R2 | `worker/platform/crypto.ts:73–120` 按运行配置取 Worker 密钥或 KV `system:crypto`。`wrangler.jsonc:12–35` 声明 DATA KV 和 DB D1，无 R2 绑定；仓库未发现订阅业务的 R2 持久化。现有 `development/scripts/subscription-v2-p{1,2,3}-migration.py` 与 `subscription-v2-p4-reconcile.py` 针对 SQLite 副本/对账，不能替代生产恢复点。集成协调员在切换前建立一致的 D1 与相关 KV 恢复点、记录 ready 标志与对应密钥版本、隔离保存凭据、恢复到隔离环境并对账。产物缓存可重建，用户设定、映射和统计依保留策略备份。 |
| 定时与后台 | `wrangler.jsonc:33–35` 每 15 分钟，`worker/index.ts:4–10` 调用 `worker/operations/cron.ts:58–end`，记录 `state:cron`、清理公开限流窗、刷新到期来源。到期邮件由 `worker/admin/routes.ts:34–36` 的管理任务调用 `worker/admin/service.ts:42–56`，按旧订阅记录提醒，旧去重时间为秒，转换时保留语义。批量/编译切换前暂停接单并收束在途 lease。前端到期提醒另有按用户的 localStorage 偏好（`src/features/user/reminder.ts:1–3`）。 |
| 前端 | `src/features/delivery/` 的管理、用户列表/详情、计划与批量，`src/features/user/` 首页、个人页、节点、流量、提醒、导入，分享/兑换及导航、路由和缓存失效见附录 C。后续复用现有布局组件、样式和默认值。 |

## 2. 当前 schema 与生产口径

| 对象 | 基底实查 |
|---|---|
| users / subscriptions | `0001:4–20` 确认 `users.id TEXT PRIMARY KEY`；0004 增加软删除。0014 重建订阅，`user_id` 可空、非空 FK RESTRICT；有 Token 唯一索引、默认客户端、revision、可空 epoch 毫秒起止、ISO 审计时间。0018 加 plan FK RESTRICT、限额快照、计划来源/备注/撤销与提醒时间。0021 通过来源表标记历史，没有修改订阅表。 |
| plans 和试用 | 0008 建 plans、plan_groups 与原 user_entitlements，0018 保留 `user_entitlements_legacy` 和迁移映射。计划不是模板别名（`worker/delivery/plans.ts:12–25,52–78,144–181`）。`trial_plan_id`、`trial_days` 及计划启用控制试用，`worker/accounts/registration.ts:223` 在注册语句批次中附加试用订阅；保留邀请、资格和时长覆盖。 |
| 来源、模板与节点关系 | 0021 `subscription_creation.subscription_id` UNIQUE + SET NULL，保留手动/legacy 来源及请求幂等，缺记录按 legacy 解释。0022 权益模板状态/编辑 revision、不可变版本（模板 FK RESTRICT、模板内版本号唯一）、origin 表（订阅 CASCADE、版本 RESTRICT）、直选节点（订阅 CASCADE、节点延迟 FK）、0014 组关系（订阅与组均 CASCADE）。0022 触发器阻止版本更新删除、无效组/节点写入、停用或非当前版本的新 origin，以及仍被旧订阅或非归档当前模板引用的组删除。 |
| 兑换 | 0023 批次 FK 到权益版本，码 FK 到批次，记录 FK 到码。记录订阅 FK UNIQUE + SET NULL，历史 `issued_subscription_id` 单独 UNIQUE；记录 `user_id` 是逻辑引用。保留码+用户、用户+请求幂等键、digest 与 replay verifier。0023 的组删除触发器还保护未到期、启用且有余量的已发批次，即使历史版本已被替换。旧码预览与发放读冻结版本，历史批次不受新版本替代影响。兑换来源经记录、码和批次追溯，不写普通 origin（`worker/redemption/service.ts:39–40,118–135,158–end`、`worker/delivery/{service.ts:217–219,247–262,d1-repository.ts:107–113}`）。 |
| shares | 0003 重建后到订阅是**逻辑引用**，到用户是 RESTRICT FK；分享有独立 hash、加密 Token、ISO 到期、次数、密码/登录、原链接开关。`worker/shares/{service,d1-repository,repository}.ts` 验证原订阅及归属并支持旧 KV。不能用 FK 检查代替孤儿扫描。 |
| compile_jobs / compile_job_items | 0024 的 `subscription_id` 以及 job 的 plan/group ID 是**逻辑引用**；item 到 job 是 CASCADE，item 主键为 job+订阅。0024 有创建/进度审计与终态清理。0025 以 `operation_json` 区分编译与批量，保留批量分项复核、结果、错误和复制 ID；替换清理触发器并新增逐项审计。实现见 `worker/delivery/{compile-jobs,subscription-batch}.ts`。 |
| 转换版本 | 0015 的 `subscription_templates` 等属于转换体系，0020 加转换关系及写入触发器。0025 `conversion_rule_version_snapshots.version_id` FK 到 `subscription_template_versions` CASCADE，快照为 JSON 数组。它不是 0022 权益版本表，必须保留。 |

生产数字均源自派线简报第 2 项（该消息的本地副本 `BRIEF_SUB_UNIFIED_PR1.md:20`，未纳入提交）。核实方法见附录 A，输出仅报计数和异常分类。

| 简报口径 | 集成核实 |
|---|---|
| 2 个用户 | A1 比对总量，并分软删除/禁用；解释数字是否包括这些行。 |
| 3 条订阅，0021 后均 legacy | A1 验证总量及 3 条显式 legacy，单列缺来源并按旧代码回退语义统计。A2 核对归属。 |
| 1 个兑换码且已不可兑 | A1/A5 验证总数和每种失效原因，核对资格服务以及 digest key 版本可用性。 |
| 9 条分享，均为 2026-09 测试残留且已过期 | A6 比对总量、创建月份和到期，测试性质需对照发布/测试记录，单凭创建时间不能证明。 |

## 3. Schema 结论

下一可用编号为 **0026**（基底 `migrations/` 末项 `0025_core_g.sql`）。以新增列、表、索引与触发器扩展，0021–0025 保持原状；历史权益版本、分享、编译分项和转换快照独立衔接。使用最大 `version_no` 作为当前发布；模板 revision 与新版本插入在一个批次提交，回滚旧配置通过发布同内容的新版本。发布守卫须在数据库内使陈旧 revision 的批次失败。

附录 B 增加显式 NOT NULL 主键、客户端枚举、正整数 revision、JS 可表示的日期范围与严格时间窗；默认访问关闭，等映射和凭据就绪后再开启。私有模板 owner FK RESTRICT 且 `allow_redemption=0`；归属范围创建后固定，修正用新模板及显式换绑。服务检查归属、活跃状态和归档条件，数据库兜底检查私有绑定及旧版兑换写入。采用软删，历史绑定 FK 选 RESTRICT，访问凭据随获批硬删除级联。

加密值按 `worker/platform/crypto.ts:27–35,128–150` 的版本化 AES-GCM JSON 对象保存，服务用严格 Zod 解析，hash 继续 SHA-256 base64url（`worker/delivery/service.ts:128–134`）；旧 D1 `{}` 表示无密文（`d1-repository.ts:168,216–221`），只在检查通过后复制有效对象，目标缺值用 SQL NULL。K/V 密钥与 Worker secret 的实际来源须在恢复演练核对。旧 hash 可验证已持有的链接，不能解密。当前 reveal 对旧占位可能轮换原 Token（`service.ts:466–481`），预检只走纯解密校验。

D1 默认执行 FK 约束，延迟检查仍可能触发级联，expand 禁止重建或删除父表。D1 batch 在语句失败时整批回滚。比较并交换、兑换扣量及竞争失败应通过断言令 SQL 失败；单独检测 UPDATE 零影响行太晚。草案在 PR1 保持文档。独立 SQLite 内存 mock 对已有 shared 行、私有 owner 正例、越权绑定、私有兑换、owner 修改和空密文对象拒绝的断言通过。PR2 需在隔离 D1 验证全量/0025 增量、外键、私有归属、并发发布、原子失败和恢复。 [D1 外键](https://developers.cloudflare.com/d1/sql-api/foreign-keys/) [D1 Database.batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

## 4. 迁移判定与阻断

| 对象 | 自动条件 / 阻断与人工处置 |
|---|---|
| 孤立与停用订阅 | NULL user 不按邮箱/创建者/首用户推断，保留旧数据及安全的原路径，挂待处理；缺用户是数据异常，禁止自动归属及切换该条。管理员确认所有者和范围，或明确停用。禁用/软删账户及已撤销订阅保留历史，不能借新绑定恢复。 |
| 手动订阅与重复候选 | 保留管理员手动创建路径，改为创建专属模板并绑定。已知用户且范围可证明时默认独立专属兼容模板。仅当资源、策略、状态和时间区间连续覆盖等价且同一用户时，才取最早起点、最晚到期，连续永久覆盖可保留 NULL。不同状态/限额、断开的期间或来源不明时禁止直接合并；用语义等价的独立兼容模板，否则人工。保留逐旧 ID 多对一映射。 |
| 历史版本 | origin 是签发证据，旧运行时使用实际订阅组/直选及计划交集（`compiler.ts:149–170`），不能把 origin config 当作有效权限。比较当前发布版本、历史版本、实际配置、动态组规则、限额、转换选择和状态。判定等价方可绑定现有模板，差异可精确表达时用兼容模板；否则阻断。一次输出相同仅是样本，不能证明动态范围等价。 |
| §5.1 计划限额 | **阻断项**。现有计划定义与订阅快照都有流量、速度、设备（0008/0018），保存计划时同步限额和 revision（`plans.ts:52–71`）；旧运行时绑定动态计划组交集，计划禁用/缺失阻止输出。流量 0 表示不限，非零额度可存入关联策略；当前 `traffic-usage.ts:1–54` 的测量始终 NULL，仓库无用户流量账本，也无可执行的逐用户/节点/授权流量资格。保留实际账本来源（若集成另有服务），对同一测量只计一次；未知保持未知。速度仅在 `compiler.ts:173–182`、`dependencies.ts:15–21` 对 Hysteria/Hysteria2 与 mihomo/singbox/surge 写客户端限速参数，不能证明服务端强制。设备为元数据，未找到设备识别或计数强制路径；拉取限流与设备限制是独立机制。仓库无按用户、节点和授权独立强制速度/设备的控制面证据。保留单授权的旧渲染参数及配置元数据是可行的，只有范围和执行语义可证明时才允许合并。 |
| 上述策略冲突 | 逐授权解析资源与资格，再求并集。重叠节点只在至少一个合法授权允许时输出；前提是能绑定到那份授权可执行的凭据及策略。共享节点凭据或同连接不同限速、计量归属、设备范围冲突时，禁止自动求和、取较宽上限、全局取最严或静默去掉限制。节点级策略需证实可分离，无法表达就保留隔离的旧输出并阻断该用户切换。初期内部保留旧计划策略映射，待 §5.1 证据齐全再折入模板版本。已下载共享凭据不会因配置到期被撤销。 |
| 未来授权 | 保留原起止与状态；未来生效不能因合并提前出现，时间空洞不能填平。旧 NULL starts 用合法 created_at 还原，同秒起止、坏时间和旧 fallback 0 进入人工，停用与撤销不能通过兑换恢复。 |
| 分享与兑换 | 已过期分享保留历史并保持不可用；仍有效的只允许旧授权与当前有效授权的交集，并保留密码、次数、截止、登录、管理员开关。无法等价则保留可安全运行的旧路径，或经管理员决定停用重建；禁止从旧分享提供统一原 Token。已失效码保留记录/重放，不恢复。可兑码须维持旧发行承诺（资源与时长）；相同则迁到新语义，有差异用兼容模板或管理员处理。新码只发共享模板。核销、绑定续期、回执、审计原子提交，同绑定可多次兑换但原幂等约束保留。 |
| Token 与旧链接 | 单一旧 Token 且授权范围和后续访问规则可证明等价时可复用，跨新旧 Token 命名空间检查冲突；需要兼容的旧 Token 单独映射，禁止重定向到更广链接。密文可恢复须验证解密及重算 hash 一致；缺密文或无法解密时保留可安全验证的原 hash 兼容入口，发独立新用户 Token 供受权 reveal。hash/密文不一致、映射不安全或切换会破坏仍有效旧链接时阻断并人工处置。 |

## 5. Repository、时间与发布规则

- 账户访问 repository 按 user_id 或唯一 hash 查找；绑定 repository 按 (user_id, template_id) 定位，按用户索引读取绑定及模板最新版本。只为已验证用户创建一次访问记录。重置使用 revision 条件，立即作废旧凭据；身份来自 principal，公开路径只用 hash 查找。授权真相是绑定，访问表只持凭据与开关，迁移映射是历史/兼容数据。
- 请求捕获一个 now，资格用 UTC epoch 毫秒，API 用 ISO 8601，有限授权为 `starts_at <= now < expires_at`。永久明确用 NULL，要求起点已到。沿用 `shared/subscription-duration.ts:1–15` UTC 日历月/年加法，目标月最后一日截断，日/周为固定 24 小时倍数。服务校验正整数时长和每单位上限（沿用当前版本的 36,500 个单位上限并限定结果能合法序列化），检查安全整数和结果范围；例如 2027-01-31 加一月到 2027-02-28，保留 UTC 时间。续期用 max(now, 原到期)，未来授权从原到期续，永久不收窄。暂停继续走时钟。
- 优先判账户不存在、禁用或软删及访问关闭，再判模板、绑定与时间。按每模板授权解析资源后求并集。存在任一有效绑定为 active；存在有效永久绑定时 `permanent=true, expiresAt=null`，否则最远有效到期。无有效绑定时 `permanent=false`，优先给可生效的未来 pending，其次有效条件已因时间结束的 expired，再是仅有禁用/暂停等历史的 disabled，只有撤销或从未有授权为 none；历史到期独立字段。节点为空另用可用节点标记。过期派生，无 Cron 写状态。
- 原子 UPSERT、替换、审计和修订号递增。批量按用户分项，有界执行、请求幂等，保留 actor 与变更前后时间/状态。模板归档检查有效及未来绑定（包括可恢复的暂停项）与可兑发行，禁止有依赖时归档。按用户最远有效期提醒，永久不提醒。
- 编译以用户+客户端寻址，依赖账户/凭据状态、绑定和模板 revision、转换/目录/renderer 版本；旧产物不能回落复用。validUntil 取默认 TTL、最近有效到期和可生效窗口起点的最早值。缓存和 304 前重验权威版本，编译后重验时间与版本，私密产物隔离，保持现有格式诊断。
- expand → backfill → compat → cutover → contract。新增映射以旧订阅 ID 唯一，记录用户/模板、状态、验证证据和检查点。幂等分批影子解析，核对每个旧链接与授权交集、用户节点并集、窗口、策略和各格式输出。暂停旧写入口与批量，追平增量，再切换权威写入。切换前可关闭影子读；切换后采用维护模式、向前修复或经演练的反向迁移，恢复时对账切换后写入。旧数据和有效路径保留；观察期及授权明确后再逐项移除依赖。

## 6. Roye 决策清单

| 触发条件 | 选项与建议 |
|---|---|
| §5.1 无法证明限额或冲突组合等价 | **建议** 暂缓受影响用户切换，保留旧隔离策略并验证实际计量/限速/设备控制。也可先建设可按用户与凭据执行的策略控制，再重跑对照。任何改变已承诺额度的产品政策需明确批准及逐项处理。 |
| 旧订阅无归属、重复或版本差异无法无损表达 | **建议** 逐项人工确认，使用独立专属兼容模板，未确认条目保持安全旧路径。也可由管理员明确归属和新范围，或批准停用孤立条目；发现权限扩大则阻断自动切换。 |
| 仍有效链接/分享无法安全兼容、兑换承诺不能兑现 | **建议** 延后该条切换，保留可安全运行的隔离路径。管理员可批准有通知的重发/重建或停用。兼容期可按方案的 90 天作为批准选项，保留仍有效旧链接直至下一阶段获批。 |
| 0025 增量、对账或恢复演练失败 | **建议** 保持旧权威路径，修复后在隔离副本重演，再决定切换。若无法逐条隔离或证明恢复可行，整批推迟；批准停机迁移作为替代须先通过恢复演练。 |

## 附录 A · 集成只读预检

协调员在同一快照或同一观察窗口运行；`:as_of_ms` 传固定 UTC epoch 毫秒。报告只传计数/分类，人工处理在受控环境核对明细。跨存储不可用 SQL 覆盖的部分另做只读采样。先确认 migration ledger 已通过 0025 和 ready 标志，记录生产与隔离副本的 schema 一致性。

```sql
-- A1 用户、订阅、来源及其余表盘点
SELECT key, value FROM system_settings
WHERE key IN ('accounts_d1_ready','catalog_d1_ready','delivery_d1_ready',
              'shares_d1_ready','trial_plan_id','trial_days');
SELECT count(*) AS users, count(CASE WHEN enabled=0 THEN 1 END) AS disabled,
       count(deleted_at) AS soft_deleted FROM users;
SELECT CASE WHEN r.id IS NOT NULL THEN 'redemption'
            WHEN o.subscription_id IS NOT NULL THEN 'template'
            ELSE coalesce(sc.source_type,'legacy_missing_metadata') END AS source,
       count(*) AS total
FROM subscriptions s
LEFT JOIN subscription_creation sc ON sc.subscription_id=s.id
LEFT JOIN subscription_template_origins o ON o.subscription_id=s.id
LEFT JOIN redemption_records r ON r.subscription_id=s.id GROUP BY 1;
SELECT 'plans' AS object, count(*) AS total FROM plans UNION ALL
SELECT 'plan_groups', count(*) FROM plan_groups UNION ALL
SELECT 'user_entitlements_legacy', count(*) FROM user_entitlements_legacy UNION ALL
SELECT 'subscription_plan_migration', count(*) FROM subscription_plan_migration UNION ALL
SELECT 'entitlement_templates', count(*) FROM entitlement_templates UNION ALL
SELECT 'entitlement_template_versions', count(*) FROM entitlement_template_versions UNION ALL
SELECT 'subscription_template_origins', count(*) FROM subscription_template_origins UNION ALL
SELECT 'subscription_creation', count(*) FROM subscription_creation UNION ALL
SELECT 'subscription_nodes', count(*) FROM subscription_nodes UNION ALL
SELECT 'subscription_groups', count(*) FROM subscription_groups UNION ALL
SELECT 'redemption_batches', count(*) FROM redemption_batches UNION ALL
SELECT 'redemption_codes', count(*) FROM redemption_codes UNION ALL
SELECT 'redemption_records', count(*) FROM redemption_records UNION ALL
SELECT 'compile_job_items', count(*) FROM compile_job_items UNION ALL
SELECT 'conversion_rule_version_snapshots', count(*) FROM conversion_rule_version_snapshots;
SELECT status, operation_json IS NOT NULL AS is_batch, count(*) FROM compile_jobs GROUP BY 1,2;
SELECT count(*) AS dangling_job_items FROM compile_job_items i
LEFT JOIN subscriptions s ON s.id=i.subscription_id WHERE s.id IS NULL;
SELECT plan_source, plan_revoked, count(*) FROM subscriptions GROUP BY 1,2;
SELECT name, tbl_name FROM sqlite_schema WHERE type='trigger' ORDER BY tbl_name,name;
PRAGMA foreign_key_check;

-- A2 归属及窗口，缺失的 starts_at 依照旧 created_at 转换
WITH windows AS (
  SELECT s.*, coalesce(starts_at,CAST(round(unixepoch(s.created_at,'subsec')*1000) AS INTEGER)) AS effective_start
  FROM subscriptions s
)
SELECT count(CASE WHEN s.user_id IS NULL THEN 1 END) AS unassigned,
       count(CASE WHEN s.user_id IS NOT NULL AND u.id IS NULL THEN 1 END) AS missing_user,
       count(CASE WHEN u.deleted_at IS NOT NULL OR u.enabled=0 THEN 1 END) AS blocked_account,
       count(CASE WHEN effective_start>:as_of_ms THEN 1 END) AS future,
       count(CASE WHEN expires_at<=:as_of_ms THEN 1 END) AS expired,
       count(CASE WHEN expires_at IS NULL THEN 1 END) AS no_end,
       count(CASE WHEN typeof(effective_start)<>'integer' OR abs(effective_start)>8640000000000000
                    OR (expires_at IS NOT NULL AND (typeof(expires_at)<>'integer'
                      OR abs(expires_at)>8640000000000000 OR expires_at<=effective_start))
                  THEN 1 END) AS invalid_window
FROM windows s LEFT JOIN users u ON u.id=s.user_id;
SELECT count(*) AS manual_or_untracked_subscriptions
FROM subscriptions s
LEFT JOIN subscription_template_origins o ON o.subscription_id=s.id
LEFT JOIN redemption_records r ON r.subscription_id=s.id
WHERE o.subscription_id IS NULL AND r.subscription_id IS NULL;

-- A3 同用户同来源模板重复候选，以及历史版本差异候选
WITH provenance AS (
  SELECT subscription_id, version_id FROM subscription_template_origins
  UNION
  SELECT r.subscription_id, b.template_version_id FROM redemption_records r
  JOIN redemption_codes c ON c.id=r.code_id JOIN redemption_batches b ON b.id=c.batch_id
  WHERE r.subscription_id IS NOT NULL
), candidates AS (
  SELECT s.user_id, v.template_id, count(DISTINCT s.id) AS n FROM subscriptions s
  JOIN provenance o ON o.subscription_id=s.id
  JOIN entitlement_template_versions v ON v.id=o.version_id
  WHERE s.user_id IS NOT NULL GROUP BY 1,2 HAVING count(DISTINCT s.id)>1
)
SELECT count(*) AS duplicate_pairs, coalesce(sum(n),0) AS source_rows FROM candidates;
SELECT count(*) AS users_with_multiple_subscriptions FROM (
  SELECT user_id FROM subscriptions WHERE user_id IS NOT NULL GROUP BY user_id HAVING count(*)>1
);
WITH provenance AS (
  SELECT subscription_id, version_id FROM subscription_template_origins
  UNION
  SELECT r.subscription_id, b.template_version_id FROM redemption_records r
  JOIN redemption_codes c ON c.id=r.code_id JOIN redemption_batches b ON b.id=c.batch_id
  WHERE r.subscription_id IS NOT NULL
), latest AS (
  SELECT template_id, max(version_no) AS version_no FROM entitlement_template_versions GROUP BY 1
)
SELECT count(*) AS origins,
       count(CASE WHEN old.id<>cur.id THEN 1 END) AS historic_version,
       count(CASE WHEN old.config_json<>cur.config_json THEN 1 END) AS config_text_diff
FROM provenance o
JOIN entitlement_template_versions old ON old.id=o.version_id
JOIN latest l ON l.template_id=old.template_id
JOIN entitlement_template_versions cur ON cur.template_id=l.template_id AND cur.version_no=l.version_no;

-- A4 计划和快照限制；同用户混合限制是人工复核候选
SELECT count(*) AS total, count(s.plan_id) AS with_plan,
       count(CASE WHEN s.plan_id IS NOT NULL AND p.id IS NULL THEN 1 END) AS missing_plan,
       count(CASE WHEN p.enabled=0 THEN 1 END) AS disabled_plan,
       count(CASE WHEN s.traffic_gb>0 OR p.traffic_gb>0 THEN 1 END) AS traffic_limited,
       count(CASE WHEN s.speed_limit_mbps>0 OR p.speed_limit_mbps>0 THEN 1 END) AS speed_limited,
       count(CASE WHEN s.device_limit>0 OR p.device_limit>0 THEN 1 END) AS device_limited,
       count(CASE WHEN s.traffic_gb<>p.traffic_gb OR s.speed_limit_mbps<>p.speed_limit_mbps
                    OR s.device_limit<>p.device_limit THEN 1 END) AS snapshot_diff
FROM subscriptions s LEFT JOIN plans p ON p.id=s.plan_id;
SELECT count(*) AS mixed_limit_users FROM (
  SELECT user_id FROM subscriptions WHERE user_id IS NOT NULL
  GROUP BY user_id HAVING count(DISTINCT json_array(traffic_gb,speed_limit_mbps,device_limit))>1
);

-- A5 代码资格候选。模板差异只供迁移对比，旧发行读取冻结版本。
SELECT count(*) AS codes,
       count(CASE WHEN c.used_count=0 THEN 1 END) AS unused,
       count(CASE WHEN c.revoked=1 THEN 1 END) AS revoked,
       count(CASE WHEN c.used_count>=c.max_uses THEN 1 END) AS exhausted,
       count(CASE WHEN b.enabled=0 THEN 1 END) AS batch_disabled,
       count(CASE WHEN b.redeem_deadline<=:as_of_ms THEN 1 END) AS deadline_passed,
       count(CASE WHEN t.status<>'enabled' OR t.allow_redemption=0 OR EXISTS (
           SELECT 1 FROM entitlement_template_versions newer
           WHERE newer.template_id=v.template_id AND newer.version_no>v.version_no
         ) THEN 1 END) AS template_policy_changed,
       count(CASE WHEN c.revoked=0 AND c.used_count<c.max_uses AND b.enabled=1
                   AND b.redeem_deadline>:as_of_ms THEN 1 END) AS code_available
FROM redemption_codes c JOIN redemption_batches b ON b.id=c.batch_id
JOIN entitlement_template_versions v ON v.id=b.template_version_id
JOIN entitlement_templates t ON t.id=v.template_id;
SELECT count(CASE WHEN subscription_id IS NULL THEN 1 END) AS historical_receipts
FROM redemption_records;

-- A6 分享月份、过期和逻辑孤儿
SELECT count(*) AS shares,
       count(CASE WHEN strftime('%Y-%m',sh.created_at)='2026-09' THEN 1 END) AS created_sep_2026,
       count(CASE WHEN round(unixepoch(sh.expires_at,'subsec')*1000)<=:as_of_ms THEN 1 END) AS expired,
       count(CASE WHEN unixepoch(sh.expires_at,'subsec') IS NULL THEN 1 END) AS invalid_expiry,
       count(CASE WHEN s.id IS NULL THEN 1 END) AS missing_subscription,
       count(CASE WHEN s.id IS NOT NULL AND s.user_id IS NOT sh.owner_user_id THEN 1 END) AS owner_mismatch
FROM shares sh LEFT JOIN subscriptions s ON s.id=sh.subscription_id;

-- A7 密文形态，仅计数。可解密性须在密钥环境验证
SELECT CASE
  WHEN encrypted_token='{}' THEN 'hash_only'
  WHEN NOT json_valid(encrypted_token) THEN 'invalid_json'
  WHEN json_extract(encrypted_token,'$.version')=1
   AND json_extract(encrypted_token,'$.algorithm')='AES-GCM'
   AND json_type(encrypted_token,'$.iv')='text'
   AND json_type(encrypted_token,'$.ciphertext')='text' THEN 'envelope_candidate'
  ELSE 'invalid_envelope' END AS envelope_state, count(*) AS total
FROM subscriptions GROUP BY 1;
SELECT count(*) AS bad_hash_shape FROM subscriptions
WHERE length(token_hash)<>43 OR token_hash GLOB '*[^A-Za-z0-9_-]*';
```

进一步比对手动候选、源节点与计划、动态组成员、配置版本内容及重复区间，SQL 的文本差异仅供筛查。Token 用严格 schema + 纯解密 + 重算 hash，导出仅三类计数（可恢复、仅 hash、解密或校验失败）；不得通过原 reveal 轮换做验证。无授权的实际生产备份、输出样本、密钥检查及流量控制面核验在此交付中缺失，作为切换前验收证据补齐。

## 附录 B · 0026 目标 SQL 草案

已有模板默认为 shared。归属不可修改触发器使用值比较，允许普通发布更新；绑定写入和旧版批次写入均需私有范围兜底。启用、归档、发布和其他授权操作仍需 repository 的事务守卫。模板策略配置拟在后续版本扩展，当前 `entitlement-templates.ts:7–32` 仅含相对时长、quotaBytes、无重置策略、资源范围与速度字段，缺设备和逐授权计量；§5.1 解决前保留兼容策略映射。兼容映射及检查点与 PR5 迁移工具定稿，单独保留旧 ID 和状态。

```sql
ALTER TABLE entitlement_templates
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'shared' CHECK (scope IN ('shared','private'));

ALTER TABLE entitlement_templates
  ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT
    CHECK (
      (scope='shared' AND owner_user_id IS NULL)
      OR (scope='private' AND owner_user_id IS NOT NULL AND allow_redemption=0)
    );

CREATE INDEX entitlement_templates_owner ON entitlement_templates(owner_user_id)
  WHERE owner_user_id IS NOT NULL;

CREATE TRIGGER entitlement_template_scope_immutable
BEFORE UPDATE OF scope, owner_user_id ON entitlement_templates
WHEN NEW.scope IS NOT OLD.scope OR NEW.owner_user_id IS NOT OLD.owner_user_id
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_SCOPE_IMMUTABLE');
END;

CREATE TABLE user_subscription_access (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash)=43 AND token_hash NOT GLOB '*[^A-Za-z0-9_-]*'),
  token_prefix TEXT NOT NULL,
  encrypted_token TEXT CHECK (
    CASE WHEN encrypted_token IS NULL THEN 1
         WHEN json_valid(encrypted_token)=0 THEN 0
         ELSE json_type(encrypted_token)='object'
           AND json_type(encrypted_token,'$.version') IS 'integer'
           AND json_extract(encrypted_token,'$.version') IS 1
           AND json_extract(encrypted_token,'$.algorithm') IS 'AES-GCM'
           AND json_type(encrypted_token,'$.iv') IS 'text'
           AND json_type(encrypted_token,'$.ciphertext') IS 'text' END
  ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  default_client TEXT NOT NULL DEFAULT 'generic' CHECK (default_client IN (
    'mihomo','singbox','surge','loon','quantumultx','v2rayn','nekobox','shadowrocket','generic'
  )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_template_bindings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  template_id TEXT NOT NULL REFERENCES entitlement_templates(id) ON DELETE RESTRICT,
  starts_at INTEGER NOT NULL CHECK (
    typeof(starts_at)='integer' AND starts_at BETWEEN -8640000000000000 AND 8640000000000000
  ),
  expires_at INTEGER CHECK (
    expires_at IS NULL OR (typeof(expires_at)='integer'
      AND expires_at BETWEEN -8640000000000000 AND 8640000000000000 AND expires_at>starts_at)
  ),
  status TEXT NOT NULL CHECK (status IN ('active','paused','revoked')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,template_id)
);

CREATE INDEX binding_template_users ON user_template_bindings(template_id,user_id);
CREATE INDEX binding_user_status ON user_template_bindings(user_id,status,expires_at);

CREATE TRIGGER binding_private_owner_insert
BEFORE INSERT ON user_template_bindings
WHEN EXISTS (
  SELECT 1 FROM entitlement_templates t WHERE t.id=NEW.template_id
    AND t.scope='private' AND t.owner_user_id IS NOT NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_OWNER_MISMATCH');
END;

CREATE TRIGGER binding_identity_immutable
BEFORE UPDATE OF user_id, template_id ON user_template_bindings
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.template_id IS NOT OLD.template_id
BEGIN
  SELECT RAISE(ABORT, 'BINDING_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER redemption_batch_shared_insert
BEFORE INSERT ON redemption_batches
WHEN EXISTS (
  SELECT 1 FROM entitlement_template_versions v JOIN entitlement_templates t ON t.id=v.template_id
  WHERE v.id=NEW.template_version_id AND t.scope='private'
)
BEGIN
  SELECT RAISE(ABORT, 'REDEMPTION_PRIVATE_TEMPLATE');
END;

CREATE TRIGGER redemption_batch_shared_update
BEFORE UPDATE OF template_version_id ON redemption_batches
WHEN EXISTS (
  SELECT 1 FROM entitlement_template_versions v JOIN entitlement_templates t ON t.id=v.template_id
  WHERE v.id=NEW.template_version_id AND t.scope='private'
)
BEGIN
  SELECT RAISE(ABORT, 'REDEMPTION_PRIVATE_TEMPLATE');
END;
```

## 附录 C · 固定提交逐行索引

搜索覆盖五个原始字面量（不区分大小写），加上 snake_case 列、template origins、分享 Token 的实际加密字段及旧签发 ID。以下每个数字为固定基底对应文件中的命中行，同行多次出现只列一次。用 `git show <基底>:<路径>` 核对行内容。

共 232 个文件、2118 个命中行。复现命令如下。

```sh
git grep -nIiE 'subscriptions|subscriptionId|planId|templateVersionId|tokenHash|subscription_id|plan_id|template_version_id|token_hash|subscription_template_origins|token_encrypted|issued_subscription_id' 7b6921e5fccddb95bab8d14842aedd68c02484c4
```

- `AUDIT_PAGES.md` · 19, 30
- `BRIEF_PLAN_ENTITLEMENT_MERGE.md` · 7, 18–19, 24, 30
- `PLAN.md` · 90, 131–136, 155, 175, 190, 200–201, 205–206, 215, 343, 497, 503, 578, 593, 598, 600, 603, 609–612, 620–621, 633, 639, 696
- `PROGRESS-1B.md` · 6, 15
- `REPORT_ADMIN_DUAL_LAYOUT.md` · 11
- `REPORT_ALIGNMENT_AUDIT.md` · 14, 37, 52, 66
- `REPORT_BATCH2.md` · 11
- `REPORT_BATCH3.md` · 3, 10–11, 26, 36–37, 40, 53, 73–74, 83
- `REPORT_BATCH4.md` · 29, 52
- `REPORT_BATCH6.md` · 39
- `REPORT_BATCH8.md` · 23, 33, 35, 44, 48–49
- `REPORT_CLEANUP_TAIL.md` · 42, 102, 108, 119
- `REPORT_CONTROLS.md` · 148, 154
- `REPORT_CORE_A.md` · 12, 19–26, 28, 30, 32–33, 35–36, 68, 83, 89, 112, 114, 116, 118–120, 127–129, 138–139, 141, 163
- `REPORT_CORE_B.md` · 15, 31
- `REPORT_CORE_C.md` · 46
- `REPORT_CORE_F.md` · 23, 27, 70
- `REPORT_CORE_G.md` · 21, 23
- `REPORT_DESIGN_V2_P0.md` · 21, 34
- `REPORT_DESIGN_V2_P1.md` · 33
- `REPORT_DESIGN_V2_P2.md` · 12, 19, 24, 40, 51
- `REPORT_DESIGN_V2_P3.md` · 10, 20, 35, 45–47, 55
- `REPORT_DOMAIN_SIMPLIFY.md` · 30
- `REPORT_DRAWER_SLIM.md` · 3, 7
- `REPORT_ENTITLEMENTS.md` · 12, 34
- `REPORT_HOME_TRAFFIC.md` · 11–13, 19, 31–32, 69
- `REPORT_LAYOUT_FLATTEN.md` · 49, 67
- `REPORT_MOBILE_BAR_FIX.md` · 28
- `REPORT_MOBILE_BAR_FIX2.md` · 22
- `REPORT_MOBILE_BAR_FIX3.md` · 18
- `REPORT_MOBILE_BAR_INSET.md` · 28–29, 35
- `REPORT_MOBILE_BOTTOM_BAR.md` · 25
- `REPORT_MOBILE_NAV_VERIFY.md` · 12, 25
- `REPORT_NAV.md` · 26, 38, 43
- `REPORT_NAV_SLIM.md` · 13
- `REPORT_OVERVIEW_REDESIGN.md` · 25–26, 32, 40–41, 50
- `REPORT_PAGES_RESOURCES.md` · 37
- `REPORT_PAGES_USER.md` · 53
- `REPORT_PAGINATION.md` · 9, 11–12, 18, 24, 30–31, 37, 44
- `REPORT_PLAN_MERGE.md` · 29, 35, 38, 48, 51, 53–54, 56
- `REPORT_SECURITY_AUDIT.md` · 10–11, 13, 21, 32–33, 43
- `REPORT_SHARE_BYPASS.md` · 25–26, 37–38, 60
- `REPORT_STAGE3.md` · 50
- `REPORT_STYLE_UNIFY.md` · 25, 100, 176
- `REPORT_SUBSCRIPTIONS.md` · 7–8, 11, 16, 18, 25, 39
- `REPORT_SUB_BOTTOM_NAV_MASK.md` · 8, 24
- `REPORT_SUB_BUTTON_UNIFY.md` · 35
- `REPORT_SUB_ME_REDESIGN.md` · 31, 74
- `REPORT_SUB_MODAL_P1.md` · 42
- `REPORT_SUB_QUICK_IMPORT.md` · 7–8, 52, 54
- `REPORT_SUB_REMOVE_COPY_TRANSFER.md` · 9, 11, 14–15, 21, 23
- `REPORT_SUB_V2_P1.md` · 7–8, 18–19
- `REPORT_SUB_V2_P2.md` · 9, 24, 34, 65
- `REPORT_SUB_V2_P3.md` · 65
- `REPORT_SUB_V2_P4.md` · 81
- `REPORT_TEMPLATES.md` · 15
- `REPORT_TEMPLATE_PERFECT_P1P2.md` · 15
- `REPORT_UI_ADMIN.md` · 9, 23, 72–74, 76, 131
- `REPORT_UI_COPY_TRIM.md` · 15, 35
- `REPORT_UI_FOUNDATION.md` · 75–76
- `REPORT_UI_USER.md` · 18, 22
- `REPORT_UI_WIRING.md` · 41, 47
- `development/screenshots/button-hover-mask/desktop-audit.json` · 291, 339
- `development/scripts/subscription-v2-p1-migration.py` · 17, 19, 21–22, 27–28, 33–34, 38, 40, 57–59
- `development/scripts/subscription-v2-p2-migration.py` · 12, 77
- `development/scripts/subscription-v2-p3-migration.py` · 76
- `development/scripts/subscription-v2-p4-reconcile.py` · 13–17, 19, 56, 59, 61–62, 86
- `development/test-admin-email-offline.mjs` · 59
- `development/test-core-b-screenshots.mjs` · 14, 65–66, 68–71, 91
- `development/test-core-c.mjs` · 34, 48, 50, 52
- `development/test-core-d.mjs` · 91–92, 161, 175
- `development/test-core-e.mjs` · 96–97, 127, 136, 190, 214
- `development/test-design-v2-p0.mjs` · 18
- `development/test-design-v2-p1.mjs` · 57
- `development/test-design-v2-p2.mjs` · 13, 29–30, 33, 55, 90, 100, 106
- `development/test-design-v2-p3.mjs` · 14, 20–21, 25, 36, 39, 42, 51, 112, 175, 182
- `development/test-entitlements-offline.mjs` · 50, 72, 110, 112, 122, 125, 130, 133, 140, 142–143, 146, 148, 151, 156, 168, 171, 178, 189–191
- `development/test-home-traffic.mjs` · 14, 20–21, 38
- `development/test-invite-registration-offline.mjs` · 99, 104, 106, 110–111
- `development/test-layout-switch-split.mjs` · 17–18
- `development/test-mobile-bar-inset.mjs` · 24, 26
- `development/test-nav-structure.mjs` · 35, 177, 181
- `development/test-pages-offline.mjs` · 102
- `development/test-plan-migration.mjs` · 28–29, 37, 47, 49, 60, 67, 72–73, 76, 80–81, 92–93
- `development/test-stage3-offline.mjs` · 84–86, 88, 90, 112, 117, 121, 139
- `development/test-sub-me-redesign.mjs` · 29, 34, 43, 49, 63, 69, 156, 207, 221, 256, 261, 270
- `development/test-sub-per-user-layout.mjs` · 23
- `development/test-sub-quick-import.mjs` · 15, 86–88, 107
- `development/test-sub-v2-p3.mjs` · 68
- `development/test-ui-content.mjs` · 14, 25, 29–30, 33, 38, 71, 73, 89
- `development/tests/browser/admin-frontend.spec.ts` · 358, 449, 503
- `development/tests/browser/button-hover-mask.spec.ts` · 61
- `development/tests/browser/mobile-nav.spec.ts` · 11, 234
- `development/tests/browser/modal-p1.spec.ts` · 94, 100–102, 105, 109, 203
- `development/tests/browser/system-domains.spec.ts` · 29, 31, 85–86, 89–90, 93, 96
- `development/tests/browser/template-p3.spec.ts` · 60, 62–64, 66, 107, 122–123, 180, 201, 286, 293
- `development/tests/browser/user-subscriptions.spec.ts` · 29, 67, 74, 88
- `development/tests/controls/resource-cards.test.tsx` · 9, 38–39
- `development/tests/node/subscription-migration.test.ts` · 5, 15, 17, 20, 22–24
- `development/tests/node/subscriptions.test.ts` · 3, 5, 39, 41–42, 51, 58–59, 65
- `development/tests/node/templates-lifecycle.test.ts` · 40, 97
- `development/tests/ui/data-cache.test.ts` · 71–73
- `development/tests/ui/navigation-structure.test.ts` · 38, 41, 67, 113, 234, 238, 250, 254, 262
- `development/tests/ui/user-pages-style.test.tsx` · 14, 33, 39, 57, 85, 101, 116, 154–160
- `development/tests/worker/admin-accounts.test.ts` · 35
- `development/tests/worker/catalog-api.test.ts` · 229, 387
- `development/tests/worker/core-f.test.ts` · 37–38, 77, 133, 191, 194–195, 197, 200–201, 203, 233, 237, 245, 261, 305–306, 308, 310
- `development/tests/worker/d1-admin-users.test.ts` · 111–112, 118, 120–121, 131, 185, 189–190, 327–328, 376–377, 398, 409, 414–415, 420, 432, 437–438, 459–460, 472, 474, 488–490, 536, 548, 553–554, 559, 571, 585–586
- `development/tests/worker/d1-delivery-order-fallback.test.ts` · 15, 17–18, 21, 37, 43, 87
- `development/tests/worker/d1-delivery-shares.test.ts` · 135–136, 142, 158, 178–179, 217, 219–220, 245, 253, 263, 269–271, 275, 284, 293, 296, 300, 304, 314, 323, 330, 341, 360–363, 370, 382–383, 387, 398–399, 402, 408, 410, 415–416, 435, 440–441, 463–464, 472, 474, 477, 480, 484, 492, 494, 496, 499, 508, 512–513, 517, 525, 584, 596
- `development/tests/worker/d1-domains.test.ts` · 312, 331, 355, 357–358
- `development/tests/worker/d1-foundation.test.ts` · 80, 84, 162–163
- `development/tests/worker/d1-mail.test.ts` · 183, 185, 188, 190, 204, 209, 211, 213
- `development/tests/worker/d1.ts` · 84, 87
- `development/tests/worker/delivery-api.test.ts` · 29, 57, 60–61, 65, 71, 75, 77, 79, 82, 84–86, 93, 95–96, 118, 164, 166–167, 181, 183–184, 195, 197–198, 209, 211–212, 227, 229–230, 238, 246, 255, 257–258, 266, 276–277, 279, 284, 286–287, 308, 316–317, 332, 334–335, 345, 360, 362–363, 366–367, 373, 380, 384–385, 390, 392–393, 412, 417–418, 424–425, 435–436, 446–447, 455–457, 459, 462, 472, 477, 480–481, 490–492, 509–510, 521, 523–524, 526, 528–529, 534, 540, 542–543, 549–550, 555, 558–560, 562–563, 569, 571, 573, 575, 577, 581, 583–587, 589–590, 594, 597, 602, 604–608, 610, 612, 616–622, 624–626, 628, 632, 657–658, 690, 694, 696, 704, 780, 786, 788, 790, 922, 925, 932, 936
- `development/tests/worker/delivery-repository.test.ts` · 7, 27, 72, 74, 82, 84, 89, 105, 108–110, 112, 119–120, 125, 134
- `development/tests/worker/entitlements.test.ts` · 19, 57–59, 90, 109, 113, 120, 140, 142–143, 145, 192, 204, 215, 219, 222–223, 225–226, 229
- `development/tests/worker/import-detect.test.ts` · 66
- `development/tests/worker/migration-delivery.test.ts` · 18–19, 25, 41, 60, 64, 68, 77, 85, 90, 122, 124, 127, 135, 137, 141, 149, 157, 163–164, 169
- `development/tests/worker/migration-shares.test.ts` · 19–20, 44–45, 77–78, 124–125, 160, 165, 171, 176, 186, 225, 237, 242, 248, 251, 283, 288–289
- `development/tests/worker/shares-api.test.ts` · 12, 104–105, 141, 145, 150, 158, 180, 183, 188, 194, 209, 227, 235, 245, 251, 269, 278, 294, 296, 372, 399, 437–438, 461, 468, 554–555
- `development/tests/worker/spa-fallback.test.ts` · 24
- `development/tests/worker/subscription-lifecycle.test.ts` · 6, 20, 60, 68, 70–71, 77, 79–80, 104, 120, 127, 133, 142, 155, 167, 173, 181, 194, 207, 217, 221–222, 231, 236, 243, 249, 254, 261, 286, 289, 331, 359, 364–365, 384, 394, 411, 430, 437–438
- `development/tests/worker/subscription-v2-p1.test.ts` · 52, 61, 64–67, 69–70, 73, 83, 87, 89, 98, 105–106, 129, 142, 152
- `development/tests/worker/subscription-v2-p2.test.ts` · 9, 54, 68, 74, 90, 93, 95, 102, 117, 134–135, 140, 145, 157
- `development/tests/worker/subscription-v2-p3.test.ts` · 75, 174–177, 179, 187, 189, 211, 228, 238
- `development/tests/worker/templates-api.test.ts` · 105, 135, 138, 143, 148, 158
- `development/tests/worker/traffic-usage.test.ts` · 68–69, 78–79, 81–82, 85, 88–89, 101
- `development/tests/worker/user-nodes.test.ts` · 17, 33–34, 80–81, 182, 193, 227, 242, 249, 267, 269, 287, 365
- `docs/d1/KV_INVENTORY.md` · 14, 17–18, 22–26, 35, 37–38, 40–42, 44, 56, 84, 87, 89, 91, 111, 118, 120, 123, 125, 130, 132
- `docs/d1/SCHEMA.md` · 19, 30–31, 33, 64, 121, 123, 127, 132, 211, 213, 221, 253–254, 256, 324
- `docs/modal-inventory.md` · 7, 24–31, 40–41, 72
- `docs/subscription-v2-current-state.md` · 11–12, 14–16, 38, 58–63, 72–73, 81
- `docs/subscription-v2-p1-compatibility.md` · 3
- `docs/subscription-v2-p1-dry-run.json` · 4, 6, 12, 14, 20–22, 29–31
- `docs/subscription-v2-p2-dry-run.json` · 4, 9, 13, 18, 23, 27
- `docs/subscription-v2-p3-dry-run.json` · 4, 12
- `docs/subscription-v2-p4-cleanup-proposal.md` · 7–8, 13
- `docs/subscription-v2-p4-reconciliation.json` · 10, 82, 84
- `migrations/0001_init.sql` · 53, 59, 69, 75, 222, 226, 241–243, 246, 249, 252, 304–305, 307, 346, 348
- `migrations/0002_email_verification_purpose.sql` · 12, 19, 21, 28
- `migrations/0003_shares_subscription_fk.sql` · 5–6, 8, 48, 55, 66, 68
- `migrations/0005_registration.sql` · 10
- `migrations/0007_domain_stage.sql` · 3
- `migrations/0008_entitlements.sql` · 15, 18–19, 25, 38
- `migrations/0012_invite_registration.sql` · 4
- `migrations/0014_subscription_pool.sql` · 1, 5, 21, 24–25, 27, 30, 33, 39–41
- `migrations/0015_subscription_templates.sql` · 15
- `migrations/0018_subscription_plans.sql` · 1–9, 13, 16, 31–32, 35, 37–38, 40, 52–53, 55, 60–62, 65, 69, 72, 74–75, 77, 80
- `migrations/0020_conversion_profiles.sql` · 38, 44, 72, 75
- `migrations/0021_subscription_v2_p1.sql` · 3, 10–13
- `migrations/0022_subscription_v2_p2.sql` · 24–25, 28, 31, 34, 61
- `migrations/0023_subscription_v2_p3.sql` · 4, 17, 37–38, 57
- `migrations/0024_compile_jobs.sql` · 5, 25–26, 30, 37
- `migrations/0025_core_g.sql` · 17, 19
- `src/app/AppShell.tsx` · 51
- `src/app/api.ts` · 60, 178, 181, 351, 407–408, 609–610, 612–614
- `src/app/data-cache.ts` · 20–22
- `src/app/navigation.ts` · 15, 46, 48, 85, 100, 107
- `src/app/router.tsx` · 21, 32, 80–89, 91–92, 94–96, 99, 104–105, 112–114
- `src/features/accounts/UsersPage.tsx` · 202
- `src/features/catalog/GroupsPage.tsx` · 30, 52, 85–86, 102, 182, 291, 294, 329
- `src/features/dashboard/DashboardPage.tsx` · 10–11, 20–21
- `src/features/delivery/AdminSharesPage.tsx` · 28, 41, 69, 72, 80, 114–115, 120, 123, 132, 177, 180–181, 255, 257
- `src/features/delivery/MySubscriptionsPage.tsx` · 26, 36, 43, 60–61, 64, 67–68, 81, 94, 96, 99, 115, 117, 127–128, 167, 170, 187–188, 206–207, 288
- `src/features/delivery/PlansPage.tsx` · 25, 27, 29, 31, 58, 77
- `src/features/delivery/SubscriptionBatchJobs.tsx` · 12, 32, 41, 78, 88, 166, 169–171
- `src/features/delivery/SubscriptionsPage.tsx` · 49, 120, 138, 150–151, 219, 222, 227, 289, 291, 397, 452, 519, 526–527, 530, 542, 567, 592, 627, 632, 638, 738, 748, 802–804, 806, 808, 873, 876, 887, 892, 895, 962, 1049, 1058
- `src/features/delivery/UserSubscriptionPlan.tsx` · 15, 19, 36–38, 56, 66, 83
- `src/features/delivery/plan-types.ts` · 3
- `src/features/redemption/AdminRedemptionsPage.tsx` · 103, 255, 310
- `src/features/redemption/PersonalRedemptions.tsx` · 89, 101
- `src/features/redemption/api.ts` · 11
- `src/features/shares/ShareDrawer.tsx` · 77–78, 122, 197–198, 216, 225, 234, 236, 396, 414
- `src/features/shares/api.ts` · 14, 43
- `src/features/system/TemplateEditor.tsx` · 155
- `src/features/system/TemplateList.tsx` · 5, 29, 32–33
- `src/features/system/TemplatePreview.tsx` · 4, 62, 70, 76, 106
- `src/features/system/TemplatesSection.tsx` · 16, 54
- `src/features/user/HomePage.tsx` · 22, 30, 35, 45, 54–55, 63–64, 74, 80, 87
- `src/features/user/MinePage.tsx` · 74, 79–80, 96, 99, 101, 114, 121, 138, 165, 185
- `src/features/user/MyNodesPage.tsx` · 24, 48, 50, 62, 98, 125, 135, 139, 145, 182, 193, 202, 214, 221
- `src/styles/app.css` · 296
- `src/styles/pages-delivery.css` · 90
- `worker/accounts/admin-routes.ts` · 16, 74, 84, 87, 91, 93, 99, 103, 107, 111–114, 138, 165–166, 170, 172, 177, 182, 197, 199, 369–370, 375, 378, 384
- `worker/accounts/d1-repository.ts` · 238, 259, 277, 294, 297, 307–308, 311, 314, 316, 320, 365–366, 370, 375, 377, 379–380, 386, 390, 394, 396, 419
- `worker/accounts/email-verification.ts` · 31, 114, 183, 192, 195, 237
- `worker/accounts/invite-codes.ts` · 14, 26, 64, 66, 69, 77, 100, 159
- `worker/accounts/registration.ts` · 1, 223
- `worker/admin/audit.ts` · 24, 26–27, 31–32
- `worker/admin/service.ts` · 4–6, 10–11, 17–18, 56
- `worker/app.ts` · 27, 47, 50–53, 89–90, 92–93, 95–97
- `worker/catalog/d1-repository.ts` · 530, 532
- `worker/catalog/repository.ts` · 73–74, 76–78, 81, 83
- `worker/catalog/routes.ts` · 261, 265, 269, 271–272, 275, 351, 353, 368–370, 375, 421, 423–425
- `worker/db/ensure-users.ts` · 4
- `worker/db/module-switch.ts` · 40
- `worker/delivery/artifacts.ts` · 18, 30, 96
- `worker/delivery/compile-jobs.ts` · 17, 22, 28, 31–33, 36, 42, 58, 60, 65–69, 101–102, 112, 148–149, 163, 166–167, 170, 210, 212, 215, 218, 246, 251, 254
- `worker/delivery/compiler.ts` · 101, 104, 135, 160–161, 163, 166
- `worker/delivery/d1-repository.ts` · 14, 17, 22, 31, 58–59, 90, 96–97, 100, 106, 109–111, 114, 116, 118, 120, 127–128, 130, 143, 148, 156–157, 163, 166, 172, 176, 181–182, 204–209, 211, 213, 215, 217, 221, 224, 229, 232–233, 242, 244, 252, 262, 269–270, 272–273, 276–277, 279, 286–287, 291, 304, 309–310, 312–314, 316, 318, 320, 322–323, 328, 332–334, 339, 342–343, 345
- `worker/delivery/entitlement-templates.ts` · 74, 78
- `worker/delivery/expiry.ts` · 55
- `worker/delivery/fetch-stats.ts` · 54, 147–148, 154–155, 158, 161–163, 165, 167–168, 173, 182, 184, 189, 199, 201, 203, 207–209, 211
- `worker/delivery/lifecycle.ts` · 25, 39, 52, 65, 78, 118, 132
- `worker/delivery/plan-routes.ts` · 24, 28–29, 33, 37, 49, 56, 58
- `worker/delivery/plans.ts` · 26, 33–34, 36–37, 57, 61–64, 66–67, 69, 71, 75, 77, 93, 97, 100, 108, 119, 138, 144, 152, 154–155, 164, 168, 170, 172–173, 175, 177–178
- `worker/delivery/repository.ts` · 66, 83, 85, 88, 90, 92
- `worker/delivery/routes.ts` · 21, 25, 29, 55, 65, 68, 73, 138–139, 165, 181, 187, 217–218, 276, 310–311, 315, 322, 326, 339, 347, 349–350, 409–411, 416, 418, 433, 447
- `worker/delivery/schema.ts` · 6–7, 37–38, 43, 46, 50, 71–72, 75–77, 79, 81–82, 85–86, 88–89, 93–94, 96, 101, 104, 112–113, 136
- `worker/delivery/service.ts` · 18, 29, 108, 110, 117–118, 128, 131, 137–138, 142, 184, 186, 196, 203–204, 206–207, 209, 216, 218–219, 242, 244, 249, 251, 253, 257–258, 261, 280–281, 284, 291–293, 295–296, 300–301, 305–306, 309–310, 319, 324, 331, 336–337, 339, 341–343, 345–346, 348, 364, 368–369, 379, 403, 418, 421, 426, 440, 447–448, 460–461, 474–476
- `worker/delivery/subscription-batch.ts` · 19, 30–31, 35, 64–65, 75, 95, 125, 129, 140, 144–145, 147, 160, 172
- `worker/delivery/traffic-usage.ts` · 39–40
- `worker/delivery/user-nodes.ts` · 20, 52, 67, 70, 74, 104, 112, 122, 128, 139, 147, 151, 163
- `worker/domains/platforms.ts` · 1
- `worker/migration/accounts.ts` · 213
- `worker/migration/delivery.ts` · 11, 18, 29, 42, 47, 49, 59, 76–77, 81, 84, 91, 93
- `worker/migration/run.ts` · 156–157, 165, 182, 225–226
- `worker/migration/shares.ts` · 22–23, 25, 67, 80–82, 86, 104–105, 107, 151
- `worker/operations/cron.ts` · 1, 65
- `worker/public-subscriptions.ts` · 72, 80, 117
- `worker/redemption/routes.ts` · 68–69, 76, 153
- `worker/redemption/service.ts` · 14, 34, 53, 60, 107, 126, 136, 165, 169, 189
- `worker/shares/d1-repository.ts` · 30–31, 33, 95–96, 98, 122, 154, 156–157, 164, 171–173, 182, 191–192, 194, 219–220, 222, 256–257, 285, 295–296
- `worker/shares/repository.ts` · 7, 18, 27, 30, 32–34, 44, 46, 123–125, 130–132, 137, 149–150, 153, 155, 158, 175, 247, 249–250, 253, 255, 258, 260–261, 264, 266, 282, 284, 297–298, 301–302
- `worker/shares/routes.ts` · 163, 191
- `worker/shares/schema.ts` · 3, 6, 49–50, 73, 115, 141, 164
- `worker/shares/service.ts` · 142–143, 147, 151, 159, 193, 213, 236, 258, 264, 284–285, 347, 352–356, 363–366, 384, 427–429, 433, 457, 465, 487
- `worker/shares/session.ts` · 5, 12, 18, 24, 30, 59, 65, 68
- `worker/templates/repository.ts` · 58, 60, 64, 66, 104, 113, 118, 138–139, 147–148, 161, 183–184, 193, 196–198, 201, 209
- `worker/templates/routes.ts` · 19, 67, 72, 74, 86–87, 91, 137, 140, 313, 347, 562, 564, 574
- `worker/tickets/service.ts` · 44

## 回归基线

| 命令 | 实测 |
|---|---|
| `npm run check` | 成功，0 错误；Wrangler 类型最新，TypeScript 和 Oxlint 通过。 |
| `npm run build` | 成功，Worker 与客户端均构建完成。出现 Node punycode 弃用提示与 Vite 客户端分块超过 500 KB 的既有警告。 |
| `CI=1 npm test` | 成功，67/67 测试文件，576 通过、4 个显式环境变量控制的基准测试跳过、0 失败。 |

SUB_UNIFIED_PR1_DONE
