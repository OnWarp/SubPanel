# SubPanel 订阅 V2 · P0 仓库现状

审计于 2026-11-22 13:21 UTC 开始。远端默认分支为 `main`，通过 `git ls-remote --symref origin HEAD` 确认远端与审计分支 `task/sub-v2-audit` 的基底均为 `9f1aaa1b9c0dd95bca7cea9ab78c29ebeeb79fef`（CORE-D 合并提交）。Git 身份为 Muse / muse@outtw.com。证据来自此提交的源码、SQL、测试、历史交付报告和仓库内截图。生产实际 D1 结构、数据、域名设置和 Cloudflare 控制台配置未查询。

## 1. 十项现状核查

| 核查对象 | 仓库现状 |
|---|---|
| 工程结构 | `package.json`、`package-lock.json` 使用 npm；前端 React 19、React Router 7、Vite 8、TypeScript，入口 `src/main.tsx`；后端 Hono、Zod，入口 `worker/index.ts`、路由汇总 `worker/app.ts`。`npm run check` 运行 Wrangler 类型检查、TypeScript 和 Oxlint，`npm run build` 运行 TypeScript 和 Vite，`npm test` 调用 Vitest Worker 池，浏览器验证用 Playwright。 |
| 数据存储 | `wrangler.jsonc` 绑定 `DB`（D1 `subpanel-d1`）、`DATA`（KV）与 SPA 静态资源 `ASSETS`，无 R2。账号、目录、分发等仓储通过 `worker/db/module-switch.ts` 的 readiness 设置在 D1 与旧 KV 快照间切换；KV 也存会话/加密材料、派生输出和拉取统计。SQL 在 `migrations/`，最新 0020；`worker/migration/` 是 KV 到 D1 的应用迁移工具。依据 [CORE-D 交付记录](../REPORT_CORE_D.md)，生产迁移台账为空，运维用备份后逐个经批准的 SQL 文件执行 Wrangler D1 remote execute，禁止全量 remote apply；本次未连接生产 D1 验证台账。 `worker/db/db.ts` 以 `D1.batch` 原子提交，分发整体快照写入带 revision 冲突保护。0014 中 owner 可空，用户外键 RESTRICT、订阅组外键 CASCADE，0018 中计划外键 RESTRICT；具体以后续 SQL 为准。 |
| 用户模型 | `users.id` 为文本（应用使用 `usr_…`），角色 `admin/user`，0001 的部分唯一索引限制单管理员，0004 增加软删除。`accounts_d1_ready` 控制仓储读取（`worker/accounts/repository.ts`）。`session.ts` 使用 24 小时 HMAC 会话 Cookie，`auth.ts` 重读用户并根据启用、删除、角色及 sessionVersion 校验。`app.ts` 在管理 API 应用 requireAuth、requireAdmin 和审计。0014 的 `subscriptions.user_id` 仅有普通索引，实际允许零至多份和未分配订阅。 |
| 订阅模型 | 0014/0018 定义独立 `sub_…` ID、owner、名称、开始/到期毫秒值、启用、默认客户端、revision、唯一 `token_hash`、`token_prefix`、`encrypted_token`、`plan_id`、计划来源/备注/撤销标记、流量/设备/速率快照；组 ID 来自 `subscription_groups`。0018 已将旧用户权益回填至订阅并保留 `user_entitlements_legacy`。管理创建使用 `worker/delivery/service.ts#createSubscription`；计划分配与注册试用另走 `worker/delivery/plans.ts#plannedSubscriptionStatements`，复用 token 工具并直接构造 D1 写入语句。`service.ts` 还负责更新、轮换和删除，路由在 `worker/delivery/routes.ts`。可无计划创建记录，授权输出仍判断有效计划。流量字段 `traffic_gb` 的 0 表示不限额，`traffic-usage.ts` 的计量函数始终返回 null；`fetch-stats.ts` 只记录拉取结果、平台和耗时。 |
| 节点与节点组 | 0001 的 `nodes`、`node_raw_variants`、`groups`、`group_sources`、`group_nodes`、`group_node_order`，0019 增 `match_rules` 及同步状态。CORE-C 的来源范围节点键、差异预览/确认、同步租约和失败退避见 `worker/catalog/{import-service,d1-repository,routes}.ts`。组结合来源、显式包含/排除及规则，标签全匹配、协议列表任一、地区及名称正则共同过滤；解析跳过禁用节点并按显式顺序、来源、节点排序。`compiler.ts` 取计划允许组与订阅选组交集，再跨组去重。可在组内直接点选节点；订阅本身只有组引用。组删除会清理订阅引用（`catalog/routes.ts`、`delivery/service.ts`），现行行为允许结果为空。 |
| 订阅转换 | `worker/public-subscriptions.ts` 暴露 `GET /sub/:token`（按 UA，未知 UA 回退 generic）和 `GET /sub/:token/:client`（显式客户端及别名）。Mihomo/Clash/Clash Meta/Stash 共用完整规则输出，含 `mode: rule`、proxies、proxy-groups、rules 和末尾 MATCH。sing-box/Karing 已输出节点 outbounds JSON；完整路由、DNS 和规则集编译仍属 CORE-07。Surge、Loon、Quantumult X 是节点文本输出，v2rayN、NekoBox、Shadowrocket、generic 使用各自节点列表/URI 路径。输出由 `worker/renderers/index.ts` 等实现，模板只是编译输入。分享导出有独立入口 `worker/shares/routes.ts`。 |
| 域名 | `wrangler.jsonc` 声明面板自定义域 `sub.warp.dpdns.org`。0007、`worker/domains/{service,routes,host-gate}.ts` 管理 `panel_domains`、`subscription_domains`、主域 ID、平台开关及限制总开关。可维护多个启用域，主域用于生成展示地址；实际主域/启用清单属实例配置。Host gate 区分订阅和面板路由，健康/实例标识豁免，指定类别无启用域时放行；链接由 `delivery/links.ts` 和路由组装。平台开关控制面板链接展示，公开渲染实际识别的客户端集合在 `public-subscriptions.ts`。 |
| 前端 UI | `src/app/router.tsx`、`navigation.ts`、`AppShell.tsx` 提供角色路由、侧栏和移动导航。管理员走 `/delivery/subscriptions`、`/delivery/conversions`、`/plans` 和 `/users`；普通用户 `/subscriptions`、`/home`、`/me`，旧权益页面重定向至订阅列表。相关界面在 `src/features/delivery/`、`src/features/system/`。共享组件有 DataTable、Pagination、FilterBar、Dialog、ConfirmDialog、EditDrawer、FormField、SectionTabs、Toast；`src/styles/tokens.css` 与 `src/theme/ThemeProvider.tsx` 管理语义色、间距及主题。文案主要为组件内中文，未见全局中英文翻译资源或 i18n 依赖。`src/app/api.ts` 和 `data-cache.ts` 提供请求和缓存。 |
| 安全与成本 | `app.ts` 应用安全响应头、API Origin 校验及 no-store，`platform/api-error.ts` 将异常归一为错误响应，`admin/audit.ts` 写入 D1 审计，管理员写入和用户轮换审计均有覆盖。公开订阅校验 token 及生命周期后实时渲染，304 也经过实时检查；派生 KV key 为 token hash + client，产物记录订阅/目录/渲染器/模板修订，KV 不作为公开授权依据。账号登录等使用 D1 固定窗口限流，公开订阅路由未见专用限流。热点成本来自全量分发读取、目录/计划/用户解析、实时渲染、后台 KV 产物与统计处理，以及部分写操作全量重编译。管理员列表分页在内存切片，无查询参数时有兼容全量分支。远程目录和规则源有独立地址与抓取预算校验，预算数据未实测。 |
| 测试与部署 | 默认 Vitest 配置为 `development/vitest.config.ts`、`wrangler.test.jsonc`、`development/tests/worker/`，另有 node/UI 套件与 Playwright 浏览器脚本。未见 GitHub Actions 工作流；README 记载 Cloudflare Git 关联生产分支和 `npm run deploy`。仓库 Wrangler 配置仅见一个发布目标，Cron 每 15 分钟，已启用可观测性并关闭 invocation logs。可选运行变量定义见 `worker/app-env.ts`（加密/会话配置和邮件发送配置），现有材料读取见 `platform/crypto.ts`。CORE-D 灰度用复制转换配置和指定订阅绑定，回滚可切回已发布版本或基础配置再回退 Worker；兼容版本先验证新模板语法。未确认生产流量分配和自动回滚配置。 |

