# SubPanel UI/UX 2.0 · Phase 1 交付报告

loop5 工作树 `/data/workspace/subpanel-uiux2-phase1`，分支 `task/sub-uiux2-phase1`，基底 `ab885ce1f`，内容基础提交 `7e129a3`。本阶段范围为公共前端组件和内容样式。三个基准页和其余业务页面保留现有实现，路由、权限、Worker、数据库迁移和生产环境均未改动，未部署

## 审计订正

开工前对照了 Phase 0 工作树的报告与 `471915d` 中的同一文件。两份 UTF-8 文本一致，所指两处均已有完整文字，文件内未发现 Unicode 替代字符。按源码核定的读法如下，Phase 0 工作树无需重写

- 公共组件表的弹窗行读作「统一原生 dialog 及 S/M/L 等变体」。`src/ui/Dialog.tsx` 另支持 XL，并保留忙碌状态、脏表单、Escape、焦点恢复和敏感内容控制
- §6.2 到期段读作「expiresAt 取当前有效授权最晚有限时间」。`worker/delivery/aggregate.ts` 以有效授权计算，任一永久授权则返回 permanent=true、expiresAt=null，无有效授权时 expiresAt 也为 null

## 改动清单

- `src/styles/content-ui.css` 在 PageFrame 的内容槽提供 content-bg、surface、surface-muted、text-primary、text-secondary、border、border-strong、primary、success、warning、danger 语义变量。PageContainer 和显式启用的 Dialog 消费这套变量。深色主题接现有主题语义，品牌 token 沿用现有值。浅色控件边界采用 #898989，控件主按钮使用品牌蓝的深色阶
- 内容容器支持 1440px 列表、1200px 详情、840px 表单宽度，标题、筛选和摘要可换行。纵向滚动交给工作区，宽表只在表格区域处理横向空间。表单底部和工具栏使用文档正常流
- 现有标题 portal 保留，PageHeader 可接返回入口、状态和操作。详情与模块标签复用同一链接导航实现，通过 aria-current 标记选中。接入页选择一处标题和一组标签
- 通用表格接收列、行、工具栏、分页、行操作和状态，区分首次加载与刷新。业务调用方继续管理查询、权限、动作、页码与选中范围。FormField 的渲染函数把标签、说明和错误 ID 传给控件，FormSelect 转发描述及无效状态
- 将资源行操作提取为公共 RowActions，资源调用点经兼容导出复用。沿用原生 popover 和既有视觉，提供触发器名称、Escape 和焦点返回。沿用原生 Dialog 与 ConfirmDialog，无新增抽屉实现

## 公共组件对照

| 规范职责 | 公共入口及接入方式 |
|---|---|
| PageContainer、PageHeader | `PageContainer.tsx` 选 list/detail/form；`PageHeader.tsx` 在 PageFrame 标题槽或内容区 inline 二选一 |
| 区块标题、Section | `DataHeader.tsx` 的 SectionHeading，原 DataHeader 为同一实现；`Section.tsx` 关联标题与区块 |
| ModuleTabs、DetailTabs | `SectionTabs.tsx` 的两个外观入口共用 SectionTabs；同路径不同查询参数可传 activeTo |
| StatGroup、DetailList | `DetailList.tsx` 复用语义描述列表；StatGroup 提供横向摘要 |
| DataTable、TableToolbar、Pagination | `DataTable.tsx` 支持工具栏和行操作插槽；TableToolbar 复用 `FilterBar.tsx`；分页继续用 `Pagination.tsx` |
| RowActions、BulkActions | `RowActions.tsx` 接行操作定义；BulkActions 复用 `BatchToolbar.tsx`，由调用方提供选区和全选当前结果的动作 |
| StatusIndicator | `StatusBadge.tsx` 的同一实现，视觉颜色与文字同时传达状态 |
| FormSection、FormField、FormFooter | `FormField.tsx` 中的 FormGroup、FormField、FormActions；常用输入继续复用 Controls 和 Button |
| Dialog、ConfirmDialog | 现有组件共用原生 dialog；可通过 appearance="content" 启用内容样式 |
| EmptyState、ErrorState、Skeleton、Toast | 复用 EmptyState、ErrorState 和 ToastProvider；LoadingState 模块导出 Skeleton，表格初次加载共用 |

## Phase 0 八项业务裁定

