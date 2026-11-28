# 套餐兑换 API

阶段 4 的兑换层。管理端页面和用户端页面不在本阶段。旧的 `/api/admin/redemption-batches` 与 `/api/me/redemptions` 仍服务授权模板兑换，与本接口无关。

所有路径都在 `/api` 下。写请求沿用 Cookie 会话和 `Origin` 校验。用户身份只取会话里的 `user_id`。请求体里的 `userId` 若与会话不一致，返回 `403 FORBIDDEN`。

## 管理员

需要管理员角色。非管理员返回 `403 ADMIN_REQUIRED`。

### `POST /api/admin/redeem-codes`

批量生成。明文兑换码只出现在这次响应里，服务端只保存摘要和末四位。

```json
{
  "planId": "计划 ID",
  "quantity": 1,
  "maxUses": 1,
  "perUserLimit": 1,
  "durationMode": "snapshot",
  "validFrom": null,
  "validUntil": null,
  "remark": null
}
```

- `quantity` 为 1 到 100。同一管理员每小时最多 30 次生成
- `durationMode`：`snapshot` 生成时复制套餐默认时长；`inherit` 兑换时读取当时的默认时长；`fixed` 必须带 `durationSeconds`；`permanent` 为永久
- `validFrom` / `validUntil` 是兑换码自身的有效时间，单位毫秒，与发出的套餐时长无关
- 套餐停用或已归档时返回 `409 PLAN_NOT_ASSIGNABLE`
- 有效期倒置或截止时间不晚于现在时返回 `400 INVALID_DURATION`

成功为 `201`。`codes[].code` 是带分隔符的明文，只此一次。

### `GET /api/admin/redeem-codes`

分页参数 `limit`、`offset`，可选 `planId`。每条只返回 `masked`（`••••` 加末四位）和 `tail`，不返回摘要或明文。

### `PATCH /api/admin/redeem-codes/:id`

可改 `enabled` 和 `remark`。停用不会撤销已经发出的套餐实例。

### `DELETE /api/admin/redeem-codes/:id`

没有兑换记录时删除该行，返回 `204`。已有兑换记录时只停用并保留该行，返回 `{ "archived": true, "code": { ... } }`。两种情况都不修改已发出的实例。

### `GET /api/admin/redeem-codes/:id/redemptions`

分页返回兑换记录：`id`、`codeId`、`userId`、`userPlanId`、`redeemedAt`、`requestId`。不含兑换码明文和订阅 token。

## 用户

### `POST /api/me/redeem`

```json
{ "code": "XXXX-XXXX-XXXX", "idempotencyKey": "UUID" }
```

幂等键也可以放在 `Idempotency-Key` 头。头和正文都给出时必须相同，否则 `409 CONFLICT`。缺少有效幂等键时返回 `400 INVALID_INPUT`。

首次成功为 `201`，正文含 `instance`、`redemptionId`、`replayed: false`，以及仅返回给本人的 `token`。相同幂等键和相同兑换码再次请求为 `200`，`replayed: true`，返回原来的实例，不再次扣次。相同幂等键配另一个兑换码返回 `409 CONFLICT`。

每次成功兑换都新建实例和独立订阅 token，不续期已有实例，也不写聚合 token。

| 状态 | 代码 | 含义 |
|---|---|---|
| 422 | `CODE_INVALID` | 格式不对、不存在、停用、未到或已过兑换时间。这些情况文案相同 |
| 409 | `CODE_EXHAUSTED` | 总次数已用完 |
| 409 | `CODE_USER_LIMIT` | 该用户的次数已用完 |
| 409 | `PLAN_NOT_ASSIGNABLE` | 套餐已停用、归档，或不属于该用户 |
| 409 | `CONFLICT` | 幂等键与另一笔兑换冲突 |
| 400 | `INVALID_DURATION` | 发出的时长无效 |
| 403 | `FORBIDDEN` | 试图为其他用户兑换 |
| 429 | `REDEMPTION_RATE_LIMITED` | 兑换或生成过于频繁 |

用户侧错误不包含其他用户、剩余次数或兑换码摘要。同一用户 10 分钟内最多 30 次兑换尝试。

审计记录兑换、生成、停用、归档和删除，不记录明文兑换码或 token。
