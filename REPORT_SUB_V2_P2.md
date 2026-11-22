# SubPanel 订阅 V2 P2 交付报告

基底 `e928880`，交付分支 `task/sub-v2-p2`。生产 D1 迁移与部署由集成方操作

## 已交付

- 订阅模板实体与不可变版本：新建 `entitlement_templates` 与 `entitlement_template_versions` 独立实体，避开 legacy 规则模板。版本包含流量上限、期限（数值与单位）、节点分配策略（动态分组与独立节点）、高级限速等配置。版本表通过 D1 触发器强制不可变，禁止原地 UPDATE 或 DELETE；每次实质性配置变动生成不可变递增新版本（v1, v2 等），元数据（备注、发放状态等）调整仅自增 revision 不扰动版本号。
- 模板状态与 CRUD：提供模板创建、编辑（变更提示“将创建 vN，新版本仅影响后续发放”）、复制、停用、归档（软删除）、版本历史与引用计数。停用模板禁止后续新建发放，已有订阅保持原版本和原配置继续下发；存在历史关联订阅的模板禁止硬删除。
- 统一创建表单模板模式：订阅创建抽屉顶部提供分段控件「使用模板 | 手动创建」。选择启用模板自动载入最新不可变版本配置，支持管理员覆盖调整；覆盖后标记「已自定义」，来源版本保留在旁表 `subscription_template_origins` 中用于审计追溯。订阅实例独立保存最终生效快照，复用 P1 `createSubscription` 核心写入。
- 节点组动态引用与独立节点分配：模板中的节点组在订阅实例中保留动态引用，节点组成员变更实时反映在动态引用的订阅输出中；订阅直选节点作为独立分配快照（落库 `subscription_nodes`）。删除节点组前执行引用检查与触发器防护，存在关联订阅、模板或启用计划时拒绝删除（HTTP 409 `GROUP_IN_USE`），避免悬空引用。同时处理空组、禁用节点过滤与重叠去重。
- 管理端 UI 与导航对齐：不增设一级侧栏入口，在「订阅管理」二级导航轻量页签新增「订阅模板」与「兑换码（占位）」。模板列表提供状态、版本、期限、流量、节点策略、关联订阅数与操作；编辑抽屉分设基本信息、有效期与流量、节点分配、高级限制、发放设置。空状态遵循统一设计 token，支持桌面 1440px、笔记本 1024px 暗色模式与移动 390px 布局。

## 文件

| 位置 | 变更 |
| --- | --- |
| `migrations/0022_subscription_v2_p2.sql` | 模板、不可变版本、订阅来源旁表、独立节点分配表与约束触发器 |
| `worker/delivery/entitlement-templates.ts`、`worker/delivery/entitlement-template-routes.ts` | 模板与不可变版本领域模型、Zod 校验、引用统计与管理 API 路由 |
| `worker/delivery/{service,d1-repository,user-nodes,compiler,routes,schema,expiry}.ts` | 模板模式与手动模式统一创建、直接节点分配、动态组编译与输出去重 |
| `worker/catalog/{routes,d1-repository,repository}.ts` | 节点组删除引用校验（订阅、模板、计划）、动态受影响订阅精准解析 |
| `worker/admin/audit.ts`、`worker/app.ts`、`worker/migration/run.ts` | 模板审计支持、路由注册与迁移守护 |
| `shared/subscription-duration.ts` | 相对有效期与到期计算共享逻辑 |
| `src/app/{router,navigation,api}.ts` | 二级导航页签注册、路由映射与前端 API 客户端 |
| `src/features/delivery/{EntitlementTemplatesPanel,SubscriptionsPage,NodeAssignmentPicker,entitlement-types}.tsx` | 模板列表与抽屉编辑器、版本历史差异抽屉、统一创建抽屉分段模式与直接节点多选器 |
| `src/styles/pages-delivery.css` | 模板列表、版本历史与节点选择器样式 |
| `development/scripts/subscription-v2-p2-migration.py`、`docs/subscription-v2-p2-dry-run.json` | 迁移 dry-run 验证脚本与本地回填对账输出 |
| `development/tests/worker/{subscription-v2-p2,d1,d1-foundation,delivery-api}.test.ts` | 模板不可变性、版本回写隔离、动态组变更与旧链接输出回归测试 |
| `development/screenshots/sub-v2-p2/` | 1440px 桌面列表、1024px 笔记本暗色编辑器、390px 移动列表/版本差异/模板创建截图 |

