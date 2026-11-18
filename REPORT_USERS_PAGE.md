# 用户管理页重构报告

基线提交：`090b1432b6cfc9dcce81f9982168b7be6026d156`（短号 `090b1432`，说明为 Merge branch task/user-features-codex into integ）。开工时分支 `task/users-page-redesign` 指向该提交，与当时的 `origin/main` 一致。

本轮只改管理端用户管理页的呈现和行操作收纳。路由仍是 `/users`、`/invites`、`/users/recycle-bin`，三个子页都由 `UserManagementPage` 渲染。注册、邀请码和删除口径未改。

## 结构对照

| 参考项 | 实现位置 |
| --- | --- |
| 整页一个圆角卡片，沿用现行表面、边框、阴影令牌 | `UserManagementPage` 的 `section.usr-card`；`src/styles/pages-users.css` 的 `.usr-card` 使用 `--color-surface`、`--color-border`、`--radius-card`、`--shadow-panel` |
| 卡片头左侧标题「用户管理」 | `UserManagementPage` 的 `h2#users-card-title`。顶栏 `PageHeader` 仍把同一标题送进页面标题槽 |
| 右侧胶囊主按钮「邀请用户」，带 user-plus 图标，点击进入邀请子页 | `UserManagementPage` 的 `button.primary` + `UserPlus`。`navigate(\`/invites${search}\`)`，保留当前查询串。按钮样式沿用 `.button.primary` 的胶囊和 `--color-primary`，浅色蓝、深色靛蓝 `#5e6ad2` |
| 标题下文字页签：用户 / 邀请 / 回收站。当前项加粗深色，其余灰色 | `nav.usr-tabs`，`aria-label="用户管理子页"`。`NavLink` 分别指向 `/users`、`/invites`、`/users/recycle-bin`，并带上当前 `search`。选中态在 `.usr-tab.active` |
| 页签下状态筛选，默认「全部状态」，选项为实际状态：正常 / 已停用 | `UsersDirectory` 的 `FormSelect`，`aria-label="用户状态"`。值 `all` / `enabled` / `disabled` 对应列表接口的 `status` 参数 |
| 列顺序：勾选、用户、角色、状态、订阅、操作 | `UsersDirectory` 的列定义。回收站去掉勾选，并多一列「删除时间」 |
| 用户列两行：用户名半粗；有邮箱显示邮箱，否则显示用户 ID | `.usr-name` 与 `.usr-meta`。`userSecondary` 在邮箱为空时回退到 `user.id` |
| 角色：管理员 / 用户 | 沿用 `user.role === 'admin' ? '管理员' : '用户'` |
| 状态：圆点加文字。正常为绿色，已停用为弱化色，已删除为危险色 | `.usr-status` 的圆点用 `currentColor`。`.usr-status-success` 用 `--color-success`，`.usr-status-muted` 用 `--color-text-muted`，`.usr-status-danger` 用 `--color-danger` |
| 订阅列格式「N 个」 | 列表响应里的 `subscriptionCount`，缺省按 0 |
| 操作列右对齐「•••」，收进该行全部既有操作 | `RowMenu`（`details.usr-menu`）。在用用户菜单：改邮箱、重置密码（仅普通用户）、设为管理员（仅普通用户）、停用或启用（管理员项禁用，提示「管理员不能在这里启用或停用」）、管理权益、移入回收站。回收站菜单：恢复、永久删除 |
| 表头全选和行勾选；选中后出现停用 / 启用 / 移入回收站 | 表头与行复选框。`selectedIds.size > 0` 时渲染 `BatchToolbar` |
| 卡片脚左侧「共 N 位用户」，右侧「当前页 / 总页 页」和上一页、下一页 | `.usr-card-foot`。页大小仍是 `PAGE_SIZE = 20`，查询仍是 `page`、`pageSize`、`deleted`、`status`、`q` |
| 邀请、回收站共用同一卡片和页签，原功能保留 | 邀请页渲染 `InvitesPage`，内部仍是 `InviteCodesSection`。回收站把 `UsersPage` 的 `view` 设为 `trash`，保留恢复和永久删除 |

## 批量接口审计

`worker/accounts/admin-routes.ts` 没有用户批量路由。现有单用户接口是：

- `PATCH /api/admin/users/:id`，可改 `enabled`、`email`、`role`
- `DELETE /api/admin/users/:id`，移入回收站
- `POST /api/admin/users/:id/restore`
- `POST /api/admin/users/:id/purge`
- `POST /api/admin/users/:id/reset-password`