### 页面与旧链接基线

采用基底已经提交的浏览器截图。CORE-D 截图来自当时的本地真实 Worker 与测试数据，CORE-B/C 截图用于追溯向导和分组交互；本次未重拍或测量 1024 px。

| 页面 | 桌面 | 移动 |
|---|---|---|
| 管理订阅详情与格式 | [1440](../development/screenshots/core-d/subscription-details-1440.png) | [390](../development/screenshots/core-d/subscription-details-390.png) |
| 转换配置列表 | [1440](../development/screenshots/core-d/profiles-1440.png) | [390](../development/screenshots/core-d/profiles-390.png) |
| 用户订阅与平台格式 | [1440](../development/screenshots/core-d/user-formats-1440.png) | [390](../development/screenshots/core-d/user-formats-390.png) |
| 订阅创建向导（CORE-B） | [1440](../development/screenshots/core-b/wizard-1440.png) | [390](../development/screenshots/core-b/wizard-390.png) |
| 目录组规则（CORE-C） | [1440](../development/screenshots/core-c/group-preview-1440.png) | [390](../development/screenshots/core-c/group-preview-390.png) |

旧链接样本用测试占位路径 `/sub/<token>`、`/sub/<token>/clash`、`/sub/<token>/sing-box` 和 `/sub/<token>/generic`；公开路由以 path/UA 选格式，无已读到的选格式 query 契约。兼容基线由 `development/tests/worker/delivery-api.test.ts` 的授权、格式、ETag、缓存与模板回退用例及 [CORE-D 原生校验记录](../REPORT_CORE_D.md) 支撑。P1 对照时应保留 URL、别名、凭据、状态码、文件名/MIME、304 语义与授权节点；生产链接样本及 CPU、D1/KV 子请求数量无实测值。

