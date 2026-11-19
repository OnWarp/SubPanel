# SubPanel 附加配置完善开发方案

文档日期为 2026-11-20。代码核对基线为主分支提交 `a818d3a74b3bf6fcd43ddf02583db70b4b749814`。本文是在现有初版基础上的开发设计，新增字段、接口响应和组件均为建议实现。

## 1. 交付目标与现状

管理员维护分流模板，用户刷新原有 Mihomo 订阅地址，得到自己的授权节点、策略组和分流规则。规则模式里能手动选择节点，模板更新、回退后刷新可生效。节点名单始终根据当前账号、权益和订阅计算。

当前主分支已经实现以下能力，开发应直接完善这些模块。

| 已有位置 | 当前能力 | 本次完善重点 |
|---|---|---|
| `worker/templates/routes.ts` | 模板列表、草稿、默认模板、绑定、发布、回退、归档、预览和远程导入 | 版本冲突、结构化诊断、影响范围、分页和操作一致性 |
| `worker/templates/repository.ts` | D1 模板与版本读取，订阅绑定及默认解析 | 在同一数据库快照中确定有效版本，明确故障处理 |
| `worker/templates/validation.ts` | YAML 解析、select 组、动态节点、规则目标、循环和兜底检查 | 校验边界、规则语法、资源路径、定位信息 |
| `worker/delivery/compiler.ts` | `renderEntitledSubscription` 获取实际权益节点并解析模板 | 下发与预览共用快照，缓存门槛和零节点诊断 |
| `worker/renderers/index.ts` | 注入授权节点、展开模板、处理节点与组名称冲突 | 保证稳定命名，确定性输出，保留兼容诊断 |
| `src/features/system/TemplatesSection.tsx` | 分发设置中展示模板、编辑器和 JSON 预览 | 列表与编辑区分开，清晰呈现策略组与规则 |
| `src/features/system/TemplateBinding.tsx` | 订阅上立即保存继承、基础或指定模板 | 与编辑抽屉的保存语义统一，避免取消后绑定已变化 |

当前发现的具体改进点来自源码核对，尚未运行该版本的测试。发布读取已保存草稿而编辑框可继续修改，用户容易误判发布内容。草稿更新没有版本比较，可能覆盖其他管理员的编辑。预览缺少规则集结构。列表接口返回全部草稿，前端默认把编辑表单持续展开。公开下发在实时渲染前仍要求旧 KV 产物存在且版本匹配，可能让有效订阅因缓存缺失而返回 404。

## 2. 功能范围与产品决策

本次交付覆盖 Mihomo 完整 YAML，包含 select 策略组、内联规则、HTTPS rule-providers、手动远程模板导入、单订阅绑定、全局默认、草稿发布、历史回退、归档与实际节点预览。

沿用 `$SUBPANEL_NODES` 占位符以及现有 YAML 字段集合。自动测速组、地区筛选、Subconverter INI、MiSub 占位符适配、其他客户端模板和定时远程模板更新放到后续独立版本。界面按支持的格式明确提示兼容范围。

远程模板采用管理员手动导入、校验后发布的版本快照。用户拉取时使用已发布快照，远端修改在管理员重新导入并发布后生效。rule-providers 指向的远程规则集由客户端获取，属于独立更新链路。

| 订阅模式 | 解析结果 |
|---|---|
| inherit | 当前全局默认模板的已发布版本；全局为基础时使用内置输出 |
| base | 当前内置 Proxy 手动组和 MATCH 兜底 |
| specific | 指定模板当前已发布版本 |

旧订阅无绑定行时视为 inherit。新增或补全默认设置时保留已有值。使用同一模板的订阅跟随其发布版本，暂不增加固定历史版本绑定。

## 3. UI 与操作路径

### 3.1 入口与布局

沿用 `/system/distribution`，在「域名与平台展示」「分享策略」的同级放「附加配置」。区域使用标题、行和细分隔线，避免多层卡片。配置列表为默认视图，点击新增或编辑再打开独立编辑视图。可用 `?config=<id>` 定位对象，`?config=new` 新增，浏览器返回恢复原列表。

| 区域 | 展示与操作 |
|---|---|
| 列表头 | 标题「附加配置」，右侧主按钮「新增配置」 |
| 默认配置行 | 选择器显示基础配置或已发布模板，显示实际发布版本；选择后立即保存并提供成功或失败反馈 |
| 列表列 | 名称、状态、当前发布版本、更新时间、引用数、操作 |
| 行操作 | 编辑直接露出；更多菜单包含预览、版本历史、复制为新配置、归档 |
| 状态 | 草稿、已发布、有未发布更改、已归档，使用短文字和克制色彩 |
| 空状态 | 「暂无附加配置」及新增操作，默认配置仍可显示基础配置 |

