# SubPanel UI/UX 2.0 Phase 2 统一交付报告

## 分支与合并

- 目标分支 `task/sub-uiux2-phase2`。Phase 1 对照基底 `b83614a9d`。Codex 合并前为 `b09bf0c5808b9a60dccfae1d4dbfcae4ba85bd01`
- 合并前经 SSH fetch 核对，`origin/task/sub-uiux2-phase2-grok` 为 `95eab298829a6e6623803690e9b16ff4e432cd82`，与交接一致。合并提交 `5123b237f192368fff322f31b8e23d84e4526663`
- 合并后复验的分支 HEAD 为 `c1863a7bfd14e6dc8e2028d5f9ce3a6803f00e9c`，包含 topbar 浏览器规格修订。正式交付 HEAD 为包含本报告的直接子提交
- `AppShell.tsx` 是唯一 Git 冲突。外壳同时检查 `contentOwnsModuleTabs(path)` 和 `matchPath('/users/:id', path)`。用户、邀请、回收站由内容页显示一组模块页签，用户详情仅显示其详情页签，其余模块继续使用外壳页签
- `content-ui.css` 自动合并。对照两线差异，保留 Codex 的详情、订阅授权和节点预览侧出样式，以及 Grok 的列表摘要、菜单防裁切、模板弹窗表单和版本历史样式
- 本次集成限于任务分支和本地测试。生产、部署、main、路由表、权限、数据库语义及品牌外壳均在实施范围外

## 两条线的改动

- Codex：用户详情按基本信息、订阅授权和操作日志展示。订阅授权突出有效授权数、节点数、期限与服务端状态，提供节点预览、复制与重置。绑定和「更新绑定」先预览影响，同名模板用名称中的范围区分。订阅链接由复制操作提供
- Codex：管理摘要新增 `effectiveBindingCount`、`status`、`latestExpiresAt`、`lastExpiredAt`，保留既有 `expiresAt` 语义。新发及重置的订阅凭据为 16 位无分隔符字母数字，既有 43 位凭据继续兼容。模板配置按最新版交付，有限期兑换从兑换发生时计，既有永久授权继续保持永久
- Grok：用户列表、邀请和回收站统一内容布局及模块页签。用户列表保留每页 20 条及当前页批量范围，显示摘要和紧凑分页。邀请码列表复用表格、保留生成与停用操作。回收站保留恢复与永久删除
- Grok：权益模板继续用原路由上的 L 号弹窗。期限与单位并排，窄屏折为单列。高级限制可展开，版本历史展示配置差异。保存提示已绑定用户即时读取最新版且授权时间保持原值。创建专属模板后回到订阅授权，再显式绑定
- 原始交付依据见 REPORT_SUB_UIUX2_PHASE2_CODEX.md 和 REPORT_SUB_UIUX2_PHASE2_GROK.md

## 冻结的共享接口

- `PageContainer`（`width="list" | "detail"`）和 `PageHeader`。本阶段在列表和详情采用各自宽度，在页面内容区放列表操作
- `SectionTabs`、`ModuleTabs` 及详情使用的 `DetailTabs`。冻结标签列表、查询串保留、选中项和变体的现有约定。新增导航助手 `contentOwnsModuleTabs(path)`，供外壳判断用户列表、邀请与回收站是否自行渲染模块页签
- `DetailList` 和 `StatGroup`。冻结现有明细和统计项接口，供订阅摘要与模板版本差异使用
- `DataTable`、`FilterBar`、`Pagination`、`RowActions`。保留列、行标识、加载与空态、筛选、分页及操作接口。唯一表格属性新增为可选 `summary?: ReactNode`，计数或范围说明和分页同排，也支持独立摘要
- `FormField`。冻结标签、控件关联、提示及校验信息接口，期限布局由模板弹窗样式处理
- `Dialog` / `ConfirmDialog` 的 `appearance="content"`。冻结内容外观、尺寸、焦点及关闭行为。仅 `Dialog` 新增 `placement?: "center" | "end"`，默认居中，`end` 用于同一原生弹窗的节点预览侧出形态
- `Skeleton`。冻结现有骨架接口，内容页继续使用共享加载状态
- Phase 2 对上述共享属性的增量为 `DataTable.summary`、`Dialog.placement` 和导航助手 `contentOwnsModuleTabs`。其他调整为页面接入和作用域样式

