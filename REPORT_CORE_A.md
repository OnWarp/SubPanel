# CORE-A 基线审计

基线 `a4fabff3d23faba3987088f8273b838bd8b6c368`，分支 `task/core-a-audit`，Git 身份 Muse / muse@outtw.com。按 PLAN_CORE.md §0、§2–§6 核对代码、迁移、入口和既有测试。迁移目录最新为 `0018_subscription_plans.sql`。矩阵的“已实现”指仓库中的实际路径，客户端实机导入、生产日志配置和规模压测需独立验证。

## §0 前置判断

| 计划判断 | 状态 | 基线证据 | 差距 |
|---|---|---|---|
| 完整订阅转换 | 部分实现 | `worker/delivery/compiler.ts#artifactFor`；`worker/renderers/index.ts#renderStructured` | Mihomo 可生成策略与规则，其他输出停留在节点或出站片段。 |
| 规则模式导入 | 部分实现 | `worker/templates/validation.ts#validateStructure`；`worker/renderers/index.ts#renderStructured` | YAML 有规则，现行输出没有 `mode: rule`，客户端本地覆盖与实机导入待测。 |
| 流量与设备限制 | 缺失 | `worker/delivery/plans.ts#planSchema`；`worker/delivery/traffic-usage.ts#measuredTrafficForSubscription` | 字段已持久化，实际计量、设备身份和超额执行均未接通。 |
| 编译扩展性 | 部分实现 | `worker/delivery/compiler.ts#compileAllSubscriptions, compileSubscription` | 全订阅串行、单订阅全客户端并行；依赖增量、队列和负载数据缺失。 |
| 客户端兼容性 | 部分实现 | `worker/renderers/index.ts#structuredSupport, prepareClientRender`；既有 renderer 测试 | 支持表和字段诊断有覆盖，仍需按客户端版本与协议组合进行实际导入。 |

## §2 订阅基础可靠性

