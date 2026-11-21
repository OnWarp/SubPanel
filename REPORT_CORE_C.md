# CORE-C 实施报告

## 基线核查

基线为 a4fabff3，分支为 task/core-c-catalog，Git 身份为 Muse <muse@outtw.com>，最新迁移为 0018。

| 范围 | 已实现 | 缺失 |
| --- | --- | --- |
| 来源 | 手动、文件、远程类型，格式检测，手动刷新，定时选择，默认失败保留，加密保存 URL、Header 和原始内容 | 同步差异确认、格式覆盖、运行历史、失败次数、退避和取消 |
| 节点 | 基于协议和连接参数的指纹、启停、保留、排序、原始变体，管理接口隐藏凭据 | 指纹目前跨来源合并，缺少显示名覆盖、最后见到时间和失效时间 |
| 分组 | 来源及指定节点合并，排除优先，显式顺序和稳定追加，编译时按节点 ID 去重 | 动态匹配、输出预览、引用保护和按组定位订阅 |

## 实现

- 远程来源的新建接口保存设置，管理员刷新先返回差异和预览 ID。确认使用同一份加密内容，10 分钟后失效。目录版本变化、确认重放和来源不匹配均拒绝。手动文本和文件也显示差异，表单确认后写入
- 来源有首次失败时间、连续失败次数及最近 20 条运行记录。历史包含结果、耗时、HTTP 状态、检测格式、ETag 和变更计数。最近一次成功导入的节点在失败后继续保留。原 `keepOnFailure` 字段用于兼容旧数据和 API，关闭它也会保留节点
- D1 租约将同时同步限制为两个来源，每个来源最多一个操作。抓取期间可取消，已有预览可取消。既有定时入口按配置间隔选择来源，失败增加指数退避和按来源错开的抖动，额外等待上限 24 小时，连续失败 8 次后暂停自动尝试。手动成功或变更连接设置可恢复自动尝试
- 节点指纹沿用协议、地址、端口、凭据和传输字段的规范化算法。存储键增加来源范围，跨来源同一指纹提示疑似重复。旧共享节点在所属来源成功同步并再次见到该节点时逐步拆分，复制旧 ID 的显式分组引用和排序，自定义名、启停及保留设置随节点延续。远程消失节点先标记，24 小时后在下次成功同步时清理，重新出现则恢复原 ID 和排序
- 节点页沿用表格、筛选、批量栏和抽屉。可添加、编辑和复制节点，维护标签及地区，读取原始变体，并通过现有渲染器检查所选客户端的输出及诊断
- 分组将启用来源的节点、手动包含和动态规则命中合并，排除优先，最后过滤停用节点。动态条件按 AND 组合，协议列表内部按 OR 匹配。正则支持锚点、字符类和顶层分支，限制嵌套和量词以避免高代价匹配。排序沿用显式顺序、来源顺序、节点顺序和 ID。管理员可查看命中、停用、不兼容及可输出顺序，选择订阅后按实际授权和渲染路径预览
- 更新分组前，以订阅所选组与计划授权组的交集计算影响数。保存后仅清理授权节点或顺序变化的订阅产物。删除组时检查启用计划及未过期、未撤销的启用订阅，D1 写入事务再次检查

## 改动文件

| 文件 | 内容 |
| --- | --- |
| `migrations/0019_catalog_sync.sql` | 添加目录元数据列、运行记录及索引、同步租约 |
| `worker/catalog/{schema,d1-repository,repository}.ts` | 模型、D1 持久化、目录写入冲突和分组引用检查 |
| `worker/catalog/{import-service,remote,routes,groups}.ts` | 同步计划与确认、受限抓取、节点管理、分组解析和管理员接口 |
| `worker/import/detect.ts`、`worker/operations/cron.ts`、`worker/delivery/compiler.ts` | 解析格式覆盖、既有定时入口的来源选择策略、授权预览复用 |
| `src/app/api.ts`、`src/features/catalog/`、`src/styles/pages-catalog.css` | 目录响应类型、来源／节点／分组页面和局部样式 |
| `development/tests/worker/`、`development/tests/browser/admin-frontend.spec.ts` | 目录、交付、迁移及浏览器回归 |
| `development/test-core-c.mjs`、`development/screenshots/core-c/` | 固定演示数据的 Chromium 交互测试和六张截图 |

## 管理员 API 示例

以下路径使用 `/api/admin/catalog` 前缀，需要管理员会话。带请求体时使用 `Content-Type: application/json`