## 复验

- `npm run check` 退出 0，64 条 lint 警告。 `npm run build` 通过，客户端主 JS 692.92 KB、gzip 198.41 KB，CSS 165.13 KB、gzip 26.74 KB，保留原有大块提示
- `npm test` 主套 68 个文件通过，552 项通过、1 项跳过。controls 8 个文件、36 项通过
- 额外 Vitest 配置 pages-node 234 通过、1 失败，subscriptions-node 8 通过、5 失败，templates 92 通过、1 失败。逐项比对 Codex 基线失败名称一致，涉及旧导航断言、旧订阅及模板 HTTPS rule-providers 断言
- Chromium Playwright 使用真实本地 API。新建两套隔离 D1，重放迁移、写入七个就绪标志，配置本地 KV 加密材料及初始化环境。集成版从仓根启动 Vite 4173，Phase 1 对照使用 4174
- 用户详情通过绑定、更新绑定预览与提交、暂停、恢复、撤销、节点预览、复制、重置和专属模板创建后另绑。验证重置前后链接状态以及授权计数变化。详情仅一组详情页签
- 用户列表通过批量停用、启用、删除到回收站及恢复，邀请码生成完成后列表更新。用户、邀请和回收站均仅出现一组内容模块页签
- 模板编辑通过保存、即时生效提示和版本历史，期限从 1 到 3 自然月生成 v2，已绑定记录的到期时间保持原值。专属模板通过创建、返回用户详情后另绑
- `development/tests/browser/topbar-fill.spec.ts` 用 `SUBPANEL_EXTERNAL_SERVER=1` 首跑 1 失败，旧 `.data-section` 在 `/users` 不存在。修订规格以当前列表容器测量内容留白、宽度与页签，概览和系统设置沿用原铺满断言，侧栏与顶部布局复跑 1 通过

## 截图与复验日志

- loop5 集成证据位于 `/data/tmp/sub-uiux2-phase2-integrated/`。`before/` 是 Phase 1 对照，`after/` 是集成版。两处均包含详情的 `1440.png`、`390.png`，以及 `users-*`、`invites-*`、`recycle-*`、`templates-*`、`template-editor-*`、`template-history-*` 的 1440 和 390 对照
- 两处均有详情和用户列表 1280、1024、768 外壳截图，检查各测试宽度无页面横向溢出。集成版另有节点预览、更新绑定、模板版本、回收和邀请交互截图
- 命令日志、真实 API 浏览器日志及 topbar 复跑证据同在该目录。仓库 `development/screenshots/` 已还原

## 遗留

- 390 宽的模板编辑弹窗继续覆盖底栏区域。390×844 下弹窗与底栏垂直范围交叠约 35 px，Phase 1 对照相同，见两版 `template-editor-390.png`
- 旧移动底栏脚本入口超时、旧首页空状态文案断言为前序已知问题，本次复验之外
- Grok 原始截图与 bundle 仍在 loop2，原始截图见该机 `/data/tmp/sub-uiux2-phase2-grok/{before,after}/`。Codex 原始证据和 bundle 仍在 loop5 的 `/data/tmp/sub-uiux2-phase2/`。集成 bundle 及本地 SHA-256 在 loop5 集成证据目录
- 两线交接均记录 hwsg 无法解析。loop5 本次重试 SCP 到 `hwsg:/root/xfer/` 仍因 DNS 失败，Instabox CLI 无可用登录会话，SFTP 证书未能签发。待证书及解析恢复后取回并对照 SHA-256，本次以分支及报告提交交付

SUB_UIUX2_PHASE2_DONE
