# SubPanel 多域名管理后端 B+C

分支 `task/sub-domain-refactor-backend` 基于已 fetch 的 `origin/main`（`5c01a93731a6c70020e51f2af2de6372ad90ece8`）。本次操作仅涉及仓库与本地测试 D1，未执行部署或生产 D1 命令

## 迁移

实际目录的最大号是 `0028_unified_subscription_backfill.sql`，因此使用 `0029_domain_bindings.sql`。迁移增加共享 hostname 的 `domains`、按用途保存配置的 `domain_bindings`、验证挑战表，以及按用途约束主绑定的部分唯一索引

- 回填按 hostname 合并。验证状态按 verified、failed、pending 优先，检查时间与验证时间各取最大值，错误取最近检查的值，创建时间取最早值；检查时间相同时以更新时间和旧 ID 确定顺序
- 绑定复用旧 ID、备注和启停标志。对应旧主设置的启用行继承主绑定；停用行即使被过期主设置引用也按停用普通绑定迁入，以满足主绑定必须启用的约束
- 回填使用 `INSERT OR IGNORE`，完成标记阻止迁移重跑时恢复后台已删除的旧绑定。旧表和旧主键设置保留，运行时域名读写切到新表
- 限流复用 `rate_limits`，每绑定滚动一小时至多 10 次。门禁每次读取 D1 管理开关和版本号，启用时缓存已授权 hostname 集合 15 秒；权限写入和版本更新在同一批次提交

## 管理 API

以下域名端点相对于 `/api/admin/system/domains`。`:kind` 取 `panel` 或 `subscription`，`:id` 为绑定 ID

| 请求 | 返回 |
| --- | --- |
| `GET /` | `{panel, subscription, primaryPanelDomainId, primarySubscriptionDomainId, restrictionEnabled}` |
| `GET /?purpose=panel\|subscription` | `{domains}`，只包含该用途 |
| `POST /:kind`，`{hostname,note?}` | 201 `{domain}`；另一用途可复用 hostname 和验证状态 |
| `PATCH /:kind/:id`，`{note?,enabled?}` | `{domain,autoPrimary}`；启用时若该用途无主绑定则自动设主 |
| `DELETE /:kind/:id` | 204；删除最后一个绑定时级联清理共享 hostname 的挑战 |
| `POST /:kind/:id/primary` | `{domain,refreshList:true}`；已是主绑定时幂等 |
| `POST /:kind/:id/challenge` | `{challenge:{txtName,txtValue,expiresAt}}`；24 小时有效，同一 hostname 重发会作废上一条挑战 |
| `POST /:kind/:id/verify`，`{observedInstanceId}` | 成功返回 `{domain}`；失败返回 422 及 `error.details.reason` |
| `PUT /api/admin/system/domain-restriction`，`{enabled}` | `{enabled}` |

绑定对象为 `id`、`hostname`、`purpose`、`note`、`enabled`、`isPrimary`、`verificationStatus`、`health`、`verifiedAt`、`updatedAt`、`createdAt`、`lastCheckAt`、`lastCheckError`。`health` 采用验证状态三值。迁移保留旧检查错误原文，API 将旧自由文本映射为 `LEGACY_CHECK_FAILED`，以保护网络细节

| HTTP | 错误码 |
| --- | --- |
| 400 | `INVALID_HOSTNAME`，用途查询参数非法时为 `REQUEST_INVALID` |
| 401 / 403 | `AUTH_REQUIRED` / `FORBIDDEN`；来源校验沿用 `ORIGIN_REQUIRED` |
| 404 | `NOT_FOUND`；门禁拒绝为 `DOMAIN_NOT_ALLOWED` |
| 409 | `DOMAIN_EXISTS`、`NOT_VERIFIED`、`PRIMARY_PROTECTED`、`DOMAIN_DISABLED`、`VERSION_CONFLICT` |
| 422 | `VERIFY_FAILED`，原因包括 `DNS_NOT_FOUND`、`DNS_MISMATCH`、`INSTANCE_MISMATCH`、`TIMEOUT`；一般请求体验证沿用 `VALIDATION_FAILED` |
| 429 | `VERIFY_RATE_LIMITED` |

