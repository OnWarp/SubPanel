SubPanel UI/UX 2.0 Phase 4 Codex 清理与复验报告

工作树 /data/workspace/subpanel-uiux2-phase4，分支 task/sub-uiux2-phase4，基底 task/sub-uiux2-phase3 @ 1c0237c。依据工作树的 SubPanel-UIUX-2.0.md、Phase 3 统一报告及相邻工作树的 Phase 0 至 Phase 2 报告。范围为死代码、无匹配样式、冗余文案及其测试断言。Phase 2 冻结接口、权限、路由、数据库语义、业务操作、外壳导航、Logo 和品牌色均维持原样。本次仅使用本地测试数据，未部署、未操作生产或合并 main

一、删除与保留依据

删除前在基底用 git grep 逐项核对整个跟踪树，涵盖源码、测试、路由、构建配置和样式导入。另检查旧组件对应的类名和样式入口，并与 Phase 1 至 Phase 3 的内容迁移差异对照。历史报告中的文件名和符号保留作追溯

- 删除 MigrationPage.tsx。MigrationPage 符号及文件名只有自定义处和历史报告文字引用，路由、其他源码和测试无调用
- 删除 ResourceCard.tsx 的 ResourceHeading 和 OperationsCard.tsx 的 OperationsHeading 两个旧页头导出及随之闲置的导入。两符号在可执行文件中只出现于定义处。其余表尾、选择和行操作保留，现行页面或测试仍引用
- 清理 resource-card.css 中无元素使用的旧 .resource-card 容器、旧表格与可选表头规则、旧页长控件，以及它们的分屏覆盖、已无法取值的内边距变量。删除 catalog-data-section 直系资源表尾覆盖，节点、来源、分组现用 DataTable 摘要，旧表尾只由 controls 独立测试渲染。合并连续两条相同的页脚控件选择器
- 保留 resource-card.css 的导入、分享筛选、名称列、复选和页脚样式，以及仍可匹配 .sp-table-flat 的规则。AdminSharesPage 使用分享筛选类，节点、分组、来源与分享管理使用名称类，资源选择和页脚仍有 controls 覆盖。RowActions 使用的菜单规则继续由原样式提供
- 删除个人中心旧概览和指标样式（upd-mine-overview、upd-mine-metrics）、工单旧卡片列表和元数据样式（tk-card-list、tk-card-meta）。这些类在当前源码和测试无匹配，基底的全仓搜索只命中对应 CSS 定义
- 保留 LegacySubscriptionsPage。MySubscriptionsPage 对 state.kind === 'legacy' 仍显式渲染该组件，Phase 0 路由矩阵也记录了普通用户订阅兼容分支
- 保留未挂载的旧转换组件链。ConversionPage 没有现行路由，TemplatesSection.tsx 仍动态导入并渲染 TemplateEditor，且引用 TemplateList 和 RuleLibrary。按有引用的旧组件保留的要求，一并保留入口及其依赖，避免留下被拆散的组件链

二、文案与报告

- 注册页邀请模式删去对必填字段的重复说明，保留向管理员获取邀请码的提示。现有 SSR 测试直接核对邀请码输入必填并检查获取提示。首轮 pages-node 多出的失败来自对旧整句的断言，更新该断言后复跑
- 公开分享登录态删去和标题重复的一句说明，保留登录条件、登录或重试入口及错误信息
- 分享设置删去开关功能的复述，保留关闭后管理员仍可创建分享及全部分享链接暂停访问的影响
- 工作树的 Grok Phase 3 报告两处文字原本已可正常解码为 UTF-8，未发现替代字符。按 AdminMailSection 和 SharePage 对照核定并改写指定段落，明确恢复默认会清除自定义模板与当前编辑，登录成功后返回分享页。统一 Phase 3 报告同步记载核定结果

三、指定命令终轮复验

- npm run check 通过，63 条既有 lint 警告，0 错误
- npm run build 通过。客户端主 JS 694.41 KB，gzip 199.74 KB。CSS 162.53 KB，gzip 26.44 KB。构建仍有 Node 弃用和大 chunk 提示
- npm test，development/vitest.config.ts 主套通过，68 个文件通过，552 项通过，1 项跳过。跳过的是需显式启用的兑换批次基准
- controls，development/vitest.controls.config.ts 通过，8 个文件和 36 项通过
- pages-node，development/vitest-pages-node.config.ts 退出 1，14 个文件通过、1 个失败，234 项通过、1 项失败
- subscriptions-node，development/vitest-subscriptions-node.config.ts 退出 1，1 个文件通过、2 个失败，8 项通过、5 项失败
- templates，development/vitest.templates.config.ts 退出 1，4 个文件通过、1 个失败，92 项通过、1 项失败

三套预期非零退出的配置用 1c0237c 源码快照、同一套锁定依赖复跑，对比失败用例名。pages-node 的既有失败是订阅管理导航路径集合仍期待已退役的 conversions 项。subscriptions-node 的既有失败是旧池订阅创建、精确到期后的禁用和恢复、公开到期状态、旧分享存储及防护、HTTPS rule-providers 交由客户端。templates 重复命中最后一个 HTTPS rule-providers 用例，合计为六个不同的既有失败。指定的七条命令无新增失败

四、Playwright 业务复验

- Chromium 连接本机回环地址。待验版与 1c0237c 对照版各用独立源码快照、D1、KV 和本地测试账户。全套配置共 107 项，待验版与基底均为 56 项通过、37 项失败、14 项因串行前置失败而未运行，退出 1。37 个失败用例名称逐项一致
- 定向 Chromium 检查 4 项通过。覆盖邀请码必填与获取提示、公开分享要求登录、跳去登录及登录后回到分享页、分享开关的影响提示、390px 分享列表的筛选、计数、Enter 和 Escape 菜单操作、撤销确认和横向溢出。分享访问和列表响应用合成 fixture，系统设置通过本地 API 加载
- 管理员前端串行规格在全套的预建号模式下因首例预期看到首次安装页面而跳过后续。另在待验版的无账户本地库通过浏览器初始化管理员和首例导航，第二例止于来源筛选区的旧新增按钮定位。以基底单独复跑第二例，失败定位相同

本机验证日志目录为 /data/tmp/sub-uiux2-phase4-codeX.pe5TaQ。用于审计的原有未跟踪规范文件保留于工作树，提交仅包含交付改动和报告

五、未解决问题

- 上述六个不同的 Vitest 基线失败仍在
- Playwright 对照仍有 37 项失败，分别为管理员初始化规格 1 项、移动导航 1 项、modal-p0 3 项、modal-p1 6 项、modal-p2 9 项、modal-p3 16 项、普通用户订阅 1 项。覆盖旧选择器、弹窗断言和操作超时。普通用户订阅用例两次均到 30 秒超时，待验版日志额外标明 click 超时。其余 14 项管理员串行规格在全套运行中跳过
- Phase 3 记录的 390px 模板弹窗与底栏交叠约 35px、旧移动底栏脚本入口超时及旧首页文案断言保留作前序遗留。真机软键盘未复验

SUB_UIUX2_PHASE4_CODEX_DONE
