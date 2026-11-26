SubPanel UIUX 2.0 — 移动端模板编辑弹窗避让底栏

基线为 origin/main 41560a0a4，交付分支为 task/sub-uiux2-fix2

复现与截图
在本地以管理员身份访问 /delivery/templates，打开模板行的「更多操作」→「编辑」。Chromium 390×844 下，L 号「编辑权益模板」弹窗底边 y=801.80，悬浮底栏顶边 y=767，弹窗页脚覆盖底栏上部 34.80 px。修复后弹窗底边 y=728.65，底栏顶边仍为 y=767，两者相隔 38.35 px。内嵌模式从交叠 25.80 px 变为间隔 38.80 px
修复前截图 /data/workspace/sub-uiux2-fix2-evidence/template-edit-390-before.png（39 KB）
修复后截图 /data/workspace/sub-uiux2-fix2-evidence/template-edit-390-after.png（42 KB）
截图完成后已执行 git checkout -- development/screenshots/

改动
在 width < 768px 时，由 AppShell 现有的底栏高度变量提供 Dialog 的底部预留量。悬浮模式再计入浮动间距，安全区仍由 Dialog 原有计算计入一次。共享 Dialog 以扣减后的可用高度计算最大高度和居中位置，侧边抽屉用同一预留量约束面板高度。改动仅涉及 app.css、components.css、content-ui.css，Dialog 的 placement 与 appearance 接口保持原样

390×844 弹窗抽查
悬浮底栏下，新建权益模板交叠 34.80 px、添加节点交叠 4.50 px、添加客户端交叠 34.80 px，三处修复后均间隔 38.35 px。用户详情的订阅授权「节点预览」侧边抽屉原交叠 77 px，修复后面板底边与底栏顶边同为 y=767
版本历史、添加来源、添加分组、新建公告和绑定模板在修复前后均无交叠

复验
npm run check 通过，有 lint 警告。npm run build 通过，有构建体积警告
Playwright Chromium 定向冒烟通过。390×844 下验证打开编辑、表单内滚动、保存后重新打开并读取备注，以及两种底栏模式的几何间距。767 px 仍预留底栏，768 px 底栏隐藏且模板弹窗底边与基线相同。本次仅跑定向冒烟，集成报告所记 Playwright 全套 37 项旧失败未重跑
Vite 从仓根手动启动于 127.0.0.1:4173，Playwright 使用 SUBPANEL_EXTERNAL_SERVER=1。使用新建的本地 D1 状态，应用迁移至 0028 并补 7 个就绪标志，向本地 KV 预置加密材料，初始化密钥超过 32 位。未访问生产、未部署

Vitest 按文件及完整用例名逐项对比基线
主套 553 通过，1 跳过，0 失败
controls 36 通过，0 失败
pages-node 235 通过，1 失败
subscriptions-node 8 通过，5 失败
templates 92 通过，1 失败
旧失败名称如下，基线与修复后完全一致

pages-node
  navigation ownership and route compatibility keeps 订阅管理导航 visible across its routes and highlights the current page and domain
subscriptions-node
  creates a pool subscription with empty generic output
  retains and disables at exact expiry and restores after extension and enable
  public expiry denies without mutating the persisted enabled state
  uses existing share storage and guards for temporary links and preserves other shares
  imports a candidate before explicit save and leaves HTTPS rule-providers entirely to the client
templates
  imports a candidate before explicit save and leaves HTTPS rule-providers entirely to the client

SUB_UIUX2_FIX2_CODEX_DONE
