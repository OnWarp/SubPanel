# SubPanel CORE-08 · 增量编译交付报告

## 基底与交付

- 分支 `task/core-f` 起点与本地 `origin/main` 均为 `c78fbc4d32189fc86025edef75a83becbbd6d582`。提交身份为 `Muse <muse@outtw.com>`。
- 交付 bundle 位于 `/data/tmp/core-f.bundle`。迁移和测试操作均在隔离本地环境完成。工作区中的 `PLAN.md` 修改与 `BRIEF_CORE_F.md` 是输入文件，留在原工作区。

## 实现与一致性

- 来源同步、节点和分组保存、订阅保存及计划编辑移除了全量预编译。目录写入比较新旧有效节点、组成员和排序，审计记录变化组、直选节点及关联订阅候选数。请求按计划与所选组的交集解析实际节点，兼容动态组和直接节点分配。目录刷新时间等元数据变化可复用现有产物。
- 失效按订阅与规范平台判定。KV 键包括令牌哈希命名空间、`subscriptionRevision`、`catalogRelevantRevision`、`profileVersion`、`rendererVersion` 和 `platform`。目录相关版本来自该请求的有序授权渲染输入。结构化输出的签名排除原始分享 URI。发布通过当前生效的 legacy Mihomo 和 sing-box 平台版本推进各自产物键。计划编辑只推进绑定计划的订阅版本。
- 公共下载按哈希索引从 D1 查询订阅及其选择项，从 D1 目录、计划和绑定确定权限与版本。读取 KV 时校验产物元数据与内容摘要，只有缓存缺失或无效才渲染请求的平台。返回正文或 `304` 前再次核对 D1 订阅版本、令牌、所有者和计划状态，并检查到期时间。启用的手动无计划订阅继续沿用其组或直选节点。已撤销、停用计划的订阅，包括绑定到此类计划的池订阅，拒绝下载。
- 新产物有效期为七天。生成失败返回受控错误，历史产物留待过期。回退发布指针后，仅在订阅当前授权有效且所有版本维度匹配时复用历史成功产物。既有公开路径、别名和 UA 路由沿用原解析规则。
- 任务固定选择时的订阅 ID，每次处理最多四条、一个规范平台。临时所有权租约防止并发推进，进程中断后租约两分钟到期，随后可从上次已提交的进度继续。逐项失败记录计数、最近失败订阅 ID 和错误码。取消后停止推进，已在渲染的一条可能完成 KV 写入，仍受公开路径版本和权限校验。重跑创建新任务并重用有效产物。任务终止时清理其新建的临时成员行，保留进度和审计。
- 分页由管理员调用推进。现有 Cron 只为此阶段增加过期公开限流计数清理。限流使用 D1 原子固定窗口，每分钟每来源地址 240 次、每命中订阅 120 次。超限返回 `429` 与 `Retry-After`。首次越阈写脱敏异常事件，应用日志和审计仅保留必要的事件元数据。

## 管理 API 与指标

任务路由基址为 `/api/admin/compile-jobs`，沿用管理员认证和 Origin 校验。

| 方法及相对路径 | 行为 |
| --- | --- |
| `POST /` | 创建任务。示例请求为 `{"platform":"mihomo","groupId":"grp_1"}`。可选 `planId`，和组条件同时提供时取交集。仅传平台时选择所有订阅 |
| `GET /`、`GET /:id` | 最近 50 份任务或单任务。返回状态、总数、已处理、编译、缓存命中、跳过、失败及执行耗时 |
| `POST /:id/run` | 推进一页。若状态为 `running` 且 `busy` 为 0，可继续调用 |
| `POST /:id/cancel`、`POST /:id/retry` | 取消待执行或运行中任务，或按终止任务的范围新建重跑 |
| `GET /artifacts/:subscriptionId/:platform` | 查询现行产物，返回 `current`、`needsCompilation` 或 `blocked`。版本失效、冷缓存和驱逐后缺失均显示为 `needsCompilation` |

运维可按平台汇总 `subscription_delivery` 的 `hit / (hit + miss)`，按状态和 `durationMs` 查看失败与时延；监看 `subscription_fetch_rate_limited` 最先跨阈值的窗口事件。目录与计划失效审计分别为 `compile.invalidate.catalog` 和 `compile.invalidate.plan`；配置使用发布、回滚、默认和绑定审计，发布记录受影响的平台。目录候选数用于估计影响面，最终是否失效由各订阅平台的实际版本键决定。任务响应和 `compile_job.*` 审计提供编译数、命中、失败和累计执行耗时。

## 大批量实测

在本机隔离 workerd、D1、KV 中使用两组来源，一次更新命中约 1% 的有效订阅，验证命中组的九种规范平台。全量对照执行阶段 E 的工作形态，每条有效订阅渲染九种格式，写入版本键与兼容键并列举前缀。对照从干净的独立 KV 前缀起步。切换前后共用当前 renderer 和同一组数据，计时包括本地 D1、KV 和对应 API 调用。分页最长列仅统计 `/run` 请求。