同文件里的 `DB.batch` 是 D1 事务写法，邀请码的 `type: 'batch'` 是邀请生成，都不是用户批量接口。

前端 `executeBatch` 因此循环调用现有接口。启用和停用对每个目标发 `PATCH { enabled }`。移入回收站对每个目标发 `DELETE`。启用和停用会跳过 `role === 'admin'` 的行，这些行保持选中，并提示「普通用户状态已更新，管理员状态未改」；若选中项里没有普通用户，提示「所选用户里没有可以启用或停用的普通用户」。移入回收站包含管理员，最后一名管理员仍由接口拒绝。单行 `setEnabled` 同样在管理员上直接返回。

## 取舍

窄屏仍用 760px 卡片行：`thead` 隐藏，行和单元格改为块级，单元格用 `data-label` 显示列名。表头全选会跟着表头一起隐藏，所以 760px 及以下另有一行 `.usr-select-all-narrow`「全选」，宽屏该行为 `display: none`。溢出菜单仍是绝对定位，表格容器改为 `overflow: visible`，菜单可以画出卡片。批量条沿用现有窄屏收纳，第一项「停用」留在外面。

状态筛选旁边保留了「搜索用户名或邮箱」。列表接口和原先页面都支持 `q`，搜索请求仍发到同一个用户列表接口。

订阅列只显示列表接口已经带回的个数。原先单独请求订阅列表再展开到期明细的做法从这一列拿掉了。`PATCH` 和重置密码的响应不带 `subscriptionCount`，行内更新会合并响应并保留原来的个数，避免更新后显示成「0 个」。

分页外观从带页码的 `Pagination` 改成始终可见的「当前页 / 总页数 页」加上一页、下一页。页大小和接口参数不变。总数为 0 时页脚仍显示「共 0 位用户」和「1 / 1 页」。

## 测试

- `npm run check`：wrangler types 已是最新，`tsc -b` 通过，oxlint 在 309 个文件上 0 警告 0 错误。
- `development/vitest-pages-node.config.ts`：13 个文件、168 个测试通过，其中 `development/tests/ui/users-page.test.tsx` 新增 7 个（目录渲染、状态筛选、溢出菜单、批量勾选、回收站、用户壳、邀请壳）。
- `development/vitest.controls.config.ts`：6 个文件、24 个测试通过，包含上述 7 个用户页测试。
- `npm test`（worker 配置）：57 个文件、456 个测试通过。新增测试在 UI 配置里，worker 全量数与基线 456 一致。
- `npm run build` 通过。客户端样式 `dist/client/assets/index-C836wE50.css` 为 107.44 KB（gzip 17.11 KB），脚本 `dist/client/assets/index-Dwgq-YtO.js` 为 531.63 KB（gzip 148.81 KB）。超过 500 KB 的分块提示是原有构建提示，构建本身成功。

浏览器核对用 Playwright 驱动本机 Chromium，打开构建产物 `dist/client`，接口由页面路由模拟。桌面 1280×900 走完这些操作：搜索 `q=wuyang` 并确认请求、状态下拉选「已停用」并确认 `status=disabled`、打开普通用户菜单核对六项操作、Escape 关闭菜单、管理员的「停用」为禁用、打开并取消「编辑用户」、勾选后出现批量条、打开并取消「停用用户」确认框、菜单「启用」发出 `PATCH /api/admin/users/usr_2` 且行状态变为「正常」、「邀请用户」进入 `/invites?keep=1` 并看到「注册邀请码」和「生成邀请码」、回收站看到「回收站是空的」且请求含 `deleted=only`。390×844 下表头为 `display: none`，「全选」可见，卡片没有横向溢出。浅色卡片背景为 `rgb(255, 255, 255)`，邀请按钮不是黑色。切到深色并等 `data-theme-ready` 上的颜色过渡结束后，卡片为 `rgb(15, 16, 17)`，画布为 `rgb(8, 9, 10)`，邀请按钮为 `rgb(94, 106, 210)`。

## 未验证项

浏览器使用的是模拟接口，没有连到真实 Worker。批量确认框只打开后取消，没有在浏览器里提交整批启用、停用或移入回收站。权益抽屉、重置密码、设为管理员、恢复和永久删除没有在浏览器里提交。夹具只有两名用户，没有翻到第 2 页，也没有从界面触发「最后一名管理员」被接口拒绝的路径。宽度只看了 1280 和 390，中间宽度没有单独量。