## 迁移与对账

`migrations/0022_subscription_v2_p2.sql` 采用 Expand 模式设计：
1. 新建 `entitlement_templates` 表与 `entitlement_template_versions` 表，通过 `UNIQUE(template_id, version_no)` 保证版本唯一递增。
2. 新建 `subscription_template_origins` 旁表记录订阅与模板版本的关联；新建 `subscription_nodes` 存储订阅直选独立节点。
3. 设立只读约束与状态守护触发器：`entitlement_version_no_update` 与 `entitlement_version_no_delete` 防止篡改历史版本；`entitlement_group_in_use` 防止删除仍被引用中的节点组；`subscription_node_enabled` 防止向订阅分配已禁用节点。
4. 本地 SQLite 通过 `python3 development/scripts/subscription-v2-p2-migration.py --dry-run` 验证：
   - 现有订阅数（2）、分组关联数（2）、旁表创建记录数（2）保持 100% 不变。
   - 新增表与索引均成功建立，外键违规为 0。
   - 重复执行 0022 脚本幂等且结构完全一致（`replay_matches: true`）。

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误 0 警告（Wrangler types、TypeScript、Oxlint 退出码 0） |
| `npm run build` | 通过，Worker 构建产物 1,046.29 KB，前端客户端主要产物 664.81 KB（index）与 119.93 KB（TemplateEditor） |
| `CI=1 npm test` | 62 个测试文件、536 项测试全部通过（耗时 51.52 秒） |

回归验证项：
1. **模板修改不回写既有订阅**：编辑模板生成 v2，旧订阅配置快照（流量、到期时间、节点组）与拉取内容严格保持不变；模板停用后旧订阅继续正常下发。
2. **节点组动态引用按策略生效**：组内节点调整实时反映在动态引用的订阅输出中，直接分配指定节点的订阅快照输出不受影响；删除节点组前检查关联引用，存在引用时拒绝删除。
3. **旧链接与既有转换格式回归**：保留全部旧订阅链接、Token 鉴权逻辑、客户端别名与格式转换（Mihomo, sing-box, Clash, Surge, Loon 等 18 outputs / 18 conditional 304）。
4. **多视口视觉回归**：
   - 桌面 1440px 模板列表：`1440-template-list.png`（约 52.85 KB）
   - 笔记本 1024px 暗色模式模板编辑：`1024-template-editor-dark.png`（约 70.51 KB）
   - 移动端 390px 模板列表：`390-template-list.png`（约 44.92 KB）
   - 移动端 390px 版本历史差异：`390-version-history.png`（约 32.96 KB）
   - 移动端 390px 模板创建表单：`390-create-from-template.png`（约 44.10 KB）

## 上线与回滚

1. 生产环境执行前，集成方先对生产 D1 数据库执行完整备份。
2. 禁用 `migrations apply --remote`；集成方使用 `wrangler d1 execute DB --remote --file migrations/0022_subscription_v2_p2.sql` 单文件执行增量迁移。
3. Worker 代码发布与上线。
4. 若需紧急回滚 Worker，0022 结构仅为新增表和旁表，不破坏原有 `subscriptions` 与 `subscription_groups` 字段，P1 Worker 可直接在 0022 数据库上无缝降级运行。

## 交付物

- 分支：`task/sub-v2-p2`
- Bundle 位于 `/data/tmp/sub-v2-p2.bundle`
- 校验命令：`git bundle verify /data/tmp/sub-v2-p2.bundle`

SUB_V2_P2_DONE