默认模板更改时先展示影响摘要，例如「将影响 28 条继承默认的订阅」，由管理员提交该变更。首版可复用确认对话框。模板编辑保存与发布各自只有一个明确的主要动作。

### 3.2 编辑视图

顶部显示返回、配置名和状态。正文依次为名称、来源、YAML 编辑器、校验结果。桌面编辑器与预览可并列，手机切换「编辑／预览」。使用现有 Controls、FormField、Dialog、Toast 和页面容器，不引入新的视觉体系。YAML 可用等宽字体，长行在编辑器内部滚动。

来源为「直接编辑」或「远程地址」，切换只改变来源输入区。新配置可以先填写地址直接导入为内存草稿，再一次保存。编辑现有配置时远程导入先进入本地编辑内容，保存时才写入草稿，避免导入覆盖未提交内容。导入结果显示获取时间和忽略字段，原始 URL 的查询参数按敏感内容处理。

底部提供「保存草稿」「预览」「发布」。存在未保存更改时，发布不可点击并显示「先保存草稿」。发布确认显示名称、草稿修订和影响条数。离开有未保存更改的页面时提示保存或放弃。修改 YAML、切换模板或切换预览订阅时清除旧预览。

校验错误出现在编辑器下方，显示字段路径、错误说明和能够确定的行号。字段被忽略时列出实际字段名，管理员确认后发布。所有按钮支持键盘、可见焦点和加载状态，提交失败保留编辑内容。

### 3.3 预览

预览顶部选择「仅校验」或具体订阅，订阅选择支持搜索并加载完整分页。结果展示节点数、策略组、规则、规则集，最后提供展开的 YAML 结构。策略组可展开看成员名称，规则保持原顺序。首版预览 YAML 仅包含策略结构与规则集，命名为「策略配置预览」，避免误导为完整可导入文件。

实际节点数为零时展示原因；订阅停用、未分配用户、未生效或已过期时显示明确阻断状态。草稿语法可校验，生产可下发性单独标明。发布无需强制选择某个有效用户，发布前的结构校验为必经步骤，生产订阅预览作为管理员核验工具。

### 3.4 订阅绑定与用户侧

订阅编辑抽屉保留「附加配置」字段。选择指定模板后才显示模板选择器，下面显示当前生效模板和发布版本。选择只更新表单，点击抽屉「保存」统一提交。新建订阅时也支持绑定。服务端必须保证订阅与绑定保存一致，再反馈成功。

用户仍使用订阅页现有客户端选择和导入按钮。Mihomo 入口名称明确为「Clash／Mihomo」。模板配置细节由管理员维护，用户端无须增加模板选单。链接生成继续使用主订阅域名，分享页获取同一订阅时也沿用当前绑定与权限判定。

## 4. 模板格式与校验

```yaml
proxy-groups:
  - name: Proxy
    type: select
    proxies:
      - "$SUBPANEL_NODES"
      - DIRECT
rules:
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
  - MATCH,Proxy
```

示例仅为可测试的 IPv4 私网直连模板，作为新增草稿的起始内容。其他局域网与 IPv6 规则由管理员按实际环境添加。

只接收 proxy-groups、rules、rule-providers。完整配置内的 proxies、proxy-providers、DNS、端口等在导入规范化时列为忽略字段，持久化原始草稿和规范化结果。用户授权节点由生成器填入。模板中的组成员允许保留目标、组引用和动态节点占位符，节点名通过占位符统一引入。

| 校验项目 | 处理要求 |
|---|---|
| YAML | 单个对象文档、唯一键、限制别名展开、拒绝未知标签；使用项目 yaml 依赖 |
| 大小与数量 | 沿用当前 5 MiB 字节上限；建议起始上限为 100 组、100 个规则集、20,000 条规则，作为集中常量，可按 Worker 实测调整 |
| 策略组 | 唯一且有效的组名，首版 type=select，至少一个组接收动态节点，组引用无循环 |
| 动态节点 | 占位符仅在组成员数组使用，结构化展开，成员去重且保持顺序 |
| 命名 | 节点名与其他节点、保留目标、组名冲突时统一分配稳定后缀，使用节点稳定 ID 排序解决同名竞争 |
| 规则 | 使用明确的类型与字段数校验；检查域名、网段、端口等参数；末尾唯一 MATCH；规则目标存在 |
| 复杂表达式 | 首版为现有简单规则类型补齐解析，含逗号的正则和逻辑嵌套无法可靠解析时返回具体不支持诊断 |
| RULE-SET | provider 必须存在，no-resolve 与类型兼容；mrs 与 behavior 的合法组合按支持的内核版本校验 |
| rule-providers | type=http、HTTPS URL、明确的 behavior/format/interval；由服务端生成稳定的相对 path，避免路径冲突和目录穿越 |
| 运行一致性 | 同一已发布模板在相同授权节点输入下生成相同字节，节点兼容过滤后再展开组 |