| 功能点 | 状态 | 基线证据 | 差距 |
|---|---|---|---|
| §2.1 单一生命周期判定 | 部分实现 | `worker/delivery/plans.ts#subscriptionPlanState`；`worker/delivery/expiry.ts#assertSubscriptionAvailable, subscriptionExpiryKind`；`worker/public-subscriptions.ts#serve`；`worker/delivery/compiler.ts#entitledNodes` | 后端至少有五个不同用途的判定入口，计划状态、窗口、公共准入与渲染原因尚未统一，截止时间的等号也不一致。 |
| 管理端与用户端状态 | 部分实现 | `worker/delivery/routes.ts#view, matchesAdminSubscriptionFilters`；`src/features/delivery/expiry.ts#getExpiryState`、`SubscriptionsPage.tsx`、`MySubscriptionsPage.tsx`；`src/features/user/HomePage.tsx`；`worker/delivery/user-nodes.ts#collectUserNodes` | 列表与首页仍推断启停及到期，用户详情优先读 planState；我的节点接口补了实时计划组交集，缺少统一原因和修复映射。 |
| 公共错误契约 | 部分实现 | `worker/public-subscriptions.ts#serve`；`worker/delivery/expiry.ts#assertSubscriptionAvailable`；`worker/platform/api-error.ts#ApiError` | 已有固定代码和 HTTP，但撤销、无计划、无授权组及空输出的行为尚未按目标统一，见下表。 |
| 过期、撤销、停用实时拒绝与 KV | 部分实现 | `worker/public-subscriptions.ts#serve, refreshArtifact`；`worker/delivery/plans.ts#operateSubscriptionPlan`；`worker/delivery/compiler.ts#entitledNodes` | 正常撤销写入 enabled=0，旧链接无节点；计划停用等零输入分支仍可能成功返回空内容，KV 派生产物不参与公共响应授权。 |
| §2.2 创建向导和绑定 | 部分实现 | `src/features/delivery/SubscriptionsPage.tsx#SubscriptionsPage, EMPTY_FORM`；`worker/delivery/routes.ts#adminDeliveryRoutes`；`worker/delivery/service.ts#createSubscription` | 单抽屉覆盖用户、计划、组、时段和客户端，模板控件仅编辑时显示，缺逐步确认。 |
| 编辑三段计数 | 部分实现 | `src/features/delivery/SubscriptionsPage.tsx` 的 `planId, groupIds`；`worker/delivery/compiler.ts#selectedNodes` | 选计划可预填组，缺允许组数、已选组数与实时预计节点数并列展示。 |
| 复制订阅 | 缺失 | `worker/delivery/routes.ts#adminDeliveryRoutes`；`src/features/delivery/SubscriptionsPage.tsx` 行操作 | 已有复制链接和独立创建，缺复制配置并生成新令牌的入口。 |
| 批量管理 | 部分实现 | `src/features/delivery/SubscriptionsPage.tsx#executeBatch, actions`；`worker/delivery/plan-routes.ts#adminPlanRoutes` | 已逐条调用启停及删除，缺批量换计划、换绑定及明确逐项结果契约。 |
| 令牌重置 | 部分实现 | `worker/delivery/service.ts#resetSubscriptionToken`；`worker/delivery/routes.ts` 的 admin/account `/:id/token/reset`；两订阅页面确认交互 | 已换哈希和密文、清旧派生键并提示旧链失效，重置路径缺显式操作者审计记录。 |
| 订阅详情及诊断 | 部分实现 | `worker/delivery/routes.ts#view`；`src/features/delivery/SubscriptionDetailRows.tsx`；`SubscriptionsPage.tsx` 的 `detailsBinding` | 有时效、平台链接、有效模板和缓存诊断，缺实时授权节点数、最近拉取以及稳定诊断入口。 |
| 分享权限和内容 | 部分实现 | `worker/shares/service.ts#guard, liveSubscription, exportShare, readShareMeta, previewNodes` | 分享独立令牌和访问策略，客户端导出沿用实时授权；元数据按订阅所选组取节点名和计数，未取计划交集，允许原链时分享访问限制仅约束交付。 |
| 配额字段说明 | 部分实现 | `src/features/delivery/PlansPage.tsx`、`MySubscriptionsPage.tsx`；`worker/delivery/traffic-usage.ts#attachTrafficUsage` | 已有额度字段和无测量时省略用量的契约，需统一明确流量和设备上限的执行状态。 |
| §2.3 主域及其他域 | 已实现 | `worker/domains/service.ts#primaryDomainOriginSafe, setPrimaryDomain, getGateState`；`worker/domains/host-gate.ts`；`worker/delivery/routes.ts#view` | 主域与令牌独立；未配置可用主域时返回 `linkError`，其他域的可用性由 host gate 策略决定。 |
| 统一链接和别名 | 部分实现 | `worker/domains/platforms.ts#SUBSCRIPTION_LINK_PLATFORMS`；`worker/public-subscriptions.ts#clientAliases, clientFromUserAgent`；`worker/shares/service.ts#publicOrigin`、原链分支；`src/features/user/client-import.ts#clientImportLink` | 普通页面共享服务端 DTO，分享另拼原链且有域名回退；平台表、别名及深链缺统一契约。 |
| 自动识别及回退 | 部分实现 | `worker/public-subscriptions.ts#clientFromUserAgent, serve` | UA 未识别回退 generic Base64，显式未知平台返回 404；界面未系统说明自动识别与节点订阅的差异。 |
| 展示前验证兼容性 | 与计划描述不符 | `worker/delivery/routes.ts#view`；`src/features/delivery/platforms.ts#orderLinkEntries, pickPrimaryLink` | 链接遍历平台清单，诊断另读 KV；平台展示设置只过滤呈现，链接可与实际无输出并存。 |
| ETag、条件请求、授权顺序 | 已实现 | `worker/public-subscriptions.ts#serve`；`worker/delivery/compiler.ts#artifactFor` | 先生成实时产物再比较内容哈希；支持列表和弱标签，响应 no-store，空产物不走 304，未处理 `*`。 |
| 令牌日志、Referer 与复制 | 部分实现 | `worker/public-subscriptions.ts#serve, refreshArtifact`；`worker/platform/http.ts` 的 `Referrer-Policy`；`worker/app.ts#onError`；`wrangler.jsonc#observability`；`src/app/clipboard.ts` | 应用专用事件省略令牌，剪贴板和二维码在本地生成；通用异常记录、平台请求日志和同源 Referer 缺可验证的全链路脱敏。 |