| 方法与路径 | 请求或结果 |
| --- | --- |
| `POST /sources/src_1/preview-diff` | 返回 `id`、`diff`、格式、HTTP 状态和耗时 |
| `POST /sources/src_1/confirm-sync` | `{"previewId":"<预览返回的 UUID>"}` |
| `POST /sources/src_1/cancel-sync` | 抓取中使用 `{}`，已生成预览时传入 `previewId` |
| `GET /sources/src_1/sync-runs` | 返回来源最近 20 条同步记录 |
| `POST /nodes/node_1/test-output` | `{"client":"mihomo"}` |
| `POST /groups/preview` | `{"groupId":"grp_1","client":"mihomo","input":{"name":"示例","sourceIds":["src_1"],"includedNodeIds":[],"excludedNodeIds":[],"nodeOrder":[],"rules":{"tags":["中继"]}}}`。可增加 `subscriptionId` 查看实际授权输出 |

原 `POST /sources/:sourceId/refresh` 现返回预览，与 `preview-diff` 一致。现有 Admin 鉴权保护接口，变更操作在审计中只保存元数据。节点原始字段和输出预览使用 `no-store`

## 迁移与回滚

先备份 D1，再应用 `0019_catalog_sync.sql` 并发布 Worker。迁移新增可空列，不要求改写存量目录。运行历史保留已删除来源的 ID，记录表与租约表不级联关联来源。旧数据读取与已有的 KV 到 D1 模块迁移均兼容

应用回滚可先保留 0019 的附加数据库结构。若需恢复旧 schema，应先导出新增字段和表，再在备份库验证以下逆向语句。旧版运行期间新同步写入的来源隔离节点、分组引用及排序会留在目录中，如需恢复上线前的目录数据应使用上线前备份。迁移记账应和 schema 一并恢复到一致状态

```sql
DROP TABLE catalog_sync_leases;
DROP TABLE catalog_sync_runs;
ALTER TABLE groups DROP COLUMN match_rules;
ALTER TABLE nodes DROP COLUMN source_metadata;
ALTER TABLE sources DROP COLUMN sync_metadata;
```

## 出站边界与未做项

- 每次远程同步只发起受限请求，超时时间 15 秒，最多 3 次跳转，每跳重验 HTTPS 和私网／保留地址。跨源跳转清空 Header，URL、Header 和捕获内容加密存储。定时执行只消费已配置的来源
- 私网 IP 字面量和本地名称继续拒绝。Worker 的 Fetch 对任意外部域名没有可用的地址绑定，先探测 DNS 也无法绑定后续 Fetch 的连接。DNS 重绑定未做端到端验证，也未追加 DNS 探测。 [Cloudflare Request](https://developers.cloudflare.com/workers/runtime-apis/request/)
- 5 MiB 上限对 `Response.body` 实际读取的字节计数，避免只信任 `Content-Length`，流超限即取消。Workers 的压缩处理由运行时负责，未在生产环境发请求验证压缩分支。 [Cloudflare Fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- 并发取消标记以 D1 为准。其他 Worker 实例的已开始网络调用可能继续至结束或超时，应用阶段会检查取消标记。预览载荷在 KV，跨地区可见性受现有 KV 一致性约束
- 动态地区由管理员填写。转换检查调用渲染器，未实际连通代理或执行外部客户端导入。既有公开订阅按需刷新仍使用全目录版本比较，本次组变更的主动清理按实际影响范围执行

## 验证

| 项目 | 结果 |
| --- | --- |
| 基线 Worker | 518 项通过 |
| Worker（新增同步、节点、分组及退避回归） | 525 项通过 |
| 页面、控件、订阅、模板 | 分别 228、36、14、93 项通过 |
| `npm run check`、生产构建 | 通过。构建仍报告既有的大代码块提示 |
| 设计回归 `test-design-v2-p0.mjs` 至 `test-design-v2-p3.mjs` | 四支通过 |
| 移动栏与布局回归 | `test-mobile-bar-inset.mjs`、`test-layout-switch-split.mjs` 通过 |
| 管理端 Playwright | 使用迁移后的隔离本地 D1，16 项通过 |
| D1 | Wrangler 本地正向应用全部迁移，含 0019。SQLite 含历史数据的回滚演练通过 |
| 差异预览、节点抽屉、分组规则预览 | Chromium 的 1440×900、390×844 各通过，截图保存在 `development/screenshots/core-c/` |

| 视图 | 1440 px | 390 px |
| --- | --- | --- |
| 差异预览 | [截图](development/screenshots/core-c/sync-diff-1440.png) | [截图](development/screenshots/core-c/sync-diff-390.png) |
| 节点抽屉 | [截图](development/screenshots/core-c/node-drawer-1440.png) | [截图](development/screenshots/core-c/node-drawer-390.png) |
| 分组规则预览 | [截图](development/screenshots/core-c/group-preview-1440.png) | [截图](development/screenshots/core-c/group-preview-390.png) |

交付 bundle 为 `/data/tmp/core-c-catalog.bundle`，分支为 `task/core-c-catalog`，前置提交为 `a4fabff3`
CODEX_CORE_C_DONE