结构校验无法证明远程规则集可在用户网络获取，也无法替代内核对 GEOSITE/GEOIP 资源等依赖的加载。发布面板说明存在此类依赖，使用真实 Mihomo 内核的配置检查与客户端联调验证支持矩阵。

## 5. D1 模型与并发

保留四个已有表名。实施前读取仓库实际 migrations 和现有表定义，确定下一条迁移编号，避免重建已有表。

| 表 | 已有字段或角色 | 建议增补 |
|---|---|---|
| subscription_templates | id、name、draft、published_id、archived、source_url、updated_at | revision、draft_hash、source_fetched_at、source_etag、source_last_modified、created_at |
| subscription_template_versions | id、template_id、yaml、created_at | sequence、normalized_json、content_hash、validator_version、created_by |
| subscription_template_default | id=1、template_id | revision、updated_at |
| subscription_template_bindings | subscription_id、mode、template_id | revision、updated_at |

草稿修订递增，更新请求携带 expectedRevision。版本号与模板组合唯一，发布版本内容不可修改。发布和回退只切换当前指针；回退操作记录审计事件，草稿保留以便继续编辑。引用数按全局继承影响和直接绑定分别计算，不把历史版本计为正在使用。

发布事务重新校验指定草稿修订，创建不可变版本并通过条件更新切换指针。并发失败时整个事务不产生生效版本或孤立写入。用 D1 支持的 batch 原子事务与条件语句实现，不能依赖一次事务外读取后直接写回。归档、设置默认与绑定在数据库侧检查当前模板可用性，归档后新的默认或绑定提交返回 409。读侧通过一次 JOIN 查询确定绑定、默认、模板和版本，减少跨语句观察到不同状态。

新建或更新订阅携带附加配置绑定。D1 delivery 模式下与订阅写入使用同一事务；现有 KV delivery 模式涉及跨存储一致性，管理端明确提示先完成 delivery D1 迁移后启用此项，已有基础订阅仍按原路径工作。禁止先成功提示订阅保存、随后悄悄丢失绑定。

删除订阅时清理绑定，软删除用户时继续按现有授权规则阻断订阅。复制配置生成独立草稿，默认不复制发布版本及订阅引用。已引用模板归档返回引用摘要，管理员调整引用后重试。

## 6. 管理 API

保留 `/api/admin/system/subscription-templates` 基址及现有方法。字段命名在新响应 DTO 中统一为 camelCase，前端不再直接依赖数据库行。已有管理接口调用同步迁移；公开订阅 URL 继续兼容。

| 方法与相对路径 | 请求重点 | 响应与行为 |
|---|---|---|
| GET / | q、page、pageSize、archived | 元数据、发布版本、状态、引用摘要、total，列表省略完整草稿 |
| GET /:id | — | 草稿、revision、来源和发布摘要 |
| POST / | name、yaml、可选来源信息 | 新草稿及 revision |
| PUT /:id | name、yaml、expectedRevision | 保存草稿；冲突返回 409 |
| POST /validate | yaml | normalized、ignored、diagnostics、contentHash，校验失败 422 |
| POST /preview | yaml、可选 subscriptionId | 策略结构、规则集、节点数、原因、诊断、依赖版本 |
| POST /:id/import | url、expectedRevision | 仅返回获取并规范化的候选内容和来源元信息，由保存草稿确认写入 |
| POST /:id/publish | expectedRevision、draftHash、ignoredAcknowledged | 发布版本和影响摘要；服务端重新校验草稿 |
| GET /:id/versions | page、pageSize | 版本摘要，可读指定版本结构用于对比 |
| POST /:id/rollback | versionId、expectedRevision | 原子切换，检查版本属于同一模板 |
| POST /:id/archive | expectedRevision | 归档或 409 引用摘要 |
| PUT /default | templateId 或 null、expectedRevision | 修改默认及影响条数 |
| GET /bindings/:id | — | 绑定、revision、effectiveTemplate 摘要 |
| PUT /bindings/:id | mode、templateId、expectedRevision | 保留独立接口供明确即时保存场景，编辑抽屉统一由订阅保存接口提交 |