| 公共请求情形 | 代码路径及当前结果 |
|---|---|
| 格式错的令牌、无匹配、无用户、停用 | `serve` 返回 404 `SUBSCRIPTION_NOT_FOUND`，已匹配且过期优先。 |
| 过期、待生效 | `serve` 检查 `expiresAt <= Date.now()` 后调用过期清理，正常返回 410 `SUB_EXPIRED`；`assertSubscriptionAvailable` 对待生效返回 403 `SUB_NOT_STARTED`。 |
| 撤销、用户停用或删除 | `operateSubscriptionPlan` 撤销同步停用行，返回 404（管理端显式重新启用会清撤销标记）；`entitledNodes` 的 `ownerUnavailable` 同样映射 404。 |
| 无计划、计划停用、无授权交集、无启用节点 | `entitledNodes` 返回 `noPlan/noGroupIntersection/noEnabledNodes`；零输入时 Mihomo 返回 422 `SUBSCRIPTION_NO_NODES`，其他客户端可返回 200 空列表或无用户节点的骨架。 |
| 有输入、无兼容输出 | 422 `SUBSCRIPTION_NO_NODES`，附 `incompatible` 原因。 |
| 未知客户端、存储或渲染故障 | 404 `SUBSCRIPTION_CLIENT_NOT_FOUND`；存储与未知渲染异常用 500 `SUBSCRIPTION_RENDER_FAILED`；已知渲染错误保留代码，如 500 `TEMPLATE_OUTPUT_INVALID`。 |

计划状态内部有 `none/revoked/expired/pending/active/disabled`。编译在窗期与启用前置检查后确认 owner，取现行计划与所选组的交集，调用组解析并按节点 ID 去重，再做目标平台过滤。公共请求每次哈希查当前订阅，转移所有权时同步换令牌，新链接按新 owner 和现行权限判断；本结论以请求取得的实时快照为准，跨表并发原子性和生产副本可见性未经实证。

## §3 来源、节点、分组