| 有效订阅数 | 受影响订阅数 | 更新与失效 | 定向预热九格式 | 最长单页 | 全量对照 | 总耗时加速 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 1 | 27 ms | 238 ms | 25 ms | 1,633 ms | 6.2 倍 |
| 500 | 5 | 17 ms | 500 ms | 61 ms | 9,335 ms | 18.1 倍 |
| 1,000 | 10 | 42 ms | 949 ms | 93 ms | 20,873 ms | 21.1 倍 |

在相同 1,000 份有效订阅上再执行整批 generic 任务。任务含一条停用夹具，共 251 页，10,886 ms 完成，最慢单页 181 ms。共编译 990 项，命中 10 项，跳过 1 项，失败 0 项。生产跨区 D1 与 KV 时延可能更高。目录仍以现有快照处理，目录规模主要影响组解析和授权读取成本。

复跑命令如下。

```sh
CI=1 VITE_CORE_F_BENCH=1 npx vitest run --silent=false --reporter=verbose \
  --config development/vitest.config.ts --maxWorkers=1 \
  development/tests/worker/core-f.test.ts -t 'measures scoped'
```

## 验证结果

| 项目 | 结果 |
| --- | --- |
| 基线 `CI=1 npm test` | 63 个文件，544 项通过 |
| `npm run check` | 0 错误 |
| `npm run build` | 通过。Worker 约 1,086.38 KB，主客户端 JavaScript 约 665.16 KB。Vite 提示部分构建块超过 500 KB |
| `CI=1 npm test` | 64 个文件，547 项通过，78.30 秒。1 项可选性能测试在默认运行跳过，另行实测通过 |
| 公开和转换回归 | 旧链接和 18 个平台路径及条件请求通过。覆盖 Mihomo、sing-box 完整下发、旧绑定、回滚、损坏 KV、停用、到期、撤销、令牌轮换和所有权转移 |
| 定向回归 | 编辑东侧来源后仅其授权订阅失效；Mihomo 发布后同订阅的 generic 仍命中，另一订阅仍命中；计划停用后旧 ETag 请求返回 404；任务失败重跑、取消和限流通过 |
| 浏览器和原生校验 | 真实本地 Worker 运行阶段 D 回归脚本，1440px 和 390px 均通过，覆盖转换列表、发布、诊断、版本预览、回滚与用户格式。16 张截图保存于 `/data/tmp/core-f-visual/development/screenshots/core-d/`。Mihomo Meta v1.19.30 对本次生成的样例执行 `-t` 通过。sing-box 由 Worker 下发和兼容回归覆盖 |
| 迁移 | Wrangler 隔离本地实例应用 22 个迁移通过。在含实际本地测试订阅、计划和版本数据的 SQLite 副本上演练撤销及重加 0023，12 张既有表逐行一致，外键检查通过 |

## 文件清单

- `migrations/0023_compile_jobs.sql` 增加任务、临时成员表、相关索引及任务审计和终止清理触发器。
- `worker/delivery/dependencies.ts`、`artifacts.ts`、`compile-jobs.ts`、`public-rate-limit.ts` 实现依赖签名、缓存校验、任务和限流。
- `worker/catalog/{d1-repository,import-service,repository,routes}.ts` 接入目录依赖影响审计，移除来源和节点变更的全量编译。
- `worker/delivery/{compiler,d1-repository,expiry,lifecycle,plan-routes,plans,repository,routes,schema}.ts` 实现按需渲染协作、D1 订阅点查、生命周期和计划授权、版本键及现行诊断。
- `worker/{app,public-subscriptions}.ts` 注册管理入口并接入公开下载流程。`worker/templates/routes.ts` 记录发布影响的平台。`worker/operations/cron.ts` 清理已过期限流窗口。
- `development/tests/worker/` 更新迁移和既有回归夹具，增加 CORE-08 回归及可复现性能测试。

## 迁移、成本与回滚

1. 集成时先确认生产 D1 的目录、订阅和账户模块已迁移就绪，并核对迁移台账及备份。按现有生产运维流程单独应用 `0023_compile_jobs.sql`，随后发布 Worker。0023 只新增任务相关对象和索引，已有数据和模板结构可直接继续使用。
2. 上线后观察 `subscription_delivery`、限流以及任务失败指标。KV 热身按现行请求逐步发生，首次请求可能增加渲染时延。每个公开请求消耗一次来源地址计数写入，已定位的有效窗口订阅再消耗一次订阅计数写入；批量预热每个缓存缺失的产物写入一次 KV。任务可通过范围控制预热规模。
3. 当前采用显式分页调用，无需开通 Queues 或新增付费资源。若之后考虑自动批处理，既有 Cron 可提供低频推进，积压时交付更慢；Queues 提供独立背压和重试，但会增加消息操作与 Worker 消费成本。资源启用由 Roye 决定。
4. 回滚可先终止正在推进的任务，再交付上一版 Worker，保留 0023 的附加结构。回到基底版本会恢复其对停用和撤销计划的旧授权行为，集成方需评估回滚窗口内的有效订阅状态并按现有权限流程处理。若另有撤销 schema 的批准，备份任务历史后先删除 `compile_job_cleanup`、`compile_job_progress`、`compile_job_created`，再删除 `compile_job_items`、`compile_jobs`、`public_fetch_rate_expiry`、`subscription_groups_compile_group`，并按实际生产台账对账。保留已有审计、订阅、计划、配置和 KV 数据。

CORE_F_DONE