路由中静态路径和参数路径保持无歧义。复用 readJson、ApiError、管理员鉴权、来源检查和审计。新增错误码建议包括 TEMPLATE_CONFLICT、TEMPLATE_INVALID、TEMPLATE_REFERENCED、TEMPLATE_UNPUBLISHED、TEMPLATE_OUTPUT_INVALID、TEMPLATE_STORAGE_NOT_READY。错误响应沿用项目现有信封并附 diagnostics，避免返回堆栈和原始节点凭据。

诊断结构建议为 `{ code, severity, path, line?, column?, message }`。预览返回 `effectiveVersionId`、`outputNodes`、`zeroNodeReason`、`groups`、`rules`、`ruleProviders`、`ignored`。公开响应对内部模板损坏返回可诊断的服务错误，管理端可直接回退或切基础配置，避免静默改为另一套分流。

## 7. 现有订阅链路接入

1. `public-subscriptions.ts` 继续校验域名、令牌、所属账号、订阅启停及时间窗口，确定客户端。
2. `compiler.ts` 一次确定 catalog、当前权益、订阅分组交集和限速参数，随后兼容过滤节点。
3. Mihomo 且存在可输出节点时，在同一读取快照中解析绑定和已发布模板。
4. `renderers/index.ts` 生成节点名和 proxies，展开组，保留规则顺序，输出 YAML，返回节点兼容诊断。
5. 对最终响应字节计算 ETag，设置类型、文件名和 profile-title；仅在内容相同且授权仍有效时返回 304。

编译预缓存与公开实时生成走同一套渲染入口。为复用已有调用，可增加明确的模板解析上下文参数，业务层负责读取，渲染器保持纯函数。预览传入草稿覆盖模板解析，仍用同一权限与兼容流程。

当前 compileSubscription 的批量产物未传模板，而公开实时路径会应用模板，必须统一该差异，或明确将旧缓存诊断标为基础节点诊断，不能当作最终策略配置诊断。建议统一编译入口后给产物补充 rendererVersion、templateVersionId 等可选依赖字段，旧产物在读侧识别后重建。

当前 KV 产物缺失或 catalog/subscription revision 不匹配时，合法订阅应实时重建，而后可用 waitUntil 更新缓存。节点与模板授权始终实时执行，缓存不能使过期权益继续下发。重建失败返回服务错误并记录原因，避免把内部缓存故障映射为订阅不存在。重建与旧 schemaVersion 兼容集中在一处处理。

模板发布、默认切换、绑定变化、回退均在下一次拉取生效，ETag 来自实际输出。Last-Modified 采用参与输出的有效变更时间最大值；若现有数据无法稳定计算，应省略该头并使用 ETag。相同输出的刷新不能因请求时间而不断产生不同内容。

零节点、未分配用户、订阅停用或无有效权益时进入现有不可用路径，避免输出一份只有 DIRECT、看似成功的模板订阅。检查无权益早返回路径是否也验证订阅时间与启停。其他客户端继续走原有生成器，UI 明确附加配置适用于 Mihomo。分享取得订阅地址后必须经过相同公开鉴权链路。

## 8. 远程获取与数据保护

复用 `worker/catalog/remote.ts` 的 fetchRemoteText 并核对其 HTTPS、超时、体积和每次重定向校验能力，缺项在共享能力中补齐。导入响应体按字节限制，读取中止后保留本地编辑内容。以 10 秒总超时、最多 3 次重定向作为初始参数，结合运行时实测调整。

支持 ETag 或 Last-Modified 条件导入，304 时提示来源未更新。导入不自动发布，失败后管理员可以重试。公开下发不依赖远端模板站点即时可用。模板内容和来源 URL 不进入普通用户接口；管理预览省略 proxies 和凭据，仅返回策略及规则集的必要结构。审计记录对象、操作、版本和影响范围，URL 查询参数及 YAML 全文不进入审计摘要。

## 9. 文件改动建议