| 功能点 | 状态 | 基线证据 | 差距 |
|---|---|---|---|
| §3.1 三种来源、格式识别及覆盖 | 部分实现 | `worker/catalog/schema.ts#sourceTypeSchema, importFormatSchema`；`worker/import/detect.ts#detectImport`；`src/features/catalog/SourcesPage.tsx` | 支持远程、手动、文件及 URI、Base64、Mihomo、sing-box、Surge、Loon、Quantumult X、SIP008 自动识别，缺人工强制格式。 |
| 同步差异预览、确认 | 部分实现 | `worker/catalog/routes.ts` 的 `POST /preview`；`worker/catalog/import-service.ts#applyImport, refreshSource` | 文本预览有格式、节点和警告，缺基于现状的新增、更新、失效、重复、跳过、失败计数与同版本确认。 |
| 失败保留及连续失败 | 部分实现 | `worker/catalog/schema.ts#sourceSchema`；`worker/catalog/import-service.ts#refreshSource` | 默认 keepOnFailure 并保留成功数据，关闭时取消来源关联且可删节点；有最后失败码，缺连续失败状态。 |
| 调度、手动刷新、取消 | 部分实现 | `worker/operations/cron.ts#selectDueSource, runCron`；`worker/catalog/routes.ts` 的 `POST /sources/:sourceId/refresh` | 按来源间隔每次 cron 选最早到期的一个，缺退避、抖动、重叠任务协调及取消。 |
| 同步运行记录及观测 | 部分实现 | `worker/operations/cron.ts#CRON_KEY, cronStatusSchema`；`worker/catalog/import-service.ts#summarizeSource, refreshSource` | KV 仅存最近 cron 快照；来源有成功/尝试时间、格式及错误码，缺逐次运行、真实耗时、HTTP 状态、ETag 与变化计数；URL/Header 加密，摘要仅暴露必要信息。 |
| 远程拉取安全 | 部分实现 | `worker/catalog/remote.ts#validateRemoteUrl, validateRemoteHeaders, fetchRemoteTextWithMetadata` | HTTPS、地址筛选、逐跳检查、15 秒、最多三跳、5 MiB 流式读限制已有；DNS 解析边界及运行时解压后的限制需专门验证。 |
| §3.2 稳定身份、来源隔离 | 与计划描述不符 | `worker/import/fingerprint.ts#canonicalNodeJson, fingerprintNode`；`worker/catalog/import-service.ts#applyImport` | 协议及连接字段哈希不含名称，但全局合并同指纹并附加 sourceIds，与来源隔离目标相反。 |
| 来源追溯与名称覆盖 | 部分实现 | `worker/catalog/schema.ts#nodeSchema, rawVariantSchema`；`worker/catalog/import-service.ts#applyImport` | 已有 sourceIds 和带 sourceId 的原始版本；稳定指纹命中时保留现有名称和排序，缺独立 origin ID 与显示覆盖字段。 |
| 标签、最后出现、延迟下线 | 缺失 | `worker/catalog/schema.ts#nodeSchema`；`worker/catalog/import-service.ts#applyImport` | 缺 tags、lastSeenAt 和 missingSince；成功同步未出现时立即解绑，最后一个来源消失时删除非保留节点。 |
| 按平台兼容性 | 部分实现 | `worker/renderers/index.ts#prepareClientRender`；`worker/delivery/routes.ts#view` | 编译诊断有协议、字段和跳过/降级原因，节点管理缺逐平台标记。 |
| 原文保护 | 部分实现 | `worker/catalog/d1-repository.ts#variantInsert`；`worker/catalog/routes.ts#safeNode, safePreviewNode`；`worker/delivery/user-nodes.ts#collectUserNodes` | 来源全文、URL、Header 加密，节点 raw variants 以明文存于 D1 并由 DTO 限制；实际客户端产物自然携带授权连接参数。 |
| §3.3 表格、筛选、添加及批量 | 部分实现 | `src/features/catalog/NodesPage.tsx#NodesPage`；`worker/catalog/routes.ts` 的节点 PATCH | 有资源表格、搜索、筛选及选中后的批量操作，独立添加、完整分组与最后同步列未齐。 |
| 节点编辑、复制、测试转换 | 部分实现 | `src/features/catalog/NodesPage.tsx` 的 `EditDrawer`；`worker/catalog/routes.ts` 的节点 PATCH；`worker/renderers/index.ts#requiredNodeFields` | 当前抽屉仅基础操作，缺完整协议表单、字段联动校验、节点复制和节点级转换预览。 |
| §3.4 解析公式与顺序 | 已实现 | `worker/catalog/groups.ts#resolveGroupNodes`；`worker/delivery/compiler.ts#selectedNodes` | 启用来源命中并指定包含，再排除并过滤停用节点；优先手工顺序，余项按来源权重、节点 order、ID，跨组保持首次出现。 |
| 规则预览及动态筛选 | 部分实现 | `src/features/catalog/GroupsPage.tsx`；`src/features/catalog/catalog-counts.ts`；`worker/catalog/schema.ts#groupSchema` | 现有计数未拆命中、停用和平台不兼容；模型缺标签、协议、名称正则、地区条件及优先级。 |
| 影响分析与失效 | 部分实现 | `src/features/catalog/GroupsPage.tsx#affectedSubscriptions`；`worker/catalog/routes.ts` 的组写入；`worker/delivery/compiler.ts#recompileAfterCatalogChange` | 删除确认按当前订阅选组统计；编辑前缺计划交集影响和仅受影响订阅失效。 |
| 引用删除守卫 | 与计划描述不符 | `worker/catalog/routes.ts` 的 `DELETE /groups/:groupId`；`worker/delivery/service.ts#removeGroupReference`；`migrations/0008_entitlements.sql#plan_groups` | 当前读交付状态后删除、清引用并重编，缺有效计划/订阅约束及显式替换流程。 |

## §4 转换中心

