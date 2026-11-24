# 取消复制订阅与转移订阅

## 删除前盘点

基底为 `origin/main` 的 `7d5eb686`，当前分支为 `task/sub-remove-copy-transfer`，Git 身份为 Muse（muse@outtw.com）。

| 位置 | 入口与处理 |
| --- | --- |
| `src/features/delivery/SubscriptionsPage.tsx` | 删除订阅行菜单的「复制订阅」「转移」、复制请求、转移抽屉及表单状态，删除 G 批量栏的「复制」。详情行与二维码的链接复制继续可用 |
| `src/features/delivery/SubscriptionBatchJobs.tsx` | 删除复制预览及新建入口，历史任务保留结果、取消和刷新，移除执行和重试 |
| `worker/delivery/routes.ts`、`worker/app.ts` | 删除三个挂载前缀下的 `POST /:id/copy` 与 `POST /:id/transfer`，分别是 `/api/admin/subscriptions`、`/api/admin/delivery/subscriptions`、`/api/admin/delivery`，六个地址均应回 404 |
| `worker/delivery/service.ts` | 删除 `copySubscription`、`bindingForCopy`、`transferSubscription`。独立创建、令牌生成和轮换是共用能力，继续保留 |
| `worker/delivery/subscription-batch.ts`、`compile-jobs.ts` | 删除 G 批量复制校验选项、预览与写入。共享的批量预览、提交继续处理启停、换计划、换配置，复制载荷按无效操作拒绝。共享的历史任务执行及重试接口对旧复制任务回 410，读取与取消继续可用，保留历史结果及数据库字段 |
| 测试 | `worker/delivery-api.test.ts` 的转移场景、`worker/subscription-lifecycle.test.ts` 的单条与批量复制场景、`node/subscriptions.test.ts` 的 KV 转移与分享归属检查，改为验证入口移除、旧链接及归属、历史任务以及保留功能 |
| 文档 | `docs/subscription-v2-current-state.md`、`docs/subscription-v2-p1-compatibility.md`、`docs/d1/SCHEMA.md` 仍有当前行为引用，将同步更新。历史交付记录（如 `REPORT_SUBSCRIPTIONS.md`、`REPORT_CORE_A.md`、`REPORT_CORE_G.md`）保留当时的记录 |

生产代码里没有发现兑换、分享、试用、提醒或统计调用复制与转移服务。分享测试借转移改变归属以验证分享读权限，将改用测试数据直接构造相同条件。权益模板复制、转换配置复制、订阅 URL 和令牌的剪贴板复制均属独立入口。

## 改动

- `SubscriptionsPage.tsx`、`SubscriptionBatchJobs.tsx` 移除对应菜单、抽屉、预览及提交。订阅行仍提供查看详情、编辑和临时分享，详情保留链接复制与重置令牌。已存在的复制任务在历史中保留任务名及结果。
- `routes.ts`、`service.ts` 删除单条路由和服务。`subscription-batch.ts` 删除批量复制校验和写入。`compile-jobs.ts` 在取得任务租约前禁止运行旧复制任务，也禁止重试。取消旧任务仍可保留已有结果。
- `delivery-api.test.ts` 删除转移专用用例。`subscription-lifecycle.test.ts` 覆盖六个旧地址、拒绝新批量复制载荷、旧任务执行/取消/重试和历史副本 ID。`subscriptions.test.ts` 将分享归属校验改用 KV 测试数据，保留未分配订阅和到期用例。
- 三份现行文档同步更新。九张浏览器截图位于 `development/screenshots/sub-remove-copy-transfer/`，截图隐藏了本地测试令牌前缀和链接。

## 测试与回归

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过。类型定义匹配，TypeScript 零错误。Lint 77 条警告，基底同为 77 条 |
| `npm run build` | 通过。Vite 对 720 KB 的主客户端文件发出分包大小提示 |
| `CI=1 npm test` | 66 个文件通过，558 项通过，4 项跳过，0 失败 |
| 额外 Node 订阅套件 | 8 项通过、5 项失败，均可在基底复现。基底为 8 项通过、6 项失败，其中多出的失败属于已删除的无效转移目标用例。剩余失败涉及旧 KV 测试替身以及模板发布输出断言 |
| 已删除的 API | 使用管理员会话调用三个路径前缀下的复制和转移，共六个 POST，均为 404。旧复制任务的执行和重试为 410。共用的 G 预览和提交对 `action: copy` 返回 422，仍接受其他批量操作 |
| 浏览器点按 | 使用 Chromium、本地 Worker 和隔离的本地 D1，实际创建、编辑、删除测试订阅，验证剪贴板复制及重置令牌。单条编辑中实际启用、停用、换计划、换配置，批量分别执行启用、停用、换计划、换配置并检查存储结果 |
| 旧链接和其他业务 | 另建的一条已有订阅在浏览器操作前后均能使用原链接。Worker 套件覆盖旧链接和渲染格式、分享、兑换、试用、提醒、拉取统计 |
| 视觉 | 1440px、1024px、390px 均检查行菜单、详情动作和批量栏，无整页横向溢出。1024px 表格可在容器内滚动，390px 使用卡片布局。没有添加下线占位文案 |

验证使用锁文件安装的临时依赖。仓库自带的 `node_modules` 符号链接指向旧版依赖，验证后恢复原链接。

## 风险与回滚

- 旧客户端调用复制或转移会收到上述错误，需要移除相应调用。历史复制任务仍可查看和取消，已生成的副本作为普通订阅保留。
- 本次提交无迁移，无生产 D1 访问、部署或推送，也没有清理历史数据。
- 如需回滚，在集成分支对本 bundle 的任务提交执行 `git revert <任务提交>`，重新运行检查和本地回归。无需数据库回滚。回滚代码再启用旧复制、转移以及尚未取消的旧复制任务执行入口，应按当前任务状态处理。
- Bundle 交付路径为 `/data/tmp/sub-remove-copy-transfer.bundle`。

SUB_REMOVE_COPY_TRANSFER_DONE
