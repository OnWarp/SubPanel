# SubPanel Core G · 高级运营交付

分支 `task/core-g`，基底 `05b50d8db0b8da44d39e4426c97a49a50a615bb8`，提交身份 `Muse <muse@outtw.com>`。交付文件为 `/data/tmp/core-g.bundle`。构建、测试、数据库迁移和浏览器验证均在本机隔离环境完成。本阶段未推送、部署或访问生产 D1。

## 实现

- **规则库。** 转换配置页可检查系统规则、自建规则和远程规则集。系统规则随版本发布，自建规则显示修订和保存时间，远程规则显示内容版本、最后成功时间与错误。远程抓取只接受白名单 HTTPS 地址，拒绝私网、带凭据的地址、查询参数、片段和所有跳转。单次上限 7 秒、约 262 KB、10,000 条规则。解析限制 YAML 结构及 JSON 嵌套，拒绝别名和逻辑嵌套。使用 ETag 和 Last-Modified，抓取或验证失败时保留上一成功内容。发布检查近七天的成功验证记录，不从发布或订阅路径发起新抓取。
- **引用和版本。** 已发布配置的引用查询展示配置、发布序号、平台、规则标签及下发模式，支持分页和打开配置。Mihomo 远程 provider 和固定 Git 提交的 sing-box JSON 由客户端下载。兼容 YAML/文本可在发布时转换为有总大小和条数上限的 sing-box 内嵌规则。自建和系统规则可由 Mihomo 基础编辑器插入，也可在 sing-box 中指定出站。内嵌内容随发布冻结，库中的版本更新后显示需重新发布的配置。旧发布中缺少内嵌来源版本的条目标明历史版本未记录。
- **批量工具。** 选中后显示复制、启用、停用、换计划与换转换配置操作。支持跨列表页选中。确认前显示选中数、预计受影响数、缺失项和可能失效的平台。复制保留原订阅和其访问状态，为副本生成独立令牌。换计划保留现有有效期和选组，运行时按新计划授权组取交集。换转换配置更新共享绑定，sing-box 独立绑定优先。预览绑定订阅和目标的修订，确认可幂等重试。任务复用 F 的租约、四项分页和状态机，最多 1,000 项，可查看进度、暂停推进、取消剩余项目、重新预览失败或未执行项。每项结果及对应变更在同一事务提交，审计保留操作人、目标、结果和失败代码。取消保留已生效项目。
- **最小统计。** 管理端订阅详情显示最近记录时间、平台、结果、状态码、成功及失败次数、总计和按平台耗时范围。计入已识别订阅的请求，304 算成功。沿用 KV 聚合，首条及之后批量写入，单实例内的暂存容量有上限。统计新增 D1 写入为零。界面说明隔离实例和重启可能导致记录遗漏、UA 无法标识设备，统计不能推断设备数量或代理流量。用户订阅 API 和页面不展示拉取统计。

## API

批量端点基址为 `/api/admin/compile-jobs`。示例预览请求为 `{"ids":["sub_1"],"operation":{"action":"disable"}}`，发送至 `POST /batch/preview`。将响应的 `previewId`、`fingerprint` 与原请求一起发送到 `POST /batch` 创建任务。用 `GET /:id`、`GET /:id/items` 看进度和结果，通过 `POST /:id/run` 推进一页、`POST /:id/cancel` 取消。批量任务的 `POST /:id/retry` 返回重新确认所需的预览。旧同步修改端点提示先预览，公开下载路径及平台别名沿用原入口。

规则库位于 `/api/admin/system/subscription-templates/rule-sources`。查询引用示例为 `GET /rule-sources/usage?type=local&key=Custom`，返回已发布配置的引用和分页游标。远程身份键是 URL、规则类型、格式组成的 JSON 元组。管理员可在规则库界面查询，无需构造 API 请求。

## 变更文件

