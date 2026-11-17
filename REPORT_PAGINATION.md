# REPORT — SubPanel 列表分页（task/list-pagination-sub，基线 0c96862）

Roye 2026-11-17 拍板「加分页」：给全局自查线登记的两个无分页列表补服务端分页——管理端订阅列表、用户端节点列表。范式严格照抄管理端用户列表（本仓库唯一既有服务端分页）：`parsePagination` 逐字复制自 `worker/accounts/admin-routes.ts`（page 默认 1、pageSize 默认 20、上限钳制 100），UI 用共享 `src/ui/Pagination.tsx`（UsersPage 同款：pageCount > 1 才渲染），每页 20 条与用户列表一致（用户列表没有可选档位，故未加档位选择器）。

## 接口变化

两个接口都采用「无参保持历史响应、传参进入分页模式」的兼容口径，原因写在代码注释里：

### GET /api/admin/subscriptions（worker/delivery/routes.ts）

- 无任何参数：响应与改前逐字一致 `{ subscriptions: [...] }`（全量）。仪表盘计数、分组计数、分享页订阅选择器、用户页订阅分组共 4 个消费方都读全量，改默认行为会误伤它们
- 传任一参数（page / pageSize / q / status / expiry / enabled）进入分页模式，响应 `{ subscriptions, total, page, pageSize }`，total 为筛选后总数
- 筛选（与页面原客户端筛选同口径，先筛选后分页）：
  - `q`：名称、所属用户名、分组名三者的不区分大小写子串（用户名/分组名在服务端用 readAccounts + catalog 拼出，与原页面拼法一致）
  - `status=enabled|disabled`
  - `expiry=active|pending|soon|expired|permanent`（到期分类），或 `expiry=7|15|30`（N 天内到期窗口，兼容页面旧 URL 参数）；分类逻辑新增在 `worker/delivery/expiry.ts`：`subscriptionExpiryKind` / `isWithinExpiryDays`，与前端 `getExpiryState` / `isWithinExpiryDays` 同口径（含「permanent 不看 enabled、窗口筛选排除 disabled」等细节）
  - `enabled=1`：仅启用（对应页面 URL 的 enabled=1）
- 排序不变（沿用 listAllSubscriptions 的存储顺序）；越界页返回空数组 + 真实 total，不报错；`view()`（解密令牌 + 逐客户端读编译产物）只对当前页执行，此前是每条都跑

### GET /api/user/nodes（worker/delivery/user-nodes.ts）

- 无参数：响应保持 `{ nodes: [...] }`（既有测试对响应键有精确断言）
- 传参进入分页模式，响应 `{ nodes, total, page, pageSize, subscriptionOptions, groupOptions }`
- 筛选（与原页面客户端筛选同口径，抽成纯函数 `filterUserNodes`）：`q` 名称不区分大小写子串、`subscriptionId`、`groupId`（传 all 或不传 = 不筛选）
- subscriptionOptions / groupOptions 按全量节点集计算（与原页面从全量列表推导一致），翻页或筛选时选项不缩水
- 排序不变（collectUserNodes 既有的名称排序）

## UI 变化

- **SubscriptionsPage**：列表拆出 `loadList`（照 UsersPage 结构：参数变化经 params effect 重拉、请求序号防乱序、按当前页修剪批量选择）；筛选变化回第 1 页（changeQuery / selectExpiry 内 setPage(1)）；页数收缩时页码钳制（照管理节点页的 pageCount effect）；BatchToolbar 的 totalCount 改为服务端 total、全选改为当前页（与 UsersPage 口径一致）；空状态按 total + 是否有筛选区分「暂无订阅 / 没有符合条件的订阅」；用户与 catalog 拆为 loadMeta 与列表一并加载，增删改后的刷新路径不变
- **MyNodesPage**：同款改造——服务端分页 + 筛选参数同传（q / subscriptionId / groupId 发送校验后的 active 值，与原页面的失效选项回退 all 行为一致）；筛选选项改由服务端返回；搜索/订阅 chips/分组分段变化均回第 1 页；首次加载才显示整页 Loading，后续翻页筛选不闪；无节点空状态与带筛选无结果（表格空文案）按 total + 筛选状态区分

## 测试

- 新增 6 条用例：
  - delivery-api.test.ts 3 条：无参兼容（响应无 total/page/pageSize）、分页拼接顺序与存储顺序一致 + 越界空页 + pageSize 钳制、status/expiry（含 7/30 窗口与 enabled=1 组合）/q（名称、用户名、分组名）组合筛选后翻页
  - user-nodes.test.ts 3 条：分页拼接与无参顺序一致 + options 全量 + 越界空页、q/subscriptionId/groupId 筛选后翻页、pageSize 钳制与 page/pageSize 默认回退
- 全量验收（亲跑）：check 0 警告 0 错误；50 套件 / 380 测试全过（基线 374 + 新增 6，含 smoke）；build 全绿

## 未动

- 订阅页 720 阅读列、10 处原生 select（Roye 尚未定夺）
- 两个列表的业务逻辑、排序口径、条目操作（增删改、批量、令牌重置、详情抽屉）未改；管理端用户列表本身未动
- 已知取舍：管理端订阅的筛选/分页在路由层对 listAllSubscriptions 的全量结果做内存过滤切片（与用户列表 KV 路径同法），没有下推到 D1 SQL；订阅量级下无感，且 view() 只跑当前页已经去掉了原先最大的开销