| 功能点 | 状态 | 基线证据 | 差距 |
|---|---|---|---|
| §4.1 既有模板与升级兼容 | 部分实现 | `migrations/0015_subscription_templates.sql`、`0017_template_enhancements.sql`；`worker/templates/repository.ts#bindingSchema, getEffectiveTemplate`；`worker/delivery/compiler.ts#artifactFor` | Mihomo 有草稿、发布指针、版本、默认与 inherit/specific/base；缺通用平台 profile 和兼容迁移，只有 Mihomo 消费有效模板。 |
| §4.2 节点层转换 | 部分实现 | `worker/renderers/index.ts#prepareClientRender, namedNodes, renderStructured`；`worker/delivery/compiler.ts#selectedNodes` | 现有过滤、重名处理、按 ID 去重和字段诊断；缺可配置前后缀、重命名、过滤、排序及去重策略。 |
| 策略层、规则层、客户端层 | 部分实现 | `worker/templates/validation.ts#validateTemplate, expandTemplate`；`worker/renderers/index.ts#renderStructured` | Mihomo 支持若干策略组、规则及 provider；缺通用分层定义和各平台 DNS、TUN、端口、嗅探、GeoData 等适配。 |
| §4.3 Mihomo 有效配置和模式 | 部分实现 | `worker/templates/validation.ts#validateStructure, validateGroups, validateRules`；`worker/renderers/index.ts#renderStructured` | 已输出 proxies、proxy-groups、rules 并验证组引用、目标、末尾 MATCH 和 provider 引用；`mode` 不在模板允许顶层键，基础输出也未设置，导入后检查提示与实机验证待补。 |
| sing-box 原生完整配置 | 部分实现 | `worker/renderers/index.ts#singboxOutbound, renderStructured, structuredSupport` | 有 outbounds、selector/direct 和节点诊断，缺 route、dns、rule_set 及按目标版本的配置验证。 |
| Surge/Loon/Quantumult X 能力分级 | 部分实现 | `worker/renderers/index.ts#renderStructured`；`worker/domains/platforms.ts#SUBSCRIPTION_LINK_PLATFORMS` | 已有节点输出但无完整策略规则配置或可供界面显示的能力等级。 |
| §4.4 导航、列表、基础/高级编辑 | 部分实现 | `src/app/navigation.ts`；`src/features/system/TemplatesSection.tsx`、`TemplateList.tsx`、`TemplateEditor.tsx` | 设置内已有 Mihomo 模板列表、引用和 YAML 编辑；缺订阅下的转换页签、支持平台及基础/高级表单双模式。 |
| 预览、发布、差异、回滚、灰度 | 部分实现 | `worker/templates/routes.ts` 的 `/preview`、`/:id/publish`、`/:id/versions`、`/:id/rollback`；`src/features/system/TemplatePreview.tsx` | 可按订阅预览结构、校验、发布和回滚；缺跨平台及节点样本选择、完整产物差异与可执行灰度。 |
| 规则库与用户端选择 | 部分实现 | `worker/templates/validation.ts` 的 `providerSchema`；`src/features/delivery/MySubscriptionsPage.tsx` | 用户可切换平台并无任意规则 URL 编辑入口；缺版本化规则库、格式类型选择与可靠导入指引。 |
| §4.5 远程规则来源与安全 | 部分实现 | `worker/templates/validation.ts#validateStructure, validateTemplate` 及 `providerSchema`；`worker/templates/routes.ts#loadRemoteCandidate`、发布分支 | 有结构限制、provider URL 校验、Mihomo 客户端引用与模板导入的条件请求；provider 不是服务端规则下载任务，发布未检查引用可用性，规则版本缓存、失败保留与远程内容限额未齐。 |
| §4.6 转换诊断和定位 | 部分实现 | `worker/templates/routes.ts` 的 `/preview`；`worker/delivery/compiler.ts#artifactFor`；`worker/delivery/routes.ts#view`；`src/features/delivery/DiagnosticList.tsx` | 渲染有输入、输出、跳过、原因以及版本，预览有规则校验与结构片段；缺统一输入/已授权/输出/跳过漏斗、输出摘要及订阅详情跳转对应版本。 |

### CORE-02 平台能力矩阵

判定针对该仓库实际生成的产物。`worker/renderers/index.ts#renderStructured, prepareClientRender` 是格式依据，`worker/public-subscriptions.ts#clientAliases, clientFromUserAgent` 负责路由。完整规则配置表示产物带策略及规则；客户端导入及本地模式由后续实机验收确认。

