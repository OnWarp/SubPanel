# SubPanel UI/UX 2.0 集成与部署报告

## 交付

- 集成分支 `task/sub-uiux2-phase4`（Phase 1–4 整条栈）合进 main，main 由 ab885ce1f 快进到 f2a768f1e（ls-remote 已核对）
- 合并提交 6f96450a2（无冲突）＋集成修复提交 f2a768f1e；相对 main 共 112 文件 +3745/−1392，21 个提交
- 生产部署版本 ec9316d6-16c1-4052-ad38-5fef28966d0c（2026-11-25 22:32:41 UTC，100% 流量），上一生产版本 fc61c5d8
- 部署前生产 D1 已备份：hwsg /root/subpanel-d1-backup-20261126-uiux2.sql（约 264 KB）；本轮无数据库迁移，未跑 `migrations apply --remote`

## 合并内容

- Phase 1 设计基础：content-ui.css 作用域 token、PageContainer/PageHeader/SectionTabs/DetailList/StatGroup/DataTable/FilterBar/Pagination/RowActions/FormField/Dialog/ConfirmDialog/Skeleton
- Phase 2 基准页：用户详情（后端字段 effectiveBindingCount/status/latestExpiresAt/lastExpiredAt）、用户列表/邀请/回收站、模板编辑 Dialog；16 位无分隔符 token 生成，老链接继续可用；「更新绑定」改名与预览；同名模板名称后缀区分
- Phase 3 批量迁移：节点管理、订阅管理（模板列表、分享）、兑换、概览、5 页系统设置、个人中心与认证、运营与知识库、公开分享
- Phase 4 清理回归：删确认无引用的旧组件与样式，补 subscription-token/entitlement-names 测试与 phase4-business 业务规格
- 冻结接口未动：PageContainer、PageHeader、SectionTabs/ModuleTabs/DetailTabs、DetailList/StatGroup、DataTable/FilterBar/Pagination/RowActions、FormField、Dialog/ConfirmDialog、Skeleton；Phase 2 增量（DataTable.summary?、Dialog.placement?、contentOwnsModuleTabs）只被使用

## 集成复验（loop2 集成仓，最终干净树）

- check 通过：63 警告、0 错误；build 通过（客户端主 JS 662.61 KB，gzip 190.06 KB）
- vitest 主套：553 通过、1 跳过；controls：36 通过、0 失败
- 三组补充配置与基线一致：pages-node 235 通过、1 失败（navigation-structure 订阅管理导航）；subscriptions-node 8 通过、5 失败（旧订阅创建/过期/分享存储 4 项＋templates-lifecycle 1 项）；templates 92 通过、1 失败（templates-lifecycle HTTPS rule-providers）
- Playwright 冒烟（真实本地 API）：phase4-business.spec.ts 20 步全部通过，share-unknown 记为已知；topbar-fill.spec.ts 1 通过

## 集成发现并修复的一处真回归

- Phase 4 清理提交 7952fdc 删了分发页的分享开关必要说明（「分享功能开关控制普通用户的分享权限，管理员仍可分享。关闭期间所有分享链接暂停访问」），与 ⑦ 号裁定（保留必要说明）及 Phase 4 回归线已验证的要求冲突；Phase 4 合并后未重跑 Playwright 业务规格，此处漏网
- 集成时冒烟测出 distribution 一步失败，已用 f2a768f1e 恢复该句（1 行），重跑后 20 步全部通过；「分享功能」开关本身未被删，只是被移到下方区段

## 本地冒烟环境要点（供后续复用）

- 本地 D1 须清空重跑迁移至 0028 并补 7 个就绪标志（accounts/apps/catalog/delivery/shares 各 *_d1_ready＋unified_subscription_ready＋unified_subscription_public_ready，均为 true），缺失时初始化报 409
- 本地 KV 须种加密材料（`system:crypto`，schemaVersion 1，双 32 字节 base64url 密钥），否则 setup 报 500；BOOTSTRAP_SECRET（≥32 位）须同时进测试进程环境（只放 .dev.vars 不够，规格直接读 process.env）
- .dev.vars 在树内时 `wrangler types --check` 会报类型过期（它把 BOOTSTRAP_SECRET 与 REDEMPTION_HMAC_KEYS 写进 worker-configuration.d.ts）；验证完须删 .dev.vars 并还原该文件再跑 check
- Playwright 冒烟不走 `test-e2e.mjs`（它每套件清空 .wrangler/state）；手动起 vite dev（4173）＋SUBPANEL_EXTERNAL_SERVER=1，先跑 phase4-business 再跑 topbar-fill，共享同一份已初始化状态

## 线上验证（https://sub.warp.dpdns.org）

- 21 页全部 200：/、/login、/me、/admin、/dashboard、/users、/catalog/nodes、/catalog/sources、/catalog/groups、/delivery/templates、/delivery/shares、/delivery/redemptions、/system/registration、/system/distribution、/system/mail、/home、/subscriptions、/nodes、/tickets、/notices、/kb
- 线上 serving 的 JS 为 index-CCB1ZIQU.js，与本次构建一致；/api/bootstrap 200，initialized 为 true
- 未知分享令牌 /s/doesnotexist1234567890 返回 404（基底行为）；旧订阅 /sub/doesnotexist1234567890 返回 404

## 遗留问题

- 真机软键盘待 Roye 点验，本环境没有真机，不记通过
- 390 宽模板编辑弹窗与底栏垂直交叠约 35px（基底已有）
- 未知分享令牌整页导航由 Worker 返回 JSON 404，错误码 SUBSCRIPTION_NOT_FOUND（基底已知）
- 基线测试债：三组旧失败（pages-node 1、subscriptions-node 5、templates 1）与 Playwright 全套 37 项失败（旧选择器、弹窗断言、操作超时）未动；390 宽 admin-frontend 找不到「选择全部来源」
- Bundle 与截图只在 loop5/loop2（SFTP 证书过期，hwsg 主机名在 loop 机上无法解析）；报告与提交已在 origin

SUB_UIUX2_INTEG_DONE
