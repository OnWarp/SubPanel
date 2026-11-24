# SubPanel 统一订阅 PR5 交付报告

基底为 `2ed4fbfeee92fde584add8240dac159575fb6993`。交付分支为 `task/sub-unified-pr5`。最后一次 fetch 后核对了 `origin/main`。生产结论为 **NO-GO**，§5.1 限额等价性仍需证实。所有迁移、开关测试、兼容窗口和恢复操作均在本地夹具运行。

## 实际变更

| 文件 | 改动 |
| --- | --- |
| `migrations/0028_unified_subscription_backfill.sql` | 增量建映射表、检查点和执行时源快照守卫 |
| `worker/delivery/backfill.ts`、`backfill-routes.ts`、`worker/app.ts` | 管理端盘点和脱敏预检、确认执行、逐用户 D1 原子批次、审计和对账 |
| `worker/delivery/legacy-compatibility.ts`、`worker/public-subscriptions.ts`、`worker/shares/service.ts` | 切换标记生效后限制旧链接为 90 天内的授权交集，停止无安全映射的旧分享 |
| `worker/delivery/d1-repository.ts`、`shadow.ts`、`aggregate.ts` | 按用户范围读取并对比旧节点并集、状态、时间和各格式诊断，提前拒绝过多绑定，去重相同资源选择 |
| `worker/delivery/unified-artifacts.ts`、`unified-routes.ts`、`worker/platform/http.ts` | 同实例编译去重、入场限制、输出上限和私有响应缓存指令 |
| `src/features/delivery/MigrationPage.tsx`、`src/features/accounts/UserManagementPage.tsx`、`src/app/router.tsx` | 管理端预检导出、二次确认和对账界面 |
| `development/tests/worker/d1.ts`、`unified-subscription.test.ts`、`development/test-sub-unified-pr5.mjs` | D1 夹具、并发回填和重试、权限边界、尺寸上限和三档浏览器回归 |
| `development/screenshots/sub-unified-pr5/` | 18 张本地浏览器回归截图，合计约 588 KB |
| `wrangler.jsonc` | 删除失效的 15 分钟 cron 声明 |
| `docs/unified-subscription-migration.md` | 发布、监控、回滚和恢复演练记录 |

0028 保留旧订阅、转换版本、旧分享、兑换和审计记录。一个用户是一个批次，每条旧订阅使用独立兼容模板，保留时间区间和暂停状态。现有统一令牌沿用，首次生成独立用户令牌。旧令牌和当前统一授权使用相同的有效绑定过滤，兼容入口再与原节点范围和旧授权取交集。活跃旧分享、计划限额、独立转换、孤立订阅及陈旧映射分别进入核对流程。已有映射的源订阅变化后需人工对账，预检阻止盲目重跑。仍可按已验证的旧路径运行现有发行业务。

## 验证

- `npm run check` 退出 0，类型检查无错误，有 66 条仓库既有 lint 警告。 `npm run build` 退出 0，有既有依赖弃用与打包尺寸提示。
- `CI=1 npm test` 最终运行 68 个文件通过，591 条通过、4 条按配置跳过。使用 4 个 Vitest worker。
- Node 订阅迁移测试通过 1 条，使用仓库自带的 Vitest Node 配置。
- 本地 D1 全量 27 条迁移成功。独立持久化目录先迁至 0027，再增量应用 0028，哨兵行保留，外键检查无违规。
- 浏览器 1440、1024、390 三档通过。覆盖预检、确认取消和执行、对账、旧入口成功与拒绝、空状态和错误视图。夹具使用 Wrangler 本地 Worker、七个显式就绪值，以及清理后的本地域名。关闭 Wrangler 路由源推断，浏览器流量仅到本机。
- §11 检查覆盖重复授权与稳定令牌、模板发布/禁用/恢复、节点授权并集、到期与未来/永久/月末、并发替换、并发兑换/重放/回滚、令牌重置/停用/条件请求、产物失效及用户隔离、旧分享边界、限额阻断、迁移重试和客户端格式。用本地夹具的对账工具验证一名匹配用户。Worker 用例另外验证一名有限额用户在预检阶段暂缓，以及匹配用户在旧令牌轮换后变为不一致。
- 恢复演练从本地停止的 Worker 归档 D1 和 KV，展开至独立目录。40 KB 压缩归档包含 27 条迁移记录、1 个用户、1 条旧订阅、1 条绑定、1 条映射、1 条检查点、1 个节点和 6 条审计记录，对应 4 个 KV blob。源及目标 SQLite 完整性通过，外键检查无违规，Wrangler 从恢复目录读取映射和检查点均为 1。

## 压测

使用本地一节点夹具，每轮并发发出 12 个请求。下表 D1 数据来自本地 Worker trace。两轮均无上游请求。

| 入口 | 返回 | 批次耗时 | 最大响应体 | 每请求 D1 操作数 | 每请求 D1 读取行数 |
| --- | --- | --- | --- | --- | --- |
| 旧链接兼容 | 5 个 200、7 个 503 | 286 ms | 0.133 KB | 8–28 | 16–53 |
| 统一订阅 sing-box | 12 个 200 | 277 ms | 0.403 KB | 22 | 40–43 |

Workerd trace 的 CPU 计时在该夹具均为 0 ms，无法据此估算部署环境 CPU。合成聚合用例实际验证 32 个绑定、2000 个节点及 2 MB 输出边界（按 MiB 计），第 33 个绑定、第 2001 个节点和超限输出返回错误。现有持久化 Catalog 上限仍适用。边缘 CPU 配额与实际生产样本的 D1 读取基线属于切换前门槛。监控口径与阈值见运行手册。

## 回滚与执行记录

扩展阶段保留旧权威路径。批准切换且发生新写入后，使用维护模式、向前修复或经验证的反向迁移，必要时恢复备份并对账新写入。禁止直接部署旧 Worker。

执行风险检查拦截 1 次，涉及递归删除本地状态目录。改为移动旧目录，再应用全量迁移。类型与 Worker 测试运行期间隔离本地浏览器 secrets。交付使用 Git bundle，生产开关、真实用户和生产数据未操作。

SUB_UNIFIED_PR5_DONE