| 平台或入口 | 等级 | 证据和边界 |
|---|---|---|
| Mihomo | 完整规则配置 | YAML 含 proxies、policy groups、rules，基础配置仅 MATCH,Proxy；有效模板可扩展规则及 providers。缺显式 rule mode。 |
| Clash | 完整规则配置 | 别名走 Mihomo YAML；旧 Clash 对 Mihomo 扩展字段和协议的兼容性未证实。 |
| Clash Meta | 完整规则配置 | `clash-meta` 走同一 Mihomo 输出；按实际版本验收。 |
| Stash | 完整规则配置 | `stash` 走同一 Mihomo 输出；缺 Stash 专用适配与验证。 |
| sing-box | 仅节点 | JSON 只有 outbounds（含 selector/direct），无 DNS 或路由。 |
| Karing | 仅节点 | `karing` 复用 sing-box 出站 JSON。 |
| Surge | 仅节点 | `[Proxy]` 与 `[Proxy Group]`，缺 `[Rule]`。 |
| Loon | 仅节点 | `loonLine` 生成逐行节点。 |
| Quantumult X | 仅节点 | `serializeShareUri` 生成逐行 URI，缺原生完整配置段。 |
| v2rayN / v2rayNG | 仅节点 | UTF-8 URI 行的 Base64，`v2rayng` 映射 v2rayN。 |
| NekoBox | 仅节点 | URI Base64，`neko-box` 是别名。 |
| Shadowrocket | 仅节点 | URI Base64。 |
| generic | 仅节点 | URI Base64，未知 UA 回退；显式路径存在，平台展示表没有此条。 |
| auto | 随命中平台 | 无后缀 URL，UA 选择上述格式；缺少匹配时使用 generic，和订阅默认客户端选择独立。 |

## §5 分发、刷新和性能

| 功能点 | 状态 | 基线证据 | 差距 |
|---|---|---|---|
| §5.1 全量编译范围与触发 | 与计划描述不符 | `worker/delivery/compiler.ts#compileAllSubscriptions, compileSubscription, recompileAfterCatalogChange`；`worker/catalog/import-service.ts#recompileDelivery`；`worker/delivery/routes.ts` 的 PATCH/PUT；`worker/delivery/plan-routes.ts` | 遍历全部订阅，启用行各编译九个客户端，停用行清前缀；目录改动、订阅编辑和计划操作可触发全量，尚无依赖定位。 |
| 来源、计划、配置发布的定向失效 | 缺失 | `worker/delivery/plans.ts#savePlan`；`worker/templates/routes.ts` 的 publish/rollback/default/bindings；`worker/templates/repository.ts#checkTemplateReferences` | 模板已能统计引用，实时渲染读现行指针；模板写入缺定向刷新，计划虽然更新绑定订阅 revision，路由仍全量编译。 |
| 公共按需服务及缓存键 | 部分实现 | `worker/public-subscriptions.ts#serve, refreshArtifact`；`worker/delivery/repository.ts#compiledKey`；`worker/delivery/compiler.ts#artifactFor` | 每次实时授权并编译；键为 `compiled:<tokenHash>:<client>`，订阅 revision、全局目录 revision、模板版本和 renderer 版本在值内，尚无相关依赖 revision 或授权后复用响应体。 |
| 缓存诊断一致性 | 部分实现 | `worker/delivery/routes.ts#view`；`worker/templates/routes.ts` 的 publish/rollback/default | DTO 检查订阅/全局目录 revision 与 renderer 版本，未与当前模板版本及实时状态对齐，模板指针变化后可展示旧诊断。 |
| 批量任务和规模验收 | 缺失 | `worker/delivery/compiler.ts#compileAllSubscriptions`；`worker/operations/cron.ts#runCron`；`wrangler.jsonc` | 缺编译分页、后台队列、断点续做，以及 1/100/1,000/10,000 订阅与突发拉取度量。 |
| §5.2 D1/KV 分工 | 部分实现 | `worker/delivery/repository.ts#readDelivery, writeDelivery`；`worker/catalog/repository.ts#readCatalog`；`worker/accounts/repository.ts#readAccounts`；`worker/db/module-switch.ts`；`worker/platform/crypto.ts` | 模块就绪后权威数据走 D1，迁移前仍读 KV 状态；另有 KV 密钥、派生编译、cron 和限流等用途。 |
| 轮换、停用、过期、转移与回退 | 部分实现 | `worker/delivery/service.ts#resetSubscriptionToken, transferSubscription, disableExpiredSubscriptions`；`worker/public-subscriptions.ts#serve` | 轮换与转移更换哈希，过期和停用在实时路径拒绝；编译失败直接返回错误，缺受授权与版本约束的可选回退。 |
| 公共限流、异常抓取监控、脱敏 | 部分实现 | `worker/public-subscriptions.ts#serve, refreshArtifact`；`worker/accounts/rate-limit.ts`；`wrangler.jsonc#observability` | 公共订阅记录脱敏的局部失败事件；现有账户限流未接该路由，缺订阅抓取监控和全链路日志脱敏验证。 |
| §5.3 拉取统计 | 缺失 | `worker/public-subscriptions.ts#serve`；`worker/delivery/compiler.ts#artifactFor` | 没有 last_fetch_at、平台/成功失败/状态码/耗时聚合或采样队列；产物 lastModified 是编译时间。 |

