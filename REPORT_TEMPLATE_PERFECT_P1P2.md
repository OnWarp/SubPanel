# 附加配置完善 P1＋P2 交付报告

分支为 `task/template-perfect-p1p2`。主线基线为 `a818d3a7`，接续起点为已在远端的 Pi WIP `c27d396c`。保留 WIP 提交历史，在其上按 P1、P2 提交。

## 基线和交付验证

| 命令 | 主线 `a818d3a7` | Pi WIP `c27d396c` | P1＋P2 |
| --- | --- | --- | --- |
| `npm run check` | 通过 | TypeScript 失败 | 通过 |
| `npm test` | 57 个文件，481 通过 | 57 个文件，430 通过、51 失败 | 58 个文件，506 通过 |
| `npx vitest run --config development/vitest-pages-node.config.ts` | 14 个文件，189 通过 | 14 个文件，189 通过 | 14 个文件，189 通过 |
| `npm run build` | 通过 | TypeScript 失败 | 通过 |

- P1 单独通过 `npm run check` 和 Worker 测试，58 个文件、489 项通过。P2 在完整交付中增加 17 项，Worker 净增 25 项。
- 补充 Node 套件通过。`development/vitest-subscriptions-node.config.ts` 为 14 项，`development/vitest.templates.config.ts` 为 93 项。两者与主表部分覆盖重叠。
- Wrangler 本地从空库按编号成功应用了全部迁移。Worker D1 测试也模拟从有模板、默认、绑定和两个同时间戳版本的 0015 数据库升级。
- 构建沿用主线已有的前端 bundle 体积警告。额外运行的 Playwright 浏览器套件在主线和交付分支遇到相同的既有问题。首项因 `getByLabel('密码')` 同时匹配输入框和显示密码按钮而失败，运行器在首个文件中停止。简报指定的 189 项页面测试全绿。

## 对 Pi WIP 的取舍

- 保留追加迁移的编号和字段、模板接口框架、校验拆分方向、发布版本依赖字段和 KV 重建方向。
- 修正有历史数据时 SQLite 无法应用的列默认值，回填有确定来源的时间与版本序号，对模板版本号建立唯一索引。
- 重写 CAS 的 SQL 条件。WIP 在发布指针更新结果为零时仍会提交版本插入，归档和绑定的可用性检查也存在事务外竞态。交付版本在数据库写入时复核条件，D1 合并保存遇到绑定冲突会回滚整批。
- 移除 WIP 写入订阅快照的重复绑定字段。订阅和模板绑定由现存的两张表分别负责，合并保存由同一 D1 batch 提供一致性。
- 移除 WIP 的旧缓存直接下发路径和伪哈希。现在每次实时解析权限和模板，SHA-256 摘要用于草稿、规范化模板内容和最终响应字节。

## P1 数据与接口一致性

| 项目 | 实现与验证 |
| --- | --- |
| 模板迁移 | `0016_template_enhancements.sql` 只追加列和索引，保留既有默认、绑定、归档状态和发布指针。 |
| 草稿、默认、绑定的乐观锁 | 请求体使用 `expectedRevision`，过期操作返回 409 `TEMPLATE_CONFLICT`。无绑定行仍继承默认，虚拟初始修订为 1。 |
| 原子发布与回退 | 发布比对草稿哈希并重新校验。条件插入和指针更新同批执行，重放旧修订无孤立版本。回退校验版本归属，只切换发布指针，保留草稿，并记录版本和引用摘要。 |
| 归档与引用 | 数据库写入时检查默认及直接引用，冲突时返回 409。引用摘要区分默认引用、直接绑定和未单独覆盖默认的订阅。归档与两种引用创建的竞争都有测试。 |
| 读取与管理接口 | 单次 JOIN 解析指定、基础或继承模式。模板列表分页、搜索、归档筛选并省略草稿，详情和版本历史使用 camelCase，支持指定版本结构和独立草稿复制。发布、校验、预览、导入、归档、默认和绑定接口均按新 DTO 返回。 |
| 订阅一致保存 | D1 模式把订阅、分组和绑定写在同一事务，订阅读取也用 D1 batch 取得一致快照。创建或更新失败时保留原状态。普通删除及账号永久清理路径清理绑定。KV 模式的合并写入返回 409 `TEMPLATE_STORAGE_NOT_READY`，原独立绑定接口仍可使用。 |
| 已有页面调用 | 同步现有管理调用的 DTO、分页、详情读取、修订号及候选导入。保留现有页面布局和独立即时绑定入口，P3 的编辑抽屉和页面拆分留到后续。 |

### 迁移字段

| 表 | 增补 |
| --- | --- |
| `subscription_templates` | `revision`、`draft_hash`、`source_fetched_at`、`source_etag`、`source_last_modified`、`created_at` |
| `subscription_template_versions` | `sequence`、`normalized_json`、`content_hash`、`validator_version`、`created_by` |
| `subscription_template_default` | `revision`、`updated_at` |
| `subscription_template_bindings` | `revision`、`updated_at` |

旧模板 `created_at` 用原 `updated_at` 回填，旧版本按创建时间和 ID 分配序号，模板、默认和绑定的修订字段以 1 初始化，历史默认和绑定的未知时间用 Unix 纪元占位。新增模板状态时间、来源信息、规范化结果和发布者由实际操作写入。索引覆盖模板内唯一序号、归档状态与更新时间、直接绑定查找。

并行分支 `task/source-keep-on-failure` 也使用 0016（`0016_source_keep_on_failure.sql`）。本线保留 `0016_template_enhancements.sql` 原编号，编号冲突留待集成处理。

## P2 下发与校验

