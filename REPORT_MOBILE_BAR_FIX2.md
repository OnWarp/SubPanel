# 移动端内嵌底栏修正二

分支 `task/mobile-bar-inset-fix2` 直接基于 `a003e398`，提交身份为 `Muse <muse@outtw.com>`。本地 `origin/main` 指向 `c87fbfed`，本次以简报指定的提交为准

## 改动文件

- `src/styles/app.css` 移除内嵌模式对面板底边距、边框和两个底角半径的覆盖。网格仍按底栏高度分配空间，面板沿用移动端统一的四边留白和圆角
- `development/test-mobile-bar-inset.mjs` 用底角半径和正间隙断言替换原有的共边断言，并检查滚动到底后最后一行及页脚的可见范围。保留对压缩后 `0s` 和 `0ms` 的兼容
- `development/screenshots/mobile-bar-inset/` 更新 390px 管理端和用户端的内嵌浅色及深色截图，以及 320px 管理端内嵌浅色截图。四张悬浮截图与基线逐字节一致

## 回归结果

1. 底栏仍是应用外壳中紧随面板的直接同级元素
2. 内嵌面板两个底角半径均为正值，且等于左上角半径
3. 面板底边在底栏顶边上方，正间隙与左右留边一致。常规视口和模拟 34px 底部安全区均通过
4. 内嵌面板上、左、右边缘位置及边距和两个顶角半径均与悬浮模式一致
5. 320px 下滚动到底，最后一行和页脚均完整可见于面板内，且位于底栏上方
6. 悬浮面板及底栏几何通过原有断言。默认值和无效值均回退到 `floating`，两个切换入口、键盘操作、`subpanel:mobile-bar` 存储及刷新持久化通过

生产构建通过，Vite 提示主 JS chunk 超过 500 kB。`npm run check` 通过，0 错误。Chromium 回归脚本全过

既有测试套件全部通过。Worker 514、页面 227、controls 33、subscriptions 14、templates 93

## 未做项

未做真机安全区测试或生产部署。底栏样式、应用外壳及 PageFrame 组件、业务 API、D1、订阅、权限、`api.ts` 缓存层和 `public/_headers` 均无改动

交付包位于 `/data/tmp/mobile-bar-inset-fix2.bundle`，前置提交为 `a003e398`
CODEX_MOBILE_BAR_FIX2_DONE