## §6 配额、设备和用户体验

| 功能点 | 状态 | 基线证据 | 差距 |
|---|---|---|---|
| §6.1 配额声明、实测和计量接入 | 部分实现 | `worker/delivery/plans.ts#planSchema, listPublicPlans`；`worker/delivery/traffic-usage.ts#measuredTrafficForSubscription, trafficUsageFromMeasurement, attachTrafficUsage`；`src/features/user/home-traffic.ts#homeTrafficLine` | 额度声明与有效期/分组授权已存在，计划编辑器已有“仅展示”提示，测量函数恒返回 null，运行时省略用量；可信上报方、计量窗口、幂等、时钟/回滚保护、审计和超额策略均未实现。 |
| §6.2 设备限制及执行说明 | 部分实现 | `worker/delivery/plans.ts#planSchema`；`worker/delivery/routes.ts#view`；`worker/public-subscriptions.ts#serve` | deviceLimit 只是存储及展示字段，管理端标“仅记录”，未注册设备、以身份绑定或封禁，UA 仅选格式；需统一说明未执行。 |
| §6.3 我的订阅摘要与操作 | 部分实现 | `src/features/delivery/MySubscriptionsPage.tsx` 的 `selected, primaryLink, importHref`；`worker/delivery/routes.ts#userSubscriptionView` | 已展示名称、状态、时效、复制与导入；缺独立的实时可用节点数及服务端兼容性保证。 |
| 展开、信息最小化与类型标签 | 部分实现 | `src/features/delivery/MySubscriptionsPage.tsx` 的 `linkEntries, linkQr, diagnostics`；`worker/delivery/routes.ts#view, userSubscriptionView` | 已有平台切换、二维码和错误诊断；用户 DTO 复用管理员投影，仍包含 userId/groupIds、tokenPrefix 与诊断内部引用，缺明确配置版本、更新说明及完整规则/仅节点标签。 |

`speedLimitMbps` 有独立的有限作用，`worker/delivery/compiler.ts#speedLimitedNodes` 仅调整部分平台上 Hysteria/Hysteria2 的渲染参数。客户端配置下发与服务端流量、设备执法属于不同路径。

## API 与数据流交接

| 入口 | 现行流向与证据 |
|---|---|
| `/api/admin/catalog` | `worker/catalog/routes.ts` 挂载预览、来源创建/编辑/刷新、节点 PATCH 与组 CRUD；`import-service.ts#applyImport` 写目录后触发编译。 |
| `/api/admin/subscriptions`、`/api/account/subscriptions` | `worker/app.ts` 还有 delivery 与历史用户订阅别名；`worker/delivery/routes.ts#view` 装配 DTO，管理端支持分页与全量旧契约。 |
| `/api/admin/plans`、计划授予/续期/切换/撤销 | `worker/delivery/plan-routes.ts` 调用 `plans.ts#savePlan, operateSubscriptionPlan`，D1 订阅存 plan_id、plan_revoked 与额度快照。 |
| `/api/admin/system/subscription-templates` | `worker/templates/routes.ts` 处理草稿、预览、发布、回滚、默认及绑定，D1 三类实体和默认指针由 `templates/repository.ts#getEffectiveTemplate` 解析。 |
| `/sub/:token[/:client]` | `worker/domains/host-gate.ts` 校验 Host；`public-subscriptions.ts#serve` 查令牌、授权、生成产物、比较 ETag，再异步刷新 KV 产物。 |
| `/api/shares`、`/api/user/nodes` | `worker/shares/service.ts#guard, exportShare, readShareMeta` 管独立分享能力；`worker/delivery/user-nodes.ts#collectUserNodes` 返回交集后的用户节点投影。 |

## B–F 施工边界与依赖