- `migrations/0025_core_g.sql` 扩展 F 任务元数据和逐项结果，增加逐项审计触发器及发布版本对应的规则来源快照。
- `worker/delivery/{compile-jobs,subscription-batch,routes,fetch-stats}.ts` 和 `worker/public-subscriptions.ts` 接入批量预览、任务推进及管理端拉取统计。
- `worker/templates/{rule-library,routes,validation}.ts` 扩展系统规则、远程结构限制、发布版本快照、引用查询与草稿来源标记。
- `src/features/delivery/{SubscriptionsPage,SubscriptionBatchJobs,SubscriptionDetailRows,MySubscriptionsPage}.tsx`、`src/features/system/{RuleLibrary,BasicTemplateFields}.tsx`、`src/ui/ConfirmDialog.tsx` 和 `src/app/api.ts` 更新批量操作、影响确认、规则来源及统计展示。
- `development/tests/worker/{d1,d1-foundation.test,delivery-api.test,subscription-lifecycle.test}.ts` 更新迁移、远程规则、引用和批量操作回归。

## 验证

| 项目 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误 |
| `npm run build` | 通过。Worker 约 1,139.82 KB，主客户端 JS 约 690.76 KB。Vite 提示部分构建块超过 500 KB |
| `CI=1 npm test` | 65 个文件，552 项通过。1 项默认可选性能测试跳过 |
| 公开订阅与转换 | 既有路径、平台别名、UA 回退、九种规范格式、授权与条件请求回归通过。已验证规则源支持条件抓取，拒绝私网、重定向和深嵌套，抓取失败保留上一版本 |
| 批量操作 | 验证复制产生独立链接、启停后旧链接按原令牌重新授权、计划与配置写入、预览过期拒绝、确认重放、分两页推进、取消后重跑剩余项、逐项失败与审计脱敏 |
| 本地 D1 | 全量迁移至 0025 成功。使用含本地订阅及发布记录的内存副本演练撤销及重加 0025，13 张旧表逐行一致，外键检查通过 |
| 视觉回归 | Playwright 与真实本地 Worker。在 1440 px 和 390 px 检查工具栏显隐、影响预览、复制结果、统计项与口径、规则引用及版本变更提示。截图位于 `/data/tmp/core-g-visual/` |

## 迁移、风险和回滚

1. 集成时按现有 D1 备份及迁移台账流程应用 `0025_core_g.sql`，随后发布 Worker。迁移保留旧业务行和历史版本。0025 执行前需要已有的 0020 和 0024 结构。本阶段只向仓库提交迁移文件。
2. 管理员启动的批量任务由浏览器逐页推进；关闭页面后可从任务列表继续。影响预览按当前修订计算，执行期间的并发修改可触发逐项失败。重试时重新确认剩余项。批量改动已经生效的记录不会随 Worker 降级自动撤销，可根据审计逐项审查及纠正。KV 统计为尽力记录，跨实例写入可能覆盖其他实例的增量。客户端自行下载的规则仍受上游可用性影响，变更可通过固定版本 URL 控制。
3. 回退 Worker 前，取消待执行或运行中的 G 任务，保留审计记录。基底的 YAML 验证器早于 `subpanel.ruleLibrary` 字段。使用该字段的在用配置应先回退到兼容发布版本，或用现有绑定切到兼容配置及基础输出。随后回退 Worker 并保留 0025 结构。若另行批准撤销 schema，先备份新任务与快照，再移除 `subscription_batch_item_audit` 和更新后的 `compile_job_cleanup`，移除 `conversion_rule_version_snapshots` 及 0025 新加列，然后按 0024 恢复原 `compile_job_cleanup` 并核对迁移台账。该逆向演练仅在本地副本完成。
4. `BRIEF_CORE_G.md` 和工作区的 `PLAN.md` 修订未纳入本阶段提交。按指定命令生成的完整 bundle 保留基底历史，包括基底已经跟踪的历史版 `PLAN.md`。

CORE_G_DONE
