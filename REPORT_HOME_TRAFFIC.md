# 首页已用 / 剩余流量

分支 `task/home-traffic`，基线 `c1ea30ea`，提交身份 Muse <muse@outtw.com>。

## 数据来源核查

没有可供首页展示的真实已用流量。套餐额度 `trafficGb` 仍是管理员填写的配额，0 仍表示不限。本线不估算、不模拟，也不用 0 充当已用流量。

| 位置 | 结论 |
| --- | --- |
| `plans.traffic_gb`、`subscriptions.traffic_gb`（迁移 0018） | 配额快照。订阅在开通、换计划时从计划复制额度。没有已用字节 |
| `users`、`nodes`、`node_raw_variants`、`subscriptions` 其余列 | 没有 upload / download 计数，也没有用量时间序列 |
| `GET /api/account/subscriptions`、`GET /api/account/entitlement` | 只下发额度、状态和到期。公开订阅响应不读写 `Subscription-Userinfo` 的 upload / download |
| 节点导入 | `worker/import/sip008.ts` 把 SIP008 的 `bytes_used`、`bytes_remaining` 列入已消费字段后丢弃，不写入 extensions，也不写入节点表。这两项属于上游服务器账户，不是本面板用户经节点产生的流量 |
| Worker 定时任务 | `worker/operations/cron.ts` 只处理到期禁用，不统计流量 |

缺的是计量上报。需要由实际转发流量的节点或网关，按订阅（或能唯一对应到一条订阅的身份）上报整数 `uploadBytes` 与 `downloadBytes`，再交给 `trafficUsageFromMeasurement`。在这之前 `measuredTrafficForSubscription` 固定返回 null，响应里不出现 `usedGb` 和 `remainingGb`。

若以后落库，建议新增可空列，而不是 `DEFAULT 0`。`DEFAULT 0` 会把「还没有计量」写成「已用 0」。建议形态是 `subscriptions.upload_bytes` 与 `subscriptions.download_bytes`，类型 `INTEGER NULL`，两列同为 NULL，或两列都 `>= 0`。本线不改既有表，也不执行迁移。

## 接缝

有计量时，用户接口在现有对象上增加两个字段，不改 `trafficGb` 和其他字段的含义。

- `usedGb`：`(uploadBytes + downloadBytes) / 1024^3`。1 GB 与管理员填写的 `trafficGb` 相同，字节必须是非负安全整数。接口保留除法结果，不另做四舍五入
- `remainingGb`：`trafficGb > 0` 时为 `max(0, trafficGb - usedGb)`；`trafficGb === 0`（不限）时为 `null`
- 没有计量、字节不合法或配额不是有限非负数时，两个字段都不出现

接入点：

- `GET /api/account/subscriptions` 的每条订阅
- 用户 `POST /api/account/subscriptions/:id/token/reset` 与 `POST /api/account/subscriptions/:id/reset-token` 返回的订阅对象
- `GET /api/account/entitlement` 的摘要顶层，配额取当前或最近一条订阅上的 `plan.trafficGb`

管理端订阅响应仍走原来的 `view`，不带这两个字段。`src/app/api.ts` 只在 `AdminSubscription` 上声明可选字段，缓存层未改。`public/_headers`、cron 和管理端页面未改。

首页沿用现有状态行，不新增卡片。当前展示的订阅是第一条有效订阅，没有有效订阅时用列表第一条。这条订阅同时带有有限的 `usedGb` 和 `remainingGb`（或 `remainingGb: null`）时，状态行写成：

- 有到期：`有效期剩余 N 天 · 已用 x GB · 剩余 y GB`
- 配额不限：`已用 x GB · 剩余不限`
- 只有到期、没有计量：仍是 `有效期剩余 N 天`

展示文字把二进制尘埃收到 0.000001 GB，接口里的数字不跟着改。文案末尾不加句号。

## 改动文件

| 文件 | 差异 |
| --- | --- |
| `worker/delivery/traffic-usage.ts` | 字节到 GB 的换算、字段拼接，以及当前恒为 null 的计量读取 |
| `worker/delivery/routes.ts` | 用户订阅列表和令牌重置走上述接缝。管理端 `view` 不变 |
| `worker/delivery/plan-routes.ts` | 用户 `GET /api/account/entitlement` 走同一接缝 |
| `src/app/api.ts` | `AdminSubscription` 增加可选 `usedGb`、`remainingGb` |
| `src/features/delivery/plan-types.ts` | 用户摘要类型增加同样的可选字段 |
| `src/features/user/home-traffic.ts` | 首页状态行文案。缺字段时返回 null |
| `src/features/user/HomePage.tsx` | 把文案接进现有 `upd-home-validity` 行 |
| `development/tests/worker/traffic-usage.test.ts` | 换算，以及用户接口在没有计量时不带这两个字段 |
| `development/tests/ui/user-pages-style.test.tsx` | 有字段时写进原状态行，无字段时不出现「已用」 |
| `development/test-home-traffic.mjs`、`development/screenshots/home-traffic/` | 1440 与 390 的有计量、无计量截图，并走过打开订阅和节点 |

## 测试

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错。Wrangler 类型已是最新，oxlint 343 个文件 0 警告 |
| `npm run build` | 通过。Vite 仍提示客户端包超过 500 kB |
| `npm test` | 59 个文件，518 项通过。基线 515，本线新增 3 项 |
| `development/vitest-pages-node.config.ts` | 15 个文件，228 项通过。基线 227，本线新增 1 项 |
| `development/vitest.controls.config.ts` | 8 个文件，36 项通过 |
| `development/vitest-subscriptions-node.config.ts` | 3 个文件，14 项通过 |
| `development/vitest.templates.config.ts` | 5 个文件，93 项通过 |
| `node development/test-design-v2-p3.mjs` | 通过 |
| `node development/test-mobile-bar-inset.mjs` | 通过 |
| `node development/test-layout-switch-split.mjs` | 通过 |
| `node development/test-home-traffic.mjs` | 通过。1440 与 390 均无横向溢出，状态卡仍是「订阅」「分组 / 节点」两张。打开订阅后额度仍显示 `200 GB`，分组卡进入节点页 |

截图使用固定演示数据拦截 API。有计量的响应带 `usedGb: 42.5`、`remainingGb: 157.5`。无计量的响应不带这两个字段，与当前 Worker 一致。复现时启动 `npm run dev -- --host 127.0.0.1 --port 4182`，再运行 `node development/test-home-traffic.mjs`。

| 视口 | 有计量 | 无计量 |
| --- | --- | --- |
| 1440 × 900 | [有计量](development/screenshots/home-traffic/home-1440-with-usage.png) | [无计量](development/screenshots/home-traffic/home-1440-without-usage.png) |
| 390 × 844 | [有计量](development/screenshots/home-traffic/home-390-with-usage.png) | [无计量](development/screenshots/home-traffic/home-390-without-usage.png) |

## 未做项

首页在真实接口下不会出现已用或剩余，因为没有计量上报。这是本线的完成边界。

订阅页仍只显示流量额度。管理端、D1 表结构、`api.ts` 缓存层、`public/_headers` 和到期 cron 都未改。

## 交付与回滚

交付文件为 `/data/tmp/home-traffic.bundle`，包含 `refs/heads/task/home-traffic`，前置提交为 `c1ea30ea`。回滚时撤销本线提交即可，无需数据库或配置迁移。