| 线 | 做哪些 | 保持现有边界 | 依赖 |
|---|---|---|---|
| B · 订阅闭环 | 在 delivery 建统一状态与实时授权结果，覆盖各窗期边界、计划撤销、owner、组、空节点和平台不兼容；统一安全 DTO、链接/别名、兼容结果先于展示、授权先于 304，补分享元数据授权、重置审计、诊断、向导/复制/批量流程。 | 保留现有 URL、令牌格式、域名策略和模板绑定语义；目录身份归 C，规则输出归 D/E，产物存储策略归 F。 | 现行 `subscriptionPlanState`、`resolveGroupNodes`、`renderEntitledSubscription`、展示平台表、既有 delivery/shares 测试；依赖 D/E 提供的能力描述接口可先按基线输出落地。 |
| C · 来源、节点、分组 | 在 catalog 复用解析及拉取，提供差异及版本化确认、保留与连续失败、同步运行历史和去重调度；为来源稳定身份、别名覆盖、延迟下线与 raw 保护加向前兼容迁移；加入协议编辑、组预览及引用删除守卫。 | 保留 URL/令牌及 entitlement 的表示；共享节点拆分必须保留已有组引用及顺序；实际增量编译由 F 接消费。 | `fingerprintNode`、`applyImport`、`resolveGroupNodes`、D1 目录及计划引用外键；与 B 对齐实际授权节点预览，与 F 对齐目录变化事件。 |
| D · Mihomo 转换 MVP | 延伸既有模板验证器和 compiler，支持显式 rule mode，补策略/规则/provider 验证、可定位诊断、产物预览差异、发布回滚与客户端导入；建立平台感知 profile/版本/绑定接口并兼容旧 Mihomo 模板，复用设置入口并在订阅导航提供转换页。 | 保留旧模板 ID、版本和 inherit/specific/base 及现有链接；各非 Mihomo 适配由 E 交付；B 保持授权权威。 | 0015/0017 表、`getEffectiveTemplate`、`validateTemplate`、`TemplateEditor` / `TemplatePreview`、B 的授权诊断；给 E 提供 profile 与 renderer 接口。 |
| E · 多平台转换 | 在共享接口上实现明确目标版本的 sing-box DNS/route/rule_set 原生编译，验证字段迁移与客户端导入；其他平台明确节点等级，完整策略/规则实现随对应适配器和验证交付；处理别名对应版本、未支持协议与字段提示。 | 保留 Mihomo 版本/绑定行为、现有节点订阅路径和别名；不扩大授权范围。 | D 的 profile/适配器接口、B 的授权输出和能力标记、现行 `structuredSupport` 夹具，以及目标客户端实机。 |
| F · 增量编译 | 从来源/节点/组、计划和 profile 事件计算受影响订阅及平台，建立相关目录 revision 与版本化键、按需读取/回退约束、幂等分页和任务重试；按计划规模压测，比较全量基线与增量开销。 | 公共请求保留 B 的实时授权先行，KV 持续保存派生结果；保持 B/C/D/E 的业务契约。 | B 的状态与权限契约、C 的目录变化和依赖映射、D/E 的 profile/renderer 版本；现有 KV 诊断消费者需一起升级。 |

## 基线验收

使用仓库已安装依赖。测试工作在基线业务代码上，报告为唯一交付变更。`npm run check` 退出 0，Wrangler 类型检查、TypeScript 和 oxlint 均通过。`npm test` 退出 0，Worker 59 个文件、518 项通过。既有 `development/tests/worker/delivery-api.test.ts` 覆盖条件请求、缓存产物与禁用/删除、订阅与分享的时间窗行为、旧令牌、模板发布/回滚及过期后匹配 ETag 仍拒绝；其余矩阵结论按所列静态路径核对。

| 既有套件命令 | 文件 | 通过 |
|---|---:|---:|
| `npm test` | 59 | 518 |
| `vitest run --config development/vitest-pages-node.config.ts` | 15 | 228 |
| `vitest run --config development/vitest.controls.config.ts` | 8 | 36 |
| `vitest run --config development/vitest-subscriptions-node.config.ts` | 3 | 14 |
| `vitest run --config development/vitest.templates.config.ts` | 5 | 93 |

额外 Vitest 套件使用仓库本地二进制。运行时有 punycode 弃用和 SQLite 实验特性提示。实机客户端、生产环境、负载压测和迁移回滚演练超出本次审计验证范围。

CODEX_CORE_A_DONE