## 2. 实体映射（PLAN §3.1、§15.2）

| V2 目标实体 | 状态 | 当前实体及偏差 |
|---|---|---|
| `subscriptions` | 部分存在 | 复用已一对多的 `subscriptions`（0014/0018）、`subscription_groups` 和现有 token 三字段；`user_id` 可空。缺发放来源、权益模板版本、独立完整配置快照、真实用量及目标到期索引。现有 `plan_source` 只区分 admin/trial。 |
| 发放 `subscription_templates` | 不存在 | 同名 legacy 表（0015）存 Mihomo 转换草稿及发布指针；`conversion_profiles`（0020）承载多平台转换。当前权益默认配置最接近 `plans`（0008），计划可变、可撤销，缺发放模板生命周期及版本指针。 |
| 发放 `subscription_template_versions` | 不存在 | 同名 legacy 表存发布的 YAML；`conversion_profile_versions` 含同 ID 的 Mihomo 映射及其他平台结构。两者均无期限、配额、节点权益的不可变发放快照。 |
| `subscription_node_assignments` | 部分存在 | `subscription_groups` 对组有 FK、唯一组合及排序；`plan_groups` 限制允许组。缺订阅级直接节点分配与混合去重规则。 |
| `node_groups` | 已存在 | 当前名 `groups`；含组定义和动态 `match_rules`。目标独立状态字段/索引需要按业务确认。 |
| `node_group_members` | 部分存在 | `group_nodes` 记录显式包含/排除，`group_sources` 和动态条件参与实时成员计算；成员不是单一物化关系。 |
| `redemption_batches` | 不存在 | 无订阅发放批次、固定模板版本或兑换截止。 |
| `redemption_codes` | 不存在 | 账号的 `invite_codes` 属注册验证；分享 token 属访问既有订阅。两者的语义均不同于发放新订阅。 |
| `redemption_records` | 不存在 | `invitation_redemptions` 和注册相关记录不表示订阅兑换，缺订阅发放流水及幂等约束。 |
| `subscription_events` | 部分存在 | 通用 `audit_logs` 有目标、动作和详情；现有记录覆盖一部分订阅操作，缺统一订阅事件模型以及与未来兑换的一致原子提交。 |
| `audit_logs` | 已存在 | 0010 的表含 actor、action、target、detail 和时间，`GET /api/admin/audit-logs`；目标 requestId、资源时间索引和字段脱敏契约需对齐现有实现。 |

0020 通过回填、`conversion_link_template` / `conversion_link_version` 触发器和视图投影 legacy Mihomo 同 ID 数据。旧表持有草稿、发布指针与修订，`conversion_bindings` 和 `conversion_effective_bindings` 连接平台/旧绑定；`conversion_rule_sources` 与 `conversion_local_rule_sets` 提供规则库。Legacy `inherit/specific/base` 是运行时转换选择，指定配置仍跟随其发布指针。草稿/发布/回退以及动态分组都已有实现；发放模板版本锁定的是创建时权益。由于两个概念都要独立存在，直接复用现有模板表名会发生冲突。

## 3. API 映射（PLAN §4.2、§15.3 去重）

以下 `T` 代表现有 `/api/admin/system/subscription-templates` 转换配置路由。分发路由注册见 `worker/app.ts`，处理器见 `worker/delivery/routes.ts` 和 `worker/templates/routes.ts`。

