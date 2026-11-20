# 分享开关管理员豁免

基线：`origin/main`（`7ff8632`）。交付分支：`task/share-admin-bypass`。

## 修改前的生效点

开关字段为 `enabled`，`worker/shares/schema.ts` 的 `shareSettingsSchema` 定义该字段，`DEFAULT_SHARE_SETTINGS` 默认为 `true`。D1 键为 `share_settings`（`worker/db/settings-repository.ts`），旧 KV 键为 `state:share-settings`（`worker/shares/repository.ts`）。`readShareSettings` 根据迁移状态选择存储。独立的 `createAllowed` 是创建策略，默认开启。

路由由 `worker/app.ts` 挂载，处理器位于 `worker/shares/routes.ts`，业务判断位于 `worker/shares/service.ts`。

| 路由 | 修改前的开关行为 |
| --- | --- |
| `POST /api/shares` | `createShare` 检查 `enabled`，关闭时返回 403 `SHARE_DISABLED` |
| `POST /api/admin/shares` | 调用同一 `createShare`，同样被拦截 |
| `GET /api/shares` | 列出自己的分享，不检查开关 |
| `PUT /api/shares/:id` | `updateShare` 检查开关 |
| `POST /api/shares/:id/enable` | `setStatus` 在实际切换到 active 时检查开关 |
| `POST /api/shares/:id/reset-token` | `resetShareToken` 检查开关 |
| `POST /api/shares/:id/reveal` | `revealOriginalLink` 检查开关 |
| `POST /api/shares/:id/disable`、`POST /api/shares/:id/revoke`、`DELETE /api/shares/:id` | 不检查开关 |
| `GET /api/admin/shares`、`POST /api/admin/shares/:id/disable`、`POST /api/admin/shares/:id/revoke` | 管理员鉴权，不检查开关 |
| `GET /api/admin/share-settings`、`PUT /api/admin/share-settings` | 读取和保存设置 |
| `GET /api/shares/:token/meta`、`POST /api/shares/:token/verify`、`GET /api/shares/:token/export` | 均由 `guard` 检查开关，关闭时返回 404 `SHARE_NOT_FOUND` |

- 用户端 `src/features/delivery/MySubscriptionsPage.tsx` 的分享按钮和 `?share=` 抽屉入口原先均未读取开关。 `src/features/shares/ShareDrawer.tsx` 通过 API 管理分享。
- 管理端 `src/features/delivery/SubscriptionsPage.tsx` 的「临时分享」始终显示，未分配或已停用的订阅禁用该按钮。 `src/features/delivery/AdminSharesPage.tsx` 、`src/app/navigation.ts` 和 `src/app/router.tsx` 中的分享管理按管理员权限开放，未读取开关。
- `src/features/system/ShareSettingsSection.tsx` 读写开关并展示关闭后的提示。公开页 `/s/:token`（`src/features/shares/SharePage.tsx`） 通过公开 API 判断链接可否使用。

公开访问保持现状。关闭开关后，已发出的链接和关停期间新建的链接均无法通过公开 API 访问，包括访问者是管理员的情况。重新打开开关后，仍符合状态、有效期和访问策略的链接可以访问。

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `worker/shares/routes.ts` | 从已验证的会话取操作者角色传给服务层。管理端代建时仍以订阅所属用户为分享所有者 |
| `worker/shares/service.ts` | 创建、更新、重新启用、重置令牌和查看原始链接时，管理员跳过 `enabled` 闸。独立的创建策略 `createAllowed` 及所有权、订阅状态、数量和有效期校验仍生效 |
| `worker/delivery/routes.ts` | 用户订阅列表响应增加 `shareEnabled`，由服务端按角色和开关计算。适用于 `GET /api/account/subscriptions` 及同一处理器的别名 `/api/account/delivery`、`/api/account/delivery/subscriptions`、`/api/subscriptions`、`/api/user/subscriptions` |
| `src/features/delivery/MySubscriptionsPage.tsx` | 按 `shareEnabled` 显隐分享按钮和 `?share=` 抽屉入口 |
| `src/features/system/ShareSettingsSection.tsx` | 说明管理员可分享，以及关闭期间公开链接暂停访问 |
| `development/tests/worker/shares-api.test.ts` | 增加三个角色与开关组合，检查创建结果、用户侧能力标记及管理员在关闭期间访问公开链接的结果 |

## 角色与开关测试

| 角色 | 开关 | 请求 | 实测 |
| --- | --- | --- | --- |
| 管理员 | 关 | `POST /api/admin/shares` | 201，分享归属订阅所有者。管理员访问生成链接的公开元信息仍返回 404 `SHARE_NOT_FOUND` |
| 普通用户 | 关 | `POST /api/shares` | 403 `SHARE_DISABLED` |
| 普通用户 | 开 | `POST /api/shares` | 201，分享可在所有者的列表中查到 |

## 验证与交付

| 验证 | 基线 | 交付 |
| --- | --- | --- |
| `npm run check` | — | 通过，0 错误 |
| `npm run build` | — | 通过，有大于 500 kB 的 chunk 提示 |
| `npm test`（Cloudflare Worker 池） | 启动受阻 | 启动受阻 |
| Vitest Worker 全量（本地适配器） | 58 文件，511/511 | 58 文件，514/514 |
| Vitest 页面（`vitest-pages-node.config.ts`） | 14 文件，189/189 | 14 文件，189/189 |
| Vitest 控件（`vitest.controls.config.ts`） | 7 文件，32/32 | 7 文件，32/32 |
| Vitest 订阅（`vitest-subscriptions-node.config.ts`） | 3 文件，14/14 | 3 文件，14/14 |
| Vitest 模板（`vitest.templates.config.ts`） | 5 文件，93/93 | 5 文件，93/93 |

Cloudflare Worker 池监听 `127.0.0.1` 时收到 `EPERM`。基线和交付版本均使用同一临时 Node 适配器运行全部 Worker 测试文件，HTTP 请求经过实际的 Worker 路由和鉴权，D1 采用本地 SQLite，KV 采用内存存储。分享 API 文件 7/7 通过，包含新增的三个组合。临时适配器和日志位于 `/data/tmp/share-bypass-validation`。

原 worktree 的共享 Git 元数据只读，无法创建 `index.lock`。使用可写克隆的同名分支逐个暂存文件并提交。原 worktree 保留改动和报告。交付 bundle 路径为 `/data/tmp/share-admin-bypass.bundle`，以 `7ff8632` 为前置提交。未推送远端。