前端探针使用简单跨域 GET，设置 `credentials: 'omit'` 和 `redirect: 'error'`，请求 `https://<hostname>/api/system/instance`。该公开端点只返回 `instanceId`，并与健康检查一起豁免门禁。验证服务只请求 Cloudflare DoH 固定端点，按哈希匹配 TXT，再比较客户端观察到的实例 ID。成功消耗挑战，启用由管理员另行操作。显式 `domain.*` 审计记录操作者和前后状态，挑战只记录过期时间。平台配置继续沿用现有逻辑

## 门禁、链接与发布条件

门禁开启时，Worker 按面板和订阅路径分别要求用途绑定已启用且共享验证通过。订阅路径包括 `/sub`、`/s` 及公开分享的 `meta/verify/export`。双用途 hostname 获得两类授权。无可用主绑定时，邀请和统一订阅 URL 返回 `null`，旧订阅链接集合为空并附 `SUBSCRIPTION_DOMAIN_NOT_CONFIGURED`；分享链接基址返回 `null`。现有 `/sub` 格式和统一订阅 `/s` 格式保留

已提交的 `wrangler.jsonc` 只让 API 与订阅路径优先进入 Worker，Cloudflare 仍可直接返回部分面板 SPA 文档。协调员合并前端挑战流程后，需要在发布时生成的配置中让文档导航进入 Worker，以应用门禁和支持浏览器探针的 CSP。可采用 `assets.run_worker_first` 路径数组 `["/*", "!/assets/*", "!/favicon.svg", "!/icons.svg", "!/logo.png", "!/theme-init.js"]`，并根据实际构建产物核对公开静态资源路径。开门禁前应在集成发布上验证：订阅专用域的 `/login` 和 `/system/distribution` 被拒绝、公开订阅文档与它依赖的静态资源正常、面板页能执行探针。线上路由覆盖和真实自定义域名 TXT 验证仍待协调员联调。[Cloudflare Worker 静态资源路由](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)

## 恢复与回滚

先为目标库备份并确认只运行本迁移单文件，然后发布后端与前端集成版本。开关默认关闭。配置导致管理员失去访问时，由具有部署数据库权限的协调员在正确的 D1 绑定执行以下 SQL，使 Worker 在下一次成功读取设置时恢复不限域名访问。可在本地用 `wrangler d1 execute subpanel-d1 --local --file <恢复文件>` 演练

```sql
INSERT INTO system_settings (key, value, updated_at)
VALUES ('domain_restriction_enabled', 'false', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
```

如需回滚应用，先关闭门禁再恢复旧版 Worker。旧版读取保留的旧表和旧主设置，切换后新表内的绑定变更需要从备份或审计中人工核对后回写。保留新表供核对与后续恢复。部署前端后，旧版验证 API 与挑战交互的兼容性也需随应用版本一起回滚

## 文件清单

- `migrations/0029_domain_bindings.sql`
- `worker/domains/domain-service.ts`、`worker/domains/verification.ts`、`worker/domains/routes.ts`、`worker/domains/host-gate.ts`、`worker/domains/service.ts`
- `worker/accounts/admin-routes.ts`、`worker/accounts/registration-routes.ts`、`worker/accounts/auth.ts`、`worker/app.ts`、`worker/platform/http.ts`
- `worker/delivery/routes.ts`、`worker/delivery/unified-routes.ts`、`worker/shares/routes.ts`
- `development/tests/worker/d1.ts`、`development/tests/worker/d1-foundation.test.ts`、`development/tests/worker/d1-domains.test.ts`、`development/tests/worker/d1-registration.test.ts`、`development/tests/worker/migration-domains.test.ts`、`development/tests/worker/spa-fallback.test.ts`、`development/tests/browser/system-domains.spec.ts`
- `REPORT-domain-backend.md`

## 验证

- `npm test -- --maxWorkers=3`，70 个文件通过，558 项通过，1 项跳过
- `INSTABOX_HEADLESS=1 npm run test:e2e -- system-domains.spec.ts`，2 项通过，覆盖 390px 域名卡片交互和 Chromium 对跨域探针 CSP 的行为
- `npm run check` 通过，现有前端 lint 警告仍有输出
- Wrangler 临时本地 D1 依次执行 0001、0007、种子更新和两次 0029，断言一个合并 hostname、两个主绑定及最新错误值 `DNS_MISMATCH`
- Vitest 域名专项覆盖用途共享、挑战轮转与消耗、错误码和限流、首次启用、并发设主、主绑定保护、门禁、URL 构建和旧数据回放

REPORT-READY
