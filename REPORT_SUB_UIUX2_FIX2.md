SubPanel UIUX 2.0 两处修复合并验证报告

合并
基底为 origin/main 41560a0a4。任务分支 task/sub-uiux2-fix2 的合并提交 f534964 包含 Codex a5f1ab7 与 Grok 57268e939

Codex 线修复 768 px 以下共享 Dialog 与底栏重叠。AppShell 按悬浮和内嵌模式提供底部预留高度，Dialog 据此计算最大高度和居中位置，侧边抽屉也使用同一预留量

Grok 线修复未知分享令牌的浏览器整页导航。无客户端路径段且接受 HTML 的请求在相应分支返回应用壳，由分享页呈现不可用或访问验证状态。未知令牌的 JSON 请求及带客户端路径段的请求继续返回订阅不存在，有效订阅继续返回订阅内容。Vite 开发壳里的刷新脚本用精确 CSP 散列放行。新增 Worker 回归用例覆盖文档与 JSON 响应差异

全量复验
npm run check 通过，63 条警告，0 错误
npm run build 通过，构建提示主 JS 超过体积阈值。主 JS 694.58 KB，gzip 199.79 KB，主 CSS 162.81 KB，gzip 26.50 KB
Vitest 主套 69 个文件，554 通过，1 跳过，0 失败
Vitest controls 36 通过，0 失败
Vitest pages-node 235 通过，1 失败
Vitest subscriptions-node 8 通过，5 失败
Vitest templates 92 通过，1 失败

从 Vitest JSON 报告按配置、文件和完整用例名逐项比对两线记录，以下 7 条失败与基线一致，无新增失败

pages-node，navigation-structure.test.ts
  navigation ownership and route compatibility keeps 订阅管理导航 visible across its routes and highlights the current page and domain
subscriptions-node，subscriptions.test.ts
  creates a pool subscription with empty generic output
  retains and disables at exact expiry and restores after extension and enable
  public expiry denies without mutating the persisted enabled state
  uses existing share storage and guards for temporary links and preserves other shares
subscriptions-node，templates-lifecycle.test.ts
  imports a candidate before explicit save and leaves HTTPS rule-providers entirely to the client
templates，templates-lifecycle.test.ts
  imports a candidate before explicit save and leaves HTTPS rule-providers entirely to the client

Playwright 本地冒烟
从仓根手动启动 Vite 127.0.0.1:4173，Playwright 使用 SUBPANEL_EXTERNAL_SERVER=1。清空本地 D1 状态后迁移至 0028，补齐 7 个就绪标志，向本地 KV 写入 system:crypto。临时 BOOTSTRAP_SECRET 为 64 位并导出到测试进程，兑换步骤使用本地临时 REDEMPTION_HMAC_KEYS

phase4-business.spec.ts 最终 1 项通过，20 个业务及外壳步骤和 share-unknown 共 21 个记录步骤全部通过。短未知令牌显示「链接不可用」，43 位未知令牌进入「访问验证」，正文不包含令牌或 JSON 错误码
首轮在重置后读取剪贴板时未拿到新链接。改用 Playwright 对应的 Chromium 后，第二轮通过重置步骤，兑换步骤因本地 HMAC 密钥未配置而失败。补齐密钥并重新初始化本地状态后，原规格跑通

Chromium 390×844，以管理员访问 /delivery/templates，在模板行通过「更多操作」打开「编辑权益模板」
悬浮模式弹窗底边 y=728.65 px，底栏顶边 y=767.00 px，间隔 38.35 px
内嵌模式弹窗底边 y=737.20 px，底栏顶边 y=776.00 px，间隔 38.80 px
两种模式均无交叠，另验证表单可滚动、保存备注后重新打开可读回
截图保存在 /data/workspace/sub-uiux2-fix2-evidence，悬浮 39.49 KB，内嵌 38.82 KB

截图完成后已用 git checkout -- development/screenshots/ 还原。已删除 .dev.vars、还原 worker-configuration.d.ts 并复跑 check，63 条警告，0 错误
Playwright 验证范围为业务规格和模板编辑几何检查。未改 admin-frontend 的 390 宽基底测试债。未访问生产或部署

SUB_UIUX2_FIX2_DONE
