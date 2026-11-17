# 阶段 2B 报告：工单与公告

基线 `0c96862`，分支 `task/tickets-notices-cmd`。本期只做工单与公告，不涉及权益/套餐、支付或分销。迁移编号按要求固定为 `0009`；仓库当前没有 `0008`，该编号留给另一条线，`0009` 在 `0007` 之后独立应用。

## 数据表（`migrations/0009_tickets_notices.sql`）

### `tickets`

| 列 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY` | 自增 |
| `user_id` | `TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT` | 建单人 |
| `title` | `TEXT NOT NULL CHECK (length(trim(title)) > 0)` | 标题 |
| `level` | `INTEGER NOT NULL DEFAULT 0 CHECK (level IN (0, 1))` | `0` 普通，`1` 优先 |
| `status` | `TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))` | 不设“已回复”状态 |
| `created_at` / `updated_at` | `TEXT NOT NULL` | ISO 8601 |
| `last_reply_by` | `TEXT CHECK (last_reply_by IN ('user', 'admin'))` | 用于推导“已回复/待回复” |
| `last_reply_at` | `TEXT` | 队列排序与列表时间 |

索引：`tickets_user_id`、`tickets_status`、`tickets_last_reply_at`。

### `ticket_replies`

| 列 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY` | 自增 |
| `ticket_id` | `INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE` | 工单内子行 |
| `author_id` | `TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT` | 回复者 |
| `author_role` | `TEXT NOT NULL CHECK (author_role IN ('user', 'admin'))` | 用户/管理员 |
| `body` | `TEXT NOT NULL CHECK (length(trim(body)) > 0)` | 正文 |
| `created_at` | `TEXT NOT NULL` | ISO 8601 |

建单时的正文作为第一条 `author_role = 'user'` 的回复写入，详情页因此只有一个统一的往来流。索引：`ticket_replies_ticket_id`、`ticket_replies_author_id`。

### `notices`

| 列 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY` | 自增 |
| `title` | `TEXT NOT NULL CHECK (length(trim(title)) > 0)` | 标题 |
| `body` | `TEXT NOT NULL CHECK (length(trim(body)) > 0)` | 正文 |
| `sort_order` | `INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0)` | 越小越靠前 |
| `visible` | `INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1))` | 用户端只读 `1` |
| `published_at` | `TEXT NOT NULL` | 发布时间 |
| `created_at` / `updated_at` | `TEXT NOT NULL` | ISO 8601 |

索引：`notices_visible_sort(visible, sort_order, published_at)`。

### 删除与隔离

- `tickets` / `ticket_replies` 对 `users` 使用 `RESTRICT`；`purgeUserFromD1` 追加删除该用户的回复和工单，避免永久删除用户时触发外键。
- 回复随工单 `ON DELETE CASCADE`。
- 测试辅助 `enableD1Modules()` 追加 `clearTicketsStorage()`，保证每个用例的工单/公告数据隔离。

## 接口清单

### 用户端（需登录）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/tickets` | 我的工单列表，按最近回复/建单时间倒序 |
| `POST` | `/api/tickets` | 建单：`{ title, body, level }`，同时写入第一条回复 |
| `GET` | `/api/tickets/:id` | 我的工单详情 `{ ticket, replies }` |
| `POST` | `/api/tickets/:id/replies` | 追加回复：`{ body }` |
| `POST` | `/api/tickets/:id/close` | 关单 |
| `GET` | `/api/notices` | 仅返回 `visible = 1` 的公告 |

用户只能访问自己的工单；他人工单的详情、回复、关单统一返回 `404 TICKET_NOT_FOUND`（与分享等现有资源的“非本人即不存在”口径一致）。关单后用户再回复返回 `409 TICKET_CLOSED`。

### 管理端（需管理员）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/admin/tickets` | 处理队列；支持 `?status=open|closed`、`?page=`、`?pageSize=`（默认 20，上限 100），返回 `{ tickets, total, page, pageSize }` |
| `GET` | `/api/admin/tickets/:id` | 任意工单详情 |
| `POST` | `/api/admin/tickets/:id/replies` | 管理员回复；关闭状态下回复会自动重开，响应含 `reopened` |
| `POST` | `/api/admin/tickets/:id/close` | 关单；已关闭返回 `409 TICKET_ALREADY_CLOSED` |
| `POST` | `/api/admin/tickets/:id/reopen` | 显式重开；已开启返回 `409 TICKET_ALREADY_OPEN` |
| `GET` | `/api/admin/notices` | 全部公告（含隐藏） |
| `POST` | `/api/admin/notices` | 新建公告：`{ title, body, sortOrder?, visible?, publishedAt? }` |
| `PUT` | `/api/admin/notices/:id` | 部分更新同一组字段 |
| `DELETE` | `/api/admin/notices/:id` | 删除公告，成功 `204` |

