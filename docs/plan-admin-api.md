# 套餐管理 API

阶段 5 的管理端接口。用户兑换仍见 `docs/plan-redeem-api.md`。写请求使用 Cookie 会话和 `Origin` 校验。非管理员返回 `403 ADMIN_REQUIRED`。

`/api/admin/plan-definitions` 保持完整的套餐定义接口。`/api/admin/plans` 同时服务旧订阅计划和新套餐，按请求区分，不复制处理逻辑。

## `/api/admin/plans` 与旧计划

| 请求 | 行为 |
|---|---|
| `GET /api/admin/plans`，查询里没有 `limit`、`offset`、`search`、`status`、`resource=definition` | 旧计划列表，字段含 `durationDays`、`groupIds` |
| `GET /api/admin/plans?limit=&offset=&search=&status=` | 新套餐列表。`search` 匹配名称、说明和备注。`status` 为 `enabled`、`disabled` 或 `archived` |
| `POST /api/admin/plans`，正文含 `nodeGroupIds` | 创建套餐 |
| `POST /api/admin/plans`，正文为 `durationDays` 与 `groupIds` | 创建旧计划。校验失败为 `422 VALIDATION_FAILED` |
| `DELETE /api/admin/plans/:id`，正文 `version` 为数字 | 归档套餐，`204` |
| `DELETE /api/admin/plans/:id`，空正文或没有数字 `version` | 删除旧计划 |

新套餐的读取、修改、复制和预览挂在 `/api/admin/plans` 与 `/api/admin/plan-definitions` 上，处理函数相同。

## 套餐

创建正文：`name`、`description`、`nodeGroupIds`、`durationSeconds`（`null` 为永久）、`enabled`、`remark`。`durationSeconds` 为正整数秒，或 `null`。

返回的套餐在原行之外包含：

- `note`：备注文本
- `status`：`archived` 优先于 `enabled` / `disabled`
- `nodeGroupIds`、`nodeGroups`（`id`、`name`、`enabled`、`nodeCount`、`empty`）
- `nodeCount`：所选节点组去重后的节点数。目录快照不可用时记 0
- `userCount`：未撤销实例的去重用户数
- `instanceCount`：未撤销实例数
- `stats`：`total`、`users`、`active`、`paused`、`revoked`、`expired`、`pending`

`POST /api/admin/plans/preview` 正文 `{ "nodeGroupIds": [] }`，返回 `{ nodeCount, nodeGroups, emptyGroupIds }`。未知节点组为 `400 GROUP_NOT_FOUND`。服务端仍允许空的节点组列表，管理界面要求至少选一个，并提示空节点组。

`PATCH /api/admin/plans/:id` 带 `version`。版本不符为 `409 CONFLICT`。

`POST /api/admin/plans/:id/duplicate` 复制为新套餐，`201`。

`GET /api/admin/plans/:id/users` 返回该套餐的实例，并附带 `username`、`nodeCount` 和套餐摘要。

## 分配与实例

`POST /api/admin/users/:id/plans`

```json
{ "planId": "套餐 ID", "durationMode": "inherit", "idempotencyKey": "UUID", "remark": null }
```

`durationMode` 还可为 `permanent`，或 `custom` 并带 `durationSeconds` 或 `expiresAt`。每次新分配都新建实例。带 `idempotencyKey` 时，同一用户、来源 `admin`、相同 `source_id` 的已有行返回 `200` 且 `replayed: true`，不再新建。首次成功为 `201`。

套餐停用、归档或不存在时为 `409 PLAN_NOT_ASSIGNABLE` 或 `404`。时长无效为 `400 INVALID_DURATION`。

`GET /api/admin/users/:id/plans` 在 `instances` 之外返回 `aggregate`：`subscriptionUrl`（只含掩码）、`issued`、`copyable`、`nodeCount`。实例附带 `nodeCount` 和 `copyable`。

实例操作在 `/api/admin/user-plans/:id`：

| 方法 | 路径 | 作用 |
|---|---|---|
| `PATCH` | `/api/admin/user-plans/:id` | 改开始、到期或备注，可带 `version` |
| `POST` | `.../renew` | 按 `durationSeconds` 续期 |
| `POST` | `.../pause`、`.../resume` | 暂停或恢复 |
| `DELETE` | `/api/admin/user-plans/:id` | 撤销 |
| `POST` | `.../subscription-link` | 复制链接，返回 `{ token, subscriptionUrl }` |
| `POST` | `.../reset-token` | 重置链接，旧链接失效 |

聚合链接：`POST /api/admin/users/:id/aggregate-subscription-link` 与 `POST /api/admin/users/:id/reset-aggregate-token`。无法复制时为 `409 TOKEN_RESET_REQUIRED`。

## 兑换码

列表 `GET /api/admin/redeem-codes` 支持 `search` 和 `status`（`active`、`disabled`、`expired`、`exhausted`）。每条包含 `planName`。状态优先级为停用、兑换截止、次数用完，其余为有效。明文不在列表中。

`GET /api/admin/redeem-codes/:id/redemptions` 额外返回 `username`、`instanceStatus`、`expiresAt`、`planName`。

生成、停用和删除的规则见 `docs/plan-redeem-api.md`。数量仍为 1 到 100，同一管理员每小时最多 30 次生成。

## 节点组

`GET /api/admin/catalog/groups/:groupId/plans` 返回引用该节点组的套餐 `{ id, name, status }`。分组不存在为 `404 GROUP_NOT_FOUND`。

`DELETE /api/admin/catalog/groups/:groupId` 在仍被套餐、订阅模板或启用的旧计划引用时返回 `409 GROUP_IN_USE`。`details.plans` 是套餐列表，文案带套餐名称。已归档或停用的套餐只要还引用该组，也会阻止删除。删除不会清空套餐的节点组。

## 已知限制

- 列表接口没有总数，客户端用满页来判断是否还有下一页
- 幂等分配只在请求前查询，不在同一批次里加锁。同一键的并发请求仍可能各插入一行
- 节点数来自当前目录快照。快照读取失败时记 0，不把套餐判为失败
- 复制订阅链接会轮换 token。只展示掩码的列表不能再次取出上一次的明文
- 旧计划与新套餐共用 `/api/admin/plans` 的集合路径。调用方必须带 `limit` 或 `nodeGroupIds` 才会进入新接口