| V2 示例方法与路径 | 状态 | 真实路由、权限和缺口 |
|---|---|---|
| GET /api/admin/subscriptions | 已存在 | 同路径；兼容 `/api/admin/delivery`、`/api/admin/delivery/subscriptions`。现行分页为 page/pageSize，支持部分过滤；无目标发放来源/模板筛选及数据库游标。 |
| POST /api/admin/subscriptions | 部分存在 | 同路径和别名；已有手动/计划关联创建和输出预览，缺发放模板模式、幂等键和完整手填权益。 |
| GET /api/admin/subscriptions/:id | 不存在 | 列表返回订阅视图，创建/修改也返回单条；无单独 GET 详情处理器。 |
| PATCH /api/admin/subscriptions/:id | 部分存在 | 同路径，兼容 PUT；缺 V2 权益字段、发放追溯和新写契约。现有 token/reset、reset-token、DELETE 须保留其行为。 |
| POST /api/admin/subscriptions/:id/suspend | 部分存在 | PATCH 的 enabled=false 或 POST /api/admin/subscriptions/batch 的 disable。无独立 suspend。 |
| POST /api/admin/subscriptions/:id/resume | 部分存在 | PATCH 的 enabled=true 或 batch enable。授权还受有效期、计划撤销等状态约束，无独立 resume。 |
| GET/POST /api/admin/subscription-templates | 不存在 | 同类名称的 GET/POST T 是转换配置列表/草稿。发放模板接口缺失。 |
| GET/PATCH /api/admin/subscription-templates/:id | 不存在 | 转换用 GET/PUT T/:id 编辑草稿，POST T/:id/publish 发布。无发放模板详情/编辑接口。 |
| GET /api/admin/subscription-templates/:id/versions | 不存在 | GET T/:id/versions 与 GET T/:id/versions/:versionId 是转换版本。发放版本接口缺失。 |
| GET/POST /api/admin/redemption-batches | 不存在 | 缺批次查询、签发和导出。 |
| GET /api/admin/redemption-batches/:id | 不存在 | 缺批次详情、使用统计。 |
| POST /api/admin/redemption-batches/:id/disable | 不存在 | 缺批次停用。 |
| POST /api/admin/redemption-codes/:id/revoke | 不存在 | 缺单码作废。 |
| GET /api/admin/redemption-records | 不存在 | 通用审计列表存在，缺兑换业务查询。 |
| GET /api/me/subscriptions | 已存在 | 真实主路径 `/api/account/subscriptions`，别名 `/api/account/delivery`、`/api/account/delivery/subscriptions`、`/api/subscriptions`、`/api/user/subscriptions`；会话 principal 的 ID 过滤。 |
| GET /api/me/subscriptions/:id | 不存在 | 列表包含详情所需部分信息；已有归属校验的按 ID token 重置 POST，缺资源级 GET。 |
| POST /api/me/redemptions/preview | 不存在 | 缺登录态订阅兑换预览。 |
| POST /api/me/redemptions | 不存在 | 缺确认兑换、原子发放和重放处理。 |

## 4. 冲突及风险

1. **迁移基线已有一对多与共享创建服务。** P1 再做一次一对多回填可能扰动 0018 的历史订阅、未分配订阅、试用、分享引用及现有 token。当前创建采用分发快照计数器、读取引用再写入、D1 revision 保护；原子兑换还需要一套能与条件占位、流水及审计共同提交的写边界。D1 batch 中条件 UPDATE 零行本身不产生失败，要验证失败条件能够约束后续写入。计划分配和注册试用已提供可组合的写语句，是 P1 统一写边界必须覆盖的现有调用者。并发回归应覆盖同码与同账户幂等竞态。
2. **计划快照和实时授权叠加。** 流量/速率/设备有字段，计划组范围与计划状态仍实时参与授权。订阅可无计划但无法按 V2 的完全手动语义立即下发。P1 应先确定既有计划的授权如何兼容，P2 才能定义真正冻结的权益快照。现行开始/到期是绝对时间，需补 UTC 自然月/年计算；保留原值和旧边界行为。
3. **状态入口多个。** `lifecycle.ts` 的行级优先级是到期、撤销、禁用、无 owner、未开始；生命周期 DTO 再叠加计划、组、节点和格式诊断。公开入口、`compiler.ts#entitledNodes`、分享服务、用户节点及 `disableExpiredSubscriptions` 都参与判断或状态物化。公开到期请求可能触发禁用写入；管理员和用户列表也调用该函数。统一判定前，应将 JSON DTO 状态、公开 404/403/410/422、部分节点格式的空输出行为以及分享门槛分别固化为回归。
4. **流量没有可信计量。** 拉取统计不等同数据面流量。后端不存每订阅真实用量，也不会因耗尽拒绝下发。现有 GB 字段按 1024³ 换算且 0 表示不限额；迁移为整数 bytes 或 null 需明确换算、缺测和重置语义。设备数字段缺可见的强制执行路径；速率快照只在 compiler.ts 向部分支持 Hysteria/Hysteria2 的客户端输出写入带宽参数。
5. **双转换存储与发放模板命名重叠。** 保留 legacy 的发布、默认与旧绑定链，转换配置版本继续影响输出。新增权益模板宜用独立物理命名或经批准扩展计划领域。两处都称「模板」会让管理员误判变更作用范围。管理导航已有转换配置、分享、计划等订阅页签，整合时应保留入口和深链接。
6. **直接节点、平台许可与撤销策略还有缺口。** 当前直接点选发生在目录组内；订阅级节点快照需要明确删除、禁用、顺序、与动态组去重以及是否仍经过计划限制。平台展示开关是否要进一步限制公开格式访问，需要兼容现有链接。转换和分享缓存必须继续在权限检查之后使用。
7. **兑换功能链为空。** 注册邀请和分享机制只能作为现有权限、审计等参考。P3 需定义批次/码期限先后、每用户唯一、重试结果、明文一次性导出与密钥版本。PLAN §5.1 的统一无效响应和 §14.7 的细分错误有冲突，需明确对外反馈策略。§3.1 与 §15.2 对码级/批次级期限及幂等唯一范围也需统一。