排序口径：

- 工单列表与处理队列：`COALESCE(last_reply_at, created_at) DESC, id DESC`。新单没有回复时间，用建单时间参与排序，避免新单沉到底部。
- 公告：`sort_order ASC, published_at DESC, id DESC`。

“已回复”不落库，由 `status = open` 且 `last_reply_by = admin` 推导；其余开启状态显示“待回复”，`closed` 显示“已关闭”。

## 重开口径

1. 用户在工单开启时可以回复；关单后回复被拒绝（`409 TICKET_CLOSED`），需要新建工单。
2. 管理员对已关闭工单发送回复时，服务端在同一次操作中把状态改回 `open`，响应返回 `reopened: true`。这是管理员侧的主要重开路径。
3. 同时提供显式 `POST /api/admin/tickets/:id/reopen`，便于队列里直接重开而不必附加回复。
4. 管理员关闭已关闭工单返回 `409 TICKET_ALREADY_CLOSED`；重开已开启工单返回 `409 TICKET_ALREADY_OPEN`。两种情况都不做幂等静默处理，与仓库现有状态冲突口径一致。

## 页面与前端改动

- 用户首页：新增公告区，仅在有可见公告时出现，显示最近 3 条标题和发布时间，点击进入公告页看正文。
- 「更多」导航：追加「公告」「工单」入口；「我的」页菜单同步追加两项。
- 用户工单：`/tickets` 列表页（状态、等级、最后回复方、时间）＋ 新建工单弹窗；`/tickets/:id` 详情页，往来消息流，回复框置底，关单后显示提示并禁用回复。
- 用户公告：`/notices` 展示可见公告的标题、时间与正文。
- 管理端：侧栏「交付与权限」追加「工单」，队列页 `/delivery/tickets` 使用服务端分页与状态筛选，详情页 `/delivery/tickets/:id` 支持回复、关闭、重开。
- 公告管理：挂在系统页目录末尾新增「公告」分区（`NoticesSection`），支持新建、编辑、显隐切换、删除与排序/发布时间设置，不新开一级页面。
- 样式：新增 `src/styles/pages-tickets.css`，沿用现有 Apple × Linear token 与共享组件；共享文件只做追加式修改。

## 测试

新增 `development/tests/worker/tickets-notices.test.ts`，共 4 个用例：

1. **工单权限**：用户只能看到自己的工单；他人详情/回复/关单均为 `404 TICKET_NOT_FOUND`；普通用户访问管理端为 `403 ADMIN_REQUIRED`；未登录为 `401 AUTH_REQUIRED`；同时覆盖标题/正文/等级校验和非法 id。
2. **工单生命周期**：建单 → 用户回复 → 关单 → 关单后回复被拒绝 → 管理员回复自动重开 → 用户恢复回复 → 管理员关单/重复关单 → 显式重开/重复重开。
3. **管理队列**：`last_reply_at` 倒序、`page/pageSize` 分页、`status` 筛选，以及非法状态 `422 VALIDATION_FAILED`。
4. **公告显隐与排序**：用户端只返回可见公告并按 `sort_order` + `published_at` 排序；管理端可见全部；显隐切换、编辑、删除、404 与校验失败。

迁移与测试基础设施同步更新：

- `development/tests/worker/d1.ts` 注册 `0009_tickets_notices.sql`，`D1_TABLES` 加入 `tickets`、`ticket_replies`、`notices`。
- `d1-foundation.test.ts` 的迁移名列表和重放计数更新为 8。
- `helpers.ts` 在 `enableD1Modules()` 中清理工单/公告数据。

验证结果：

- `npm test`：51 个测试文件、378 个用例全部通过（既有 374 个不回退，新增 4 个）。
- `npm run check`：`wrangler types --check` 通过，`tsc -b` 通过，`oxlint` 0 警告 0 错误。
- `npm run build`：worker 与 client 构建均通过。

## 本期未做

- 不发送邮件通知（邮件凭据未配置）。
- 不做未读红点与未读状态基建；列表状态、最后回复方与时间足以定位新单。
- 不引入权益/套餐、支付或分销概念。