| 文件或目录 | 工作内容 |
|---|---|
| worker/templates/validation.ts | 分离结构校验、规则校验、规范化、诊断和占位符展开 |
| worker/templates/repository.ts | 原子版本切换、JOIN 解析、引用查询、条件更新 |
| worker/templates/routes.ts | 扩展现有端点、分页、DTO 和 revision 冲突处理 |
| worker/delivery/compiler.ts | 实际节点与模板上下文统一，修复缓存与预览分叉 |
| worker/public-subscriptions.ts | 缓存失效重建、授权优先、ETag 与错误映射 |
| worker/delivery/routes.ts 及 D1 持久化模块 | 订阅创建与更新同时保存绑定，删除时清理 |
| worker/renderers/index.ts | 确定性节点名、规范化模板注入 |
| src/features/system/TemplatesSection.tsx | 保留入口，拆出列表、编辑和预览三个视图 |
| src/features/system/TemplateBinding.tsx | 改为受控表单字段并支持生效摘要 |
| src/app/api.ts | 增加显式 DTO 与绑定类型 |
| migrations/ | 按实际已有表结构追加迁移和索引，填充历史版本元数据 |

组件拆分以功能边界为准，复用当前 UI 组件和主题变量。编辑视图在已有系统页面内导航即可，避免增添侧栏一级入口。

## 10. 交付顺序与验收

| 阶段 | 交付 | 完成条件 |
|---|---|---|
| P1 | 数据与接口一致性 | 迁移、乐观锁、发布回退、归档引用及订阅绑定事务通过 |
| P2 | 下发与校验 | 授权节点注入、策略校验、缓存失效重建、最终 ETag 一致 |
| P3 | 管理 UI | 列表、编辑、远程导入、结构化预览、未保存提示可用 |
| P4 | 客户端验收 | 原链接更新、规则模式选节点、规则集获取和版本回退完成 |

| 验收项 | 预期结果 |
|---|---|
| 原有实例升级 | 保留默认配置、绑定和已发布版本，旧订阅仍可刷新 |
| 不同权益账号 | 同模板只注入各自有权获取的节点，过滤后节点数与预览一致 |
| 名称冲突 | 重名、特殊字符、与组同名和保留名称都生成有效且稳定的 YAML |
| 规则错误 | 重复组、循环、无效引用、错误网段、未知规则集、无末尾 MATCH 被定位 |
| 并发编辑与发布 | 旧 revision 保存或发布得到 409，线上不出现部分提交 |
| 归档竞争 | 与默认切换、绑定竞争时仍无有效引用指向已归档模板 |
| 缓存缺失和旧产物 | 有效订阅可重建，过期用户始终不能从旧缓存取得节点 |
| 远程导入 | 成功进入待保存内容，超时、超量、跳转失败均不覆盖既有草稿或发布版本 |
| 版本更新 | 同一 URL 刷新取得新规则；回退取得历史规则；相同内容可返回 304 |
| UI 保存语义 | 取消订阅抽屉保留原绑定；模板未保存时不能误发布旧草稿 |
| Mihomo 实测 | 配置检查通过，实际规则模式存在手动组，切换节点有效，指定私网直连 |
| 兼容性 | 通用节点、Sing-box、其他格式和分享链路完成既有回归 |

验证优先运行仓库已有 check、build、Worker 测试与相关端到端用例，新增测试集中覆盖上述并发、权限、缓存和发布回归。真实内核检查应固定版本并记录客户端名称、内核版本和规则集网络条件。无法执行的检查在交付报告单独列明。

## 11. 参考与设计决定

本方案选定内置 Mihomo 渲染、管理员手动发布远程快照、首版 select 组、订阅编辑统一保存、故障时显式报错等设计。文中数量和超时为建议初值，需按运行时测试确定。当前界面结论来自源码，数据库迁移文件和部署环境尚待实施时核对。本文提供开发方案，项目代码未修改。

- [代码核对基线](https://github.com/OnWarp/SubPanel/commit/a818d3a74b3bf6fcd43ddf02583db70b4b749814)
- [现有模板接口](https://github.com/OnWarp/SubPanel/blob/a818d3a74b3bf6fcd43ddf02583db70b4b749814/worker/templates/routes.ts)
- [现有模板校验](https://github.com/OnWarp/SubPanel/blob/a818d3a74b3bf6fcd43ddf02583db70b4b749814/worker/templates/validation.ts)
- [现有模板 UI](https://github.com/OnWarp/SubPanel/blob/a818d3a74b3bf6fcd43ddf02583db70b4b749814/src/features/system/TemplatesSection.tsx)
- [现有订阅编译](https://github.com/OnWarp/SubPanel/blob/a818d3a74b3bf6fcd43ddf02583db70b4b749814/worker/delivery/compiler.ts)
- [MiSub 设计参考](https://github.com/imzyb/MiSub/blob/main/README-zh.md)
- [前版附加配置方案](https://chatgpt.com/library?file_id=libfile_cf1187c40c508191871acd599ae9cc3a&account_id=personal)
