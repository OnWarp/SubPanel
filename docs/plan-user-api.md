# 用户套餐 API（阶段 6）

用户端「个人中心 / 我的套餐」使用的只读与兑换接口。与管理端接口同源：读取 `user_plans`、`plan_definitions`、`plan_node_groups`、`subscription_tokens`，兑换复用阶段 4 的 `redeemForUser`。调用方只需登录会话，用户身份永远取自会话，正文中的 `userId` 不参与。

所有响应带 `Cache-Control: private, no-store` 与 `Referrer-Policy: no-referrer`。响应不含兑换码明文、节点上游凭据、管理备注或其他用户信息。

## 状态语义

服务端按毫秒级 UTC 计算，有效区间为 `[startsAt, expiresAt)`；`expiresAt` 为 `null` 表示永久。显示状态判定顺序与权益解析器 `EntitlementResolver` 一致：

```
revoked → plan_disabled → expired → paused → pending → active
```

- `revoked` 不对用户展示：实例被撤销后不再出现在列表、详情或统计中。
- `plan_disabled`：套餐定义停用（`enabled=0`）。归档不影响历史实例，仍按时间窗口显示。
- 时间到点即过期：`expiresAt <= now` 为 `expired`。
- `paused`：实例被管理员暂停，记为停用类，不计入有效。
- `pending`：`startsAt > now`。

概览与列表把这些折叠为四个桶 `active / pending / expired / disabled`（`paused` 与 `plan_disabled` 归入 `disabled`）。`plan_disabled`、`paused` 等具体状态保留在 `status` 字段。

## `GET /api/me/overview`

```json
{
  "user": { "id": "usr_2", "username": "member", "email": null, "avatarUrl": "https://..." },
  "plans": {
    "total": 3, "active": 2, "expired": 1, "pending": 0, "disabled": 0,
    "accessStatus": "active",
    "validUntil": 1766001060000,
    "hasPermanentActivePlan": false,
    "nextExpiryAt": 1765001060000,
    "expiringSoonCount": 0,
    "lastExpiredAt": null
  },
  "serverTime": "2026-11-28T11:41:55.629Z"
}
```

- `accessStatus`：`active | pending | expired | disabled | none`。有有效实例为 `active`；否则有待生效为 `pending`；否则有过期为 `expired`；否则有停用为 `disabled`；无实例为 `none`。
- `validUntil`：最晚的有效实例到期时间（毫秒）。无有效实例，或存在永久有效实例时为 `null`。**必须结合 `accessStatus` 与 `hasPermanentActivePlan` 解释，不能把 `null` 一律渲染为永久**。
- `hasPermanentActivePlan`：存在 `expiresAt=null` 的有效实例。
- `nextExpiryAt`：最近到期的有效且非永久实例，用于临期提示；无有效实例为 `null`。
- `expiringSoonCount`：7 天内到期的有效实例数。
- `lastExpiredAt`：全部过期时最近一次到期时间，可作为辅助信息。
- `total` 等于四个桶之和；撤销实例不计入。

## `GET /api/me/plans`

查询参数：

| 参数 | 说明 |
|---|---|
| `status` | `all`（默认）、`active`、`pending`、`expired`、`disabled`。服务端过滤 |
| `limit` | 每页条数，1–100，默认 20 |
| `cursor` | 翻页游标，来自上一页的 `nextCursor` |
| `offset` | 兼容分页；与 `cursor` 互斥，提供 `cursor` 时忽略 |
| `search` | 匹配套餐名称与实例备注 |

游标编码了签发时的 `offset`、`limit`、`status`。用不同 `limit` 或 `status` 重放游标返回 `400 INVALID_INPUT`，避免静默跳行。

```json
{
  "items": [{
    "instanceId": "…", "id": "…", "planId": "…", "name": "高级套餐",
    "status": "active", "bucket": "active",
    "startsAt": 1764000000000, "expiresAt": 1766001060000,
    "createdAt": "2026-11-28T11:41:55.629Z", "nodeGroupCount": 2, "source": "redeem"
  }],
  "nextCursor": "eyJvIjoyMCwibCI6MjAsInMiOiJhbGwifQ",
  "summary": { "total": 3, "active": 2, "expired": 1, "...": "同 overview.plans" },
  "serverTime": "2026-11-28T11:41:55.645Z"
}
```

- `summary` 始终是**全量**统计，不随筛选或分页改变。
- 同一套餐多次兑换产生多个实例，各自一行，不按定义合并。
- 默认排序（方案 §6）：有效优先 → 有限期按到期升序 → 永久随后 → 待生效按生效升序 → 已过期按到期降序 → 停用按更新时间降序 → 实例 ID 稳定排序。
- 套餐定义缺失（导入数据）时 `name` 回退为「已移除套餐」。

## `GET /api/me/plans/:instanceId`

```json
{
  "plan": {
    "instanceId": "…", "planId": "…", "name": "高级套餐", "description": "",
    "status": "active", "bucket": "active",
    "startsAt": 1764000000000, "expiresAt": 1766001060000,
    "createdAt": "…", "updatedAt": "…", "remainingSeconds": 1296000,
    "source": "admin", "nodeGroupCount": 2,
    "nodeGroups": [{ "id": "grp_1", "name": "日本节点组", "enabled": true }]
  }
}
```

- 只返回本人实例。访问他人或不存在实例统一 `404 SUBSCRIPTION_NOT_FOUND`，响应相同。
- `instanceId` 是实例 ID，`planId` 是定义 ID，两者不混用。
- `source`：`admin`、`redeem`、`manual`、`migration`、`trial`。

## `POST /api/me/plans/redeem`

与 `POST /api/me/redeem` 是同一服务的两个别名，正文、响应、错误与幂等行为完全一致，详见 `docs/plan-redeem-api.md`。首次成功 `201`，同幂等键重放 `200`。

## 订阅摘要联动

`GET /api/user/subscription` 与 `/api/user/subscription/nodes` 在用户拥有任一 `user_plans` 实例时改读套餐模型，返回 `source: "plans"` 与 `packages[]`（每个实例的 `instanceId`、`name`、`status`、`expiresAt`、`nodeCount`）。没有实例的安装保持原有模板模型（`source: "templates"`），旧订阅链接与客户端导入不变。

## 错误

| 状态 | 代码 | 含义 |
|---|---|---|
| 401 | `AUTH_REQUIRED` | 未登录 |
| 400 | `INVALID_INPUT` | 列表参数或游标无效 |
| 404 | `SUBSCRIPTION_NOT_FOUND` | 用户不可用，或实例不存在/不属于本人 |

## 已应用的索引

沿用 `0031_plan_schema.sql`：`user_plans(user_id,status,expires_at)`、`user_plans(plan_id)`、`plan_node_groups(group_id)`。列表与汇总按 `user_id` 过滤并使用现有索引，无需新增迁移。
