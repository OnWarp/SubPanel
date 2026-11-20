# SubPanel 权益与订阅合并回归修复

## 管理员用户详情

`getSubscriptionPlanSummary` 通过 D1 SQL 按用户读取摘要所需的状态、时间窗和配额字段，保留兼容响应及原订阅选择顺序。摘要不读取令牌字段，也不解析全量下发快照。目录里缺少对应计划时跳过该订阅，无候选时返回 `none`。管理员用户详情的原用例保留了旧格式的订阅令牌夹具和 HTTP 200 断言，覆盖了此次回归。

## KV 与 D1 编译

计划夹具从启用的 `sub_1` 取分组 `[grp_2, grp_1]`。原断言继续要求每个客户端产出一个节点，并验证迁移前后的产物一致。

KV 和 D1 两条编译路径共用 D1 计划门控符合合并后的模型。订阅读取位置由迁移开关决定，D1 计划目录统一决定计划是否可用及允许的分组。两条路径都检查计划状态，并取订阅分组与计划分组的交集；这使计划停用或收窄分组在迁移前后均生效。

## loop4 本地门槛

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm run build` | 通过，Vite 提示有分块超过 500 kB |
| `npm test`（Worker 全量 Vitest） | 511 通过，0 失败（58 个测试文件） |
| `npx --no-install vitest run --config development/vitest-pages-node.config.ts` | 189 通过，0 失败 |

门槛均在原 worktree 使用已有依赖执行。共享依赖目录的缓存写入和 Worker 本地监听通过授权执行。

## 提交与交付

- 合并线提交为 `9729d50bdf1b0287a7cfdcf25701d918b775da24`。
- 修复提交为包含本报告的 `task/plan-entitlement-merge` 分支头。
- HTTPS 推送结果为 失败，沙箱无法解析 `github.com`（`Could not resolve host: github.com`），采用 bundle 交付。
- Bundle 位于 `/data/workspace/plan-entitlement-merge-fix.bundle`。修复提交完整 hash、bundle SHA-256、大小及推送退出状态写在同目录的 `plan-entitlement-merge-fix.receipt.txt`。这些值在提交和打包后生成，写回包内报告会同时改变提交和包的哈希。
