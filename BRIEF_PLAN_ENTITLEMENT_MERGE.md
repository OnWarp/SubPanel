# 简报：权益 × 订阅合并（权益计划就是订阅计划）

## 定案（Roye 2026-11-20 15:15 原话）

「合并吧，权益计划就是订阅计划，这两其实是一个功能，其他涉及到的地方也改了」

权益（entitlements）与订阅（subscriptions）合并为一套：计划只有一个，落在订阅上；所有涉及到的地方（页面、接口、下发、注册发放、审计、统计）一并改。本简报的统一模型已锁死，不留开放项；与实查代码不符处以代码为准，并在报告中说明。

## 基线与工作区

- 基线：派活时 origin/main（派活时为 8b52c572）。交付前若 origin/main 已推进（另有两条线在途：task/delivery-settings-grouping、task/button-hover-mask），先把 origin/main 合入本分支再交付，冲突以已上线内容为准、本线语义为准。
- worktree：/data/workspace/subpanel-plan-merge；分支：task/plan-entitlement-merge。
- 迁移编号：现行已用到 0017（0016 来源开关、0017 模板增强），新迁移从 **0018** 起编号。
- 生产数据量小（用户 2、订阅 3），但迁移必须以无损为准；本线只写迁移与代码，不碰生产库（集成时先备份再执行）。

## 现状事实（已实查）

- 表：plans ＋ plan_groups（套餐目录）、user_entitlements（用户权益：计划/配额/有效期）、subscriptions（订阅实体：链接/来源/模板/分享，可入池/转移/临时分享）。
- worker/entitlements/{routes,service}.ts 独立一套接口；delivery 的 routes/compiler、admin service/audit、accounts 注册、UsersPage、MySubscriptionsPage 都引用了 entitlement。

## 统一模型（锁死）

1. **计划只有一份**：plans 即订阅计划目录，保留现有字段与 plan_groups 分组。若代码里 plans 另有归属，以实查为准并在报告中说明。
2. **订阅承载一切**：subscriptions 成为唯一实体——归属用户、计划（plan_id）、配额、到期（expires_at 一处）、状态（到期只禁用，沿用现行订阅语义）。有效性/配额判断全局只读订阅，不再读 user_entitlements。
3. **数据迁移（0018 起）**：user_entitlements 逐行映射——
   - 该用户已有订阅：把计划/配额/到期并入其订阅；冲突时以权益侧有效期为准，并在报告中逐行列明取舍。
   - 该用户无订阅：按权益新建一条已分配订阅。
   - 迁移只搬数据＋改名备份：user_entitlements 改名为 user_entitlements_legacy 留底，**不许 DROP**。
   - 迁移须可在本地空库＋造数环境反复验证：写迁移测试覆盖映射、冲突、空表三种情形。
4. **接口收口**：worker/entitlements 的 routes/service 删除或收编进 subscriptions 域；外部路径若有前端/测试在用，保留一层薄兼容或同步改掉调用方，二选一并在报告写明。注册/邀请发放默认计划改为直接建带计划的订阅；admin service、audit 事件名、下发 compiler/routes 的权益判断全部改读订阅。
5. **前端收口**：用户端「权益」展示并入「我的订阅」（计划名/配额/到期在订阅里一处看全）；管理端用户详情、订阅页、概览统计涉及权益的计数改口径到订阅；独立权益页/入口删除或改为跳转订阅页（按现行路由实查决定，报告写明）。首页卡片与「配额只在权益页展示」的旧口径随之更新到订阅页。
6. **范围外**：不做销售/支付/商店；不改 plans 的字段语义；不动 DeliverySection 结构与按钮共享样式（他线在途）。

## 验收

- `npm run check`、vitest 全量、页面测试、`npm run build` 全过，且测试计数只增不减。
- 新增迁移与合并行为测试（至少覆盖第 3 条三种情形与第 2 条判断改读订阅）。
- REPORT_PLAN_MERGE.md（分支内）含：全触点清单（文件/路由/页面逐项：改/删/兼容）、迁移映射表、每行冲突取舍、兼容层去留。
- 沙箱若跑不了 Playwright/Vite，如实记录、留待集成复跑，**不要假报**。

## 红线

- **禁止 `git add -A`**（worktree 的 node_modules 是符号链接，add -A 会把链接当文件提交），逐个 add 具体文件。
- user_entitlements 只改名留底，不许 DROP；迁移不许丢数据。
- 不碰生产库、不部署；本线只交付分支。

## 交付

- 交付走 bundle：`git bundle create /tmp/plan-entitlement-merge.bundle task/plan-entitlement-merge`（基线 origin/main 到分支头），并 `git bundle verify` 自验通过。
- REPORT_PLAN_MERGE.md 在分支内。
- 全部完成后，最后一行输出：CODEX_PLAN_MERGE_DONE