1. Phase 2 用「更新绑定」并保留效果预览，避免称续期
2. Phase 2 用户详情需要时，由后端增加权威有效授权数显式字段
3. Phase 2 用户详情需要时，由后端补无授权和过期摘要正式字段，保留永久与最晚到期各自含义
4. 已定。管理员不加链接行、不加遮罩，同名模板在名称后缀区分、不加标识列。共享或专属、绑定时间等具体后缀由 Phase 2 依据已有字段决定。新订阅链接在 Phase 2 改由后端生成 16 位无分隔符的凭据，旧链接继续可用。Phase 1 未建遮罩链接组件或链接行组件
5. 模板改动即时影响已有授权的交付配置，读取最新版。创建专属模板之后仍须执行绑定
6. 采用相对时间。兑换后的授权时长从兑换发生时起算，兑现窗口继续独立表达
7. 后续页面删套话，保留限制、风险、错误原因和恢复方式等必要说明
8. 节点详情和模板编辑继续使用弹窗，沿用现有路由。不补虚构健康检查、趋势、找回密码

## 截图与浏览器回归

- Phase 0 基线 24 张，`/data/tmp/sub-uiux2-phase0/screenshots/`
- Phase 1 同机前后各 24 张，`/data/tmp/sub-uiux2-phase1/before/` 和 `/data/tmp/sub-uiux2-phase1/after/`。后图补拍注册和自助订阅，等待邀请码表单和实际授权摘要渲染完成
- 同名成对的页面为 user-authorization、users、template-editor、templates、dashboard、nodes、registration-settings、my-subscriptions、me、setup、login、register。两档分别为 1440×1000 和 390×844。逐张对照日志 `/data/tmp/sub-uiux2-phase1/screens-compare.log`。Phase 0 与后图的默认侧栏及移动底栏对照区域逐像素一致，模板编辑的两张整图一致。部分内容有样本日期、渲染时点或光标位置差异，整图没有统一按零像素差验收
- `/data/tmp/sub-uiux2-phase1/shell-regression/` 记录 Chromium 的 1440、1280、1024、768、390 档。覆盖管理员默认及折叠侧栏、管理员深色顶部导航、管理员和普通用户的悬浮与内嵌底栏，检查 Logo、视口边界、主题、底栏菜单和样式持久化。仅 390 档进入移动底栏，768 档保留桌面外壳。用 34px 底部、47px 顶部模拟安全区复验两种角色，日志为同目录上一级的 verify-browser-safe-area.log
- 五档均用临时内容样例覆盖表格刷新保留行、表单错误关联、行操作菜单、Escape 和弹窗返回焦点。页面靠工作区纵向滚动，样例未出现额外纵向滚动或横向溢出，最后一行可滚到移动底栏上方。核验后临时样例移出工作树，无新增路由
- 本地 Worker 使用独立 KV 加密材料与本地初始化配置。重建本地 D1、应用 0001 到 0028 范围内的 27 个迁移文件，确认七个就绪标志。Vite 从仓根监听 127.0.0.1:4173，浏览器使用外部服务器模式。仓内 development/screenshots 已还原

## 测试与未解决问题

| 检查 | 结果 |
|---|---|
| npm run check | 通过，预装 Wrangler 4.114.0 的类型校验失败后切回 Phase 0 锁定依赖。Wrangler 4.166.0 检查时暂移本地浏览器用 .dev.vars，检查后复位。Oxlint 保留基底的 66 条警告 |
| npm run build | 通过，客户端主 JS 688.84 KB，gzip 196.97 KB，产物在 `/data/tmp/sub-uiux2-phase1/build/`。保留既有大 chunk 提示 |
| npm test，Vitest 主套 | 68 文件通过，550 通过、1 跳过。跳过的为需开关启用的兑换批次基准 |
| controls | 8 文件、36 通过 |
| pages-node | 234 通过、1 失败，对应既有的订阅管理导航路径集合断言 |
| subscriptions-node | 8 通过、5 失败，对应既有的旧订阅创建、过期、分享范围和模板断言 |
| templates | 92 通过、1 失败，对应既有的模板 HTTPS rule-providers URL 断言，且与 subscriptions-node 重叠 |
| 浏览器外壳 | 仓库布局切换脚本通过。仓库旧移动底栏脚本在当前分支与同基底复现普通用户旧设置地址的超时，临时改用 /me/display 后仍有旧首页空状态文案断言。外壳几何及角色底栏使用本地真实 API 的独立浏览器验证 |

- Phase 2 负责基准页接入与真实业务验收。此阶段完成浏览器外壳与组件验证，未运行完整 Playwright 业务套件或真机软键盘验证
- 本机保留 `/data/tmp/sub-uiux2-phase1/sub-uiux2-phase1.bundle` 及同名 SHA-256 文件。loop5 无法解析 hwsg 主机名，instabox CLI 无已登录会话，工具也无可用 API 凭据，因此无法取得连接信息或签发 SFTP 凭据。以提交和报告交付

SUB_UIUX2_PHASE1_DONE
