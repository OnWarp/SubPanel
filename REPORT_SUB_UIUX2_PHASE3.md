# SubPanel UI/UX 2.0 Phase 3 批量迁移 — 统一交付报告

基底 Phase 2 分支 task/sub-uiux2-phase2 @ b5a697b。Phase 3 分支 task/sub-uiux2-phase3（本报告提交即交付 HEAD）。用户详情、用户列表、邀请、回收站、模板编辑已在 Phase 2 做完，本阶段不重做。两条线并行、一次合并、一次统一汇报。

## 两条线交付

### Codex 线（loop5）：节点管理加订阅管理加兑换

- 提交 6bf0b7c 迁移、9ef9972 报告；报告 REPORT_SUB_UIUX2_PHASE3_CODEX.md，末行 SUB_UIUX2_PHASE3_CODEX_DONE
- 18 文件，+459/-209：节点列表/来源/分组/客户端、权益模板列表/分享、兑换；导入预览给解析信息与逐条诊断，零可用保留 HTTP 422；兑换两种期限分列可兑截止与兑换后授权时长，清单仅尾码，仅首次返回完整码，不加导出；同名模板名字里区分（共享/专属加绑定生效时间，同名同作用域附模板 ID 前 8 位，冲突用完整 ID）
- 复验：check 通过（63 警告），build 通过（主 JS 696.43 KB，gzip 199.61 KB），vitest 主套 552 通过 1 跳过；三组补充配置与基线一致（pages-node 1、subscriptions-node 5、templates 1）
- 截图：35 组前后对照（7 页乘 1440/390/1280/1024/768），侧栏、Logo、底栏与工作区边界一致；bundle 在 /data/tmp/sub-uiux2-phase3/sub-uiux2-phase3-codex.bundle（未传 hwsg，主机名无法解析、证书签不出）

### Grok 线（loop2）：概览加系统设置加个人中心与认证加运营与知识库加公开分享

- 提交 1a8a22f 迁移、5028b7b 报告；报告 REPORT_SUB_UIUX2_PHASE3_GROK.md，末行 SUB_UIUX2_PHASE3_GROK_DONE
- 37 文件，+802/-469：概览七指标横向排列、无趋势无在线率、7 日内到期落到用户列表 expiry=soon 筛选；系统设置五页分区；个人中心与认证接内容区容器、外壳与校验未改；工单/公告/知识库列表与详情；公开分享现有骨架
- 复验：check 通过（64 警告），build 通过（主 JS 691.10 KB，gzip 198.66 KB），vitest 主套 552 通过 1 跳过；三组补充配置与基线一致
- 截图：改前 75 张、改后 85 张（1440/390 两档加外壳三档加交互图）；bundle 未传 hwsg（同上原因）
- 补充说明：expiry=soon 是只读筛选，后端 d1-repository 的 expirySoon 与概览计数同窗口，KV 回退路径遇该参数返回空列表，不改表结构；AppShell 对工单详情不再输出外壳 SectionTabs（与用户详情既有例外一致）；contentModulePaths 扩大路径集合，函数签名未改

## 合并

- 合并提交 6a6ca1f，把 task/sub-uiux2-phase3-grok 合进 task/sub-uiux2-phase3。唯一冲突 src/app/navigation.ts 的 contentModulePaths，两条线各自加的路由取并集解决；navigation-structure.test.ts 自动合并。
- 合并后总 diff（相对 b5a697b）：55 文件，+1334/-690。

## 合并复验

- npm run check 通过（63 警告 0 错误；.dev.vars 在场时 Wrangler 类型检查报 worker-configuration.d.ts 过期，检查前暂移、结束后复位，已复位验证）
- build 通过；vitest 主套 552 通过 1 跳过
- 三组补充配置与基线一致：pages-node 234 通过 1 失败、subscriptions-node 8 通过 5 失败、templates 92 通过 1 失败
- controls 配置发现新增 4 失败（基线 36 通过 0 失败），见测试修复一节

## 测试修复

- 提交 88f0738，3 文件：development/tests/controls/resource-cards.test.tsx、src/features/catalog/SourcesPage.tsx、REPORT_SUB_UIUX2_PHASE3_TESTFIX.md（末行 SUB_UIUX2_PHASE3_TESTFIX_DONE）
- 逐条定性：分组、节点、分享管理三条为测试过期（加载态骨架、标题区主操作、新标记），更新断言跟新行为；来源一条为产品回归（sources-toolbar 类带实际样式，迁移时丢了），产品恢复该类并同步更新测试
- 复验：controls 36 通过 0 失败；check、build、vitest 主套重跑通过（552 通过 1 跳过）；浏览器回归 topbar-fill.spec.ts 1 通过；冻结的共享组件接口未动，其他页未动

## 冻结接口

Phase 2 冻结的共享接口未改：PageContainer、PageHeader、SectionTabs、ModuleTabs、DetailTabs、DetailList、StatGroup、DataTable、FilterBar、Pagination、RowActions、FormField、Dialog、ConfirmDialog、Skeleton；Phase 2 增量 DataTable.summary、Dialog.placement、contentOwnsModuleTabs(path) 只被使用、未改签名。content-ui.css 只加两条规则（危险区上边线、系统表单水平内边距归零，Grok 线），未改冻结组件的样式文件。

## 范围与权限

- 未改权限、路由表、数据库语义；未隐藏功能、未删字段、未弱化权限校验；未引新的大型组件库；侧栏、底栏、Logo、品牌色未动；未建遮罩链接组件或链接行组件；未部署、未碰生产。
- 例外说明（均有据可查）：AppShell 工单详情去外壳页签；contentModulePaths 两线扩集合；expiry=soon 只读筛选及后端同窗口计算；sources-toolbar 类恢复。

## 未解决问题

- 三组旧失败仍在（pages-node 1、subscriptions-node 5、templates 1），基底既有，旧订阅相关
- 390 宽模板编辑弹窗与底栏垂直交叠约 35px、旧移动底栏脚本入口超时、一处旧首页空状态文案断言，均为基底既有
- bundle 与截图只在 loop5/loop2（SFTP 证书签不出，hwsg 主机名在 loop 机上无法解析）；报告与提交已在 origin，取回待证书恢复后走 hwsg /root/xfer 中转
- Grok 线报告有两处乱码字符（邮件恢复默认说明、分享登录回跳段落），内容可读，Phase 4 顺手订正
- 公开分享本地无真实分享（本地无节点），未知令牌整页导航仍由 Worker 返回 JSON 404，React 访问验证只在真实分享令牌或客户端导航下出现
- 完整 Playwright 业务套件与真机软键盘验证仍待 Phase 4；Phase 3 各线已跑本模块 Playwright 与交互截图

## 交付物

- 分支 task/sub-uiux2-phase3，已推 origin（本报告提交即交付 HEAD）
- 报告：本文件（统一）、REPORT_SUB_UIUX2_PHASE3_CODEX.md、REPORT_SUB_UIUX2_PHASE3_GROK.md、REPORT_SUB_UIUX2_PHASE3_TESTFIX.md
- 下一步：Phase 4 清理与回归（确认旧组件无引用后删除、清理重复样式与冗余文案、复跑全部测试、补关键流程测试）

SUB_UIUX2_PHASE3_DONE