## 5. CORE 排队项与建议顺序

| 已有或在途 | 与 V2 的关系 |
|---|---|
| A 基线、B 订阅闭环 | 已有一对多、独立 token、统一创建、列表/批量/生命周期与拉取统计。P1 优先补状态与服务边界、单条所有权读取、手动权益与兼容回归。参见 [A](../REPORT_CORE_A.md)、[B](../REPORT_CORE_B.md)。 |
| C 目录同步与分组 | P2 复用目录快照、动态条件、同步及排序，新增的是发放节点策略与订阅级直选。参见 [C](../REPORT_CORE_C.md)。 |
| D 转换中心和 Mihomo | P2 与它共享节点输入和 UI 外壳；版本存储用途独立。参见 [D](../REPORT_CORE_D.md)。 |
| E / CORE-07 | 完整 sing-box 编译、目标版本字段和客户端实测，沿转换中心交付；P1/P2 应保留格式能力和绑定接口，可与稳定授权接口后的工作并行。 |
| F / CORE-08 | 与 P1/P2 缓存、动态组更新强重叠。先定权限、目录、计划、模板及组依赖的修订边界，再由 CORE-F 做增量失效与批量任务，避免两套缓存。 |
| G 高级运营 | 与 V2 批次、审计、统计、运营入口有交点。P3 定义订阅发放流水和权限；运营查询复用其事件与报表，保持 G 原排队范围。 |
| H 流量配额路径 | 可信计量源、归因和强制路径需 Roye 决定。P1 保留显示和空计量语义；若明确纳入 P1，先变更验收、数据源和计划/订阅计数口径。 |

建议先固定 P1 的旧链接、数据及所有权边界，完成统一状态与订阅写服务，再推进 P2 权益模板及节点策略。CORE-E 保留独立交付，CORE-F 在依赖边界明确后接入。P3 发放在 P1/P2 的统一写入和不可变版本落地后开始，后续再做灰度与成本实测。

**P1 开工前请 Roye 拍板**：保留 legacy 转换表与兼容路由、发放模板采用独立实体还是从 plans 扩展、计划撤销和组变更是否继续实时影响新旧订阅、未分配订阅和手动无计划如何授权、流量计量是否纳入 P1。为 P3 预留独立的 Workers Secret（建议名称 `REDEMPTION_HMAC_KEY`）及轮换策略，由 Roye 确定绑定与运维归属；还需统一同码每账户上限、幂等范围和用户错误反馈。

## 6. 本次回归结果

| 命令 | 结果 |
|---|---|
| `npm run check` | 通过，Wrangler 类型同步，TypeScript 与 Oxlint 退出码 0。 |
| `npm run build` | 通过；Vite 提示部分代码块超过 500 kB，Node 提示 punycode 弃用。Worker 包约 1,020.69 kB，主客户端 JS 约 645.46 kB。 |
| `CI=1 npm test` | 通过，60 个文件、531 项通过，耗时 50.90 秒。Vitest 使用隔离的 Worker 测试绑定，测试夹具会初始化临时 D1。本次未执行 Wrangler 迁移命令，也未写实例数据库。 |