| 项目 | 实现与验证 |
| --- | --- |
| YAML 和规则 | 单对象、唯一键、未知标签及别名限制，集中限制组、规则集和规则数量。校验策略组引用、循环、占位符、简单规则参数、唯一末尾 MATCH、规则集引用及兼容组合。管理 API 返回结构化诊断和可获得的路径、行、列。 |
| 规则集 | 仅接受 HTTPS 的 HTTP 类型 provider。缺省规范化为 `yaml` 和 86400 秒，服务端生成无穿越路径、无名称冲突的相对路径。Worker 不发起规则集请求。 |
| 节点与策略输出 | 批量编译、公开实时渲染和预览共用权限与兼容过滤流程。Mihomo 在过滤后按节点 ID 分配唯一名称，同时保留输入节点顺序并对展开成员去重。 |
| 缓存、ETag、分享 | KV 缓存缺失、损坏、旧 schema 或依赖不匹配时，合法订阅实时出产物并以 `waitUntil` 回填。ETag 来自最终字节，继续检查实时权益才允许 304。分享文件导出同样实时使用现行授权和发布版本。无法可靠推导最终变更时间时省略 Last-Modified。 |
| 零节点与故障 | 预览区分订阅停用、未分配、未生效、过期、所有者不可用、无有效权益、分组无交集、无启用节点和不兼容。Mihomo 零节点走不可用响应。已发布配置损坏显式返回 `TEMPLATE_OUTPUT_INVALID`。 |
| 手动导入 | 管理员操作触发一次有界 HTTPS 抓取。每次跳转重验地址，最多 3 次跳转，共用 10 秒截止时间，响应按 5 MiB 字节上限读取。支持 ETag、Last-Modified 及 304 提示。只返回候选、来源信息和诊断，失败不改草稿。没有新增远程模板后台任务。 |

## 回归用例和结果

- `templates-api.test.ts` 的 7 项通过。覆盖分页元数据与独立复制、并发草稿和发布、发布指针故障原子回滚、归档与默认／绑定竞争、D1 创建和更新的原子写入及删除清理、KV 未迁移时拒绝合并写入。
- `d1-foundation.test.ts` 新增 1 项通过，使用真实 D1 测试数据库验证已有默认、绑定、指针及同时间戳版本的迁移。
- `delivery-api.test.ts` 新增 4 项通过。覆盖缓存缺失回填、批量和实时产物字节一致、分享跟随发布、ETag 变化及回退、过期权益拒绝匹配的旧 ETag、预览零节点、坏发布快照及远程导入条件请求和失败保留。原有旧 schema、损坏缓存、订阅／Catalog 旧修订用例按新合约验证重建；原有授权回归继续验证禁用和删除。
- `templates.test.ts` 新增 13 项通过，覆盖错误参数定位、多文档、重复键、未知标签、循环别名、规则集组合、路径生成及兼容过滤后的稳定命名。
- `catalog-remote.test.ts` 的超时用例验证跨重定向和响应体读取共用一个截止时间。权益与软删除用例验证实际有效权益与缓存隔离。

## Mihomo 实测

- 使用官方 Linux amd64 Mihomo Meta `v1.19.19`（Go `1.25.6`，`with_gvisor`）。以规格 §4 的私网模板和两个测试节点，经本分支验证器和渲染器生成完整 YAML，`mihomo -t` 通过。两节点分别与策略组名、保留目标名冲突，内核载入了分配后的名称。[Mihomo v1.19.19](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.19)
- 以规则模式启动本地内核，控制接口确认 `Proxy` 为手动 Selector，切换选择后可以读回成员。通过本地代理请求 172.16.0.0/12 内的测试 HTTP 服务返回 200，内核日志确认 `IPCIDR(172.16.0.0/12)` 匹配后走 `DIRECT`。实测配置没有外部规则集依赖。规则和规则集组合的静态校验参照官方说明。[路由规则](https://wiki.metacubex.one/en/config/rules/) [规则集配置](https://wiki.metacubex.one/en/config/rule-providers/)

### 未验证

- 真实用户客户端拉取外部规则集、GEOSITE／GEOIP 数据加载、经线上代理节点转发流量和 P4 的客户端矩阵。
- 线上 Cloudflare 网络及跨地区 KV 传播。本地用 Worker 和 D1 测试运行时验证授权、竞争和迁移。

## 规格边界与偏差

- 历史版本缺少原发布管理员、校验器及抓取来源元信息，数据库保留空值。旧草稿哈希及旧版本的规范化结构和内容哈希由详情或发布操作按需计算。旧版本列表中的未知哈希仍为空。SQLite 迁移阶段无 YAML 校验器或 SHA-256 函数。
- 导入和仅校验仍接受最多 5 MiB。D1 单行上限为 2,000,000 字节，保存草稿和发布对持久化内容留出元数据空间，超限返回结构化 413。发布同时计算原 YAML 和规范化 JSON 的字节数。[Cloudflare D1 上限](https://developers.cloudflare.com/d1/platform/limits/)
- KV 模式的订阅删除和旧独立绑定清理跨存储执行，D1 模式具有单事务保证。KV 模式的订阅合并绑定保存由接口明确阻止。
- Mihomo 零授权节点由原先可能返回空成功配置改为 422。其他格式保留既有无权益空响应行为，禁用、未生效、过期和账号状态检查仍先于下发。

交付目标为 GitHub 远端 `origin/task/template-perfect-p1p2`，两个阶段提交均在同一分支。

## 分支交付

执行 `git push origin task/template-perfect-p1p2` 后，GitHub HTTPS 要求认证，当前实例没有可用凭据。Git 返回 `could not read Username for 'https://github.com': terminal prompts disabled`。远端分支仍位于 Pi 的 WIP。按简报生成并校验 `/tmp/template-perfect-p1p2.bundle`，该 bundle 包含分支及本报告。
