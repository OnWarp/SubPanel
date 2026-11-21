# 内嵌底栏修正三验收报告

分支 `task/mobile-bar-inset-fix3`，基线 `9e7fef9`。提交身份核实为 Muse <muse@outtw.com>。本地 `origin/main` 引用指向 `c87fbfed`，本次按指定的 `9e7fef9` 建立增量交付

## 改动文件

- `src/styles/app.css` 中，小于 768px 的内嵌模式下，面板贴紧视口上、左、右三边，两个顶角归零，保留 12px 底角和 8px 底部间隙。底栏贴底并使用窗口底色，移除顶部边框。页头使用 `safe-area-inset-top` 为内容腾出空间，底栏继续使用原有底部和横向安全区。760px 至 768px 之间仅扩展内嵌外壳，沿用原悬浮断点
- `development/test-mobile-bar-inset.mjs` 中，更新内嵌断言，加入 767px 边界以及 1440px 双模式基线几何断言，保留对 `0ms` 和压缩后 `0s` 的兼容
- `development/screenshots/mobile-bar-inset/` 中，更新管理端和用户端的 390px 浅色及深色内嵌截图，以及管理端 320px 浅色内嵌截图。四张悬浮截图与基线逐字节一致

## 验收结果

- 390px 管理端及用户端在浅色和深色下，面板坐标左、上为 0，右边等于视口宽度，两个顶角均为 0。两个底角保持 12px，面板与底栏之间保留 8px 间隙
- 内嵌底栏顶部边框为 0，背景色与 body 一致。脚本确认底栏没有生成的伪元素、额外的分割元素或阴影，且与面板是直接同级元素
- 悬浮模式原有面板及底栏几何断言全部通过。767px 验证内嵌外壳，包含管理员收起侧栏及顶部导航布局。768px 和 1440px 双模式底栏及切换入口均隐藏，1440px 的两端面板边界及四角半径均与基线实测一致
- 47px 顶部及 34px 底部安全区模拟通过。320px 滚到底后，末行和页脚完整可见于面板内及底栏上方。偏好键、键盘切换入口、跨角色持久化及默认悬浮断言通过
- `npm run check` 退出码为 0。生产构建通过，Vite 仍提示主 JS chunk 大于 500 kB
- 既有套件全绿，Worker 514、页面 227、controls 33、subscriptions 14、templates 93。使用生产静态构建运行的 Chromium 移动底栏回归通过

## 未做项与交付

真机及系统界面测试未执行，使用 Chromium 模拟非零安全区。未部署。业务 API、D1、订阅、权限、`api.ts` 缓存层及 `public/_headers` 均无改动。工作区已有的 `REPORT_MOBILE_BAR_INSET.md` 修改未纳入提交

增量包为 `/data/tmp/mobile-bar-inset-fix3.bundle`，前置提交为 `9e7fef9`
CODEX_MOBILE_BAR_FIX3_DONE
