# SubPanel 订阅 V2 P1 交付报告

基底 `e1c00af`，交付分支 `task/sub-v2-p1`。生产 D1 与部署留待集成方操作

## 已交付

- 沿用现有 `subscriptions.user_id` 和一对多关系。管理创建、复制、旧计划发放和注册试用共用实例配置校验、CSPRNG 凭据生成和 D1 插入列映射。试用仍在注册的 D1 batch 内写入，续期在 D1 原子累加
- 管理端 `GET /api/admin/subscriptions/:id` 复用管理 DTO。用户端 `GET /api/me/subscriptions/:id` 按登录用户归属过滤，跨用户访问与不存在使用相同的 404。既有列表与详情别名以及凭据轮换沿用当前授权边界
- 手动创建可配置用户或未分配、名称、启用、节点组、客户端、转换配置、期限、流量额度、速率和设备额度。相对期限按服务端 UTC 计算，自然月与自然年在月底截断。订阅继续以最终 `expiresAt` 为准，设备数量及流量仅作为额度配置
- 创建前显示配置摘要与预计节点数，成功进入详情。同一管理员重试相同 `Idempotency-Key` 与请求会返回原订阅，变更请求或已删除的结果返回 409。幂等记录与订阅在同一个 D1 batch 内提交，D1 约束分别保证创建键和凭据唯一。旧请求可以省略幂等键
- 公开拉取、编译、诊断、分享和用户节点复用期限判定及节点授权。到期瞬间停止下发，公开路由无需等待 Cron 状态写入。无计划或未分配订阅按配置节点组下发，计划撤销保留已发订阅的访问，历史已停用记录维持原状态。已有计划的组交集与各客户端空输出响应沿用原语义

## 文件

| 位置 | 变更 |
| --- | --- |
| `worker/delivery/{service,plans,repository,d1-repository,schema}.ts`、`worker/migration/delivery.ts` | 实例创建与更新、导入映射、来源与原子幂等 |
| `worker/delivery/{expiry,compiler,lifecycle,user-nodes,routes}.ts`、`worker/{app,public-subscriptions}.ts`、`worker/{shares/service,catalog/routes}.ts` | 详情与权限、授权与到期、输出兼容 |
| `src/features/delivery/{SubscriptionsPage,MySubscriptionsPage,UserSubscriptionPlan}.tsx`、`src/features/delivery/{expiry,plan-types}.ts` | 手动创建和编辑、最新详情、计划与订阅状态文案 |
| `migrations/0021_subscription_v2_p1.sql`、`development/scripts/subscription-v2-p1-migration.py` | 可重复的 D1 兼容迁移及只读差异检查 |
| `development/tests/worker/{subscription-v2-p1,subscription-lifecycle,delivery-api,entitlements,d1-foundation}.test.ts`、`development/tests/worker/d1.ts` | 并发、跨用户隔离、兼容契约与 D1 测试台账 |
| `development/screenshots/sub-v2-p1/` | Playwright 真实 Worker 的创建、管理详情和用户详情截图，已隐藏凭据与二维码 |
| `docs/subscription-v2-p1-compatibility.md`、`docs/subscription-v2-p1-dry-run.json` | 开工前兼容契约、本地迁移对账 |

## 迁移与对账

0021 创建 `subscription_creation`，在旁表记录旧订阅的 `legacy` 来源。旧 Worker 增补的无来源记录在 P1 读取时也按 `legacy` 处理。新手动记录标为 `manual`，旧计划和试用发放沿用 `legacy` 来源和原有 `plan_source`。迁移保留原订阅 ID、owner、凭据、期限、额度、节点组及转换绑定

本地以 0020 数据库初始化已归属和未分配记录各一条。随后使用 Wrangler `d1 execute --local --file` 连续执行最终 0021 两次，对账结果与内存 dry-run 一致

| 项目 | 迁移前 | 迁移后 |
| --- | ---: | ---: |
| 订阅 | 2 | 2 |
| 未分配 | 1 | 1 |
| 唯一凭据哈希 | 2 | 2 |
| 流量合计 GiB | 102.5 | 102.5 |
| 节点组关联 | 2 | 2 |
| V2 来源标为 legacy | — | 2 |

订阅及节点组关联的新增、删除和修改均为零，旁表外键违规为零。对账脚本只输出计数

```bash
python3 development/scripts/subscription-v2-p1-migration.py --dry-run /path/to/local-before.sqlite
python3 development/scripts/subscription-v2-p1-migration.py --dry-run /path/to/local-before.sqlite --compare /path/to/local-after.sqlite
```

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误 |
| `npm run build` | 通过，Worker 约 1,027 kB，主客户端 JS 约 648 kB。Vite 报告既有大包提示，Node 报告 punycode 弃用 |
| `CI=1 npm test` | 61 个文件，534 项全部通过 |

用基底 `e1c00af` Worker 在本地签发一条已归属的旧订阅，在同一份 D1 和 KV 上执行 0021 并切换到 P1 Worker。18 条旧路径及格式别名的响应正文、MIME、下载文件名和 ETag 全部一致，两个版本均返回预期的 18 个条件请求 304。试用注册、并发续期、同幂等键并发创建、历史未分配与转移、用户 A 读取和变更用户 B 订阅、到期瞬间的分享与输出，以及计划撤销后的授权均有集成覆盖

Playwright 在 1440、1024 和 390 px 上运行本地真实 Worker，验证手动创建及摘要、公开 Clash 拉取、管理与用户详情、两端链接复制。截图使用本地夹具并隐藏凭据

## 上线与回滚

1. 集成方先备份 D1，按实例数据在离线副本运行 dry-run，核对订阅数、归属、期限、额度和节点组
2. 生产 D1 的迁移台账为空，集成方使用 `wrangler d1 execute DB --remote --file migrations/0021_subscription_v2_p1.sql` 单文件执行。完整 `migrations apply --remote` 会从旧迁移开始。Worker 发布顺序为先 0021，再 P1
3. 若回退 Worker，保留 0021 旁表和订阅数据。基底 Worker 会恢复旧的计划门槛，回退期间无计划、未分配或已撤销计划的订阅可能停止下发。发布前可用上述旧路径和测试账号在同一份实例副本上验证回退影响
4. 幂等键依赖订阅 D1 已就绪。仍有旧 KV 订阅的实例应先按已有工具迁移订阅模块。新增流量数值仅作额度展示，实际用量由后续可信计量提供

SUB_V2_P1_DONE
