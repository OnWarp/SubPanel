# 移动端底栏点击遮罩修复

分支 `task/sub-bottom-nav-mask`，基底 `origin/main` 的 `7d5eb686`。提交身份为 Muse，邮箱为 `muse@outtw.com`。代码提交为 `45de208`。

## 定位

- 在 390 × 844 的 Chromium 触屏仿真中，保留「概览」的选中态，临时拦截「订阅管理」点击的默认导航。松手后，浏览器在整块链接矩形上绘出浅蓝遮罩。此时链接底色仍为透明，触摸没有触发焦点描边，`::before` 和 `::after` 均无内容。仅把该链接的 `-webkit-tap-highlight-color` 临时设为透明再点按，遮罩消失。基线计算值在 Chromium 为 `rgba(51, 181, 229, 0.4)`，在 WebKit 为 `rgba(0, 0, 0, 0.4)`。松手后短暂可见的矩形来自浏览器原生 tap highlight 绘制层。
- 从「节点管理」切到「订阅管理」并延迟订阅列表响应。订阅页的加载骨架出现时，`active` 与 `aria-current` 已跟到 `/delivery/subscriptions`。两端均捕获到共享 160 ms 颜色过渡让旧 pill 淡出、新 pill 淡入。Chromium 在提交后的首个采样帧仍读到旧 pill 的完整底色，新项为透明。路由映射正确，截图中的旧 pill 可由过渡时机解释。

## 修改

[src/styles/app.css](src/styles/app.css) 在现有移动端媒体查询内，将管理端和用户端的底栏链接设为透明 tap highlight，并关闭这些链接的 CSS 过渡。路由提交后立即绘制现有蓝色选中态，Tab 键的 `:focus-visible` 描边仍可见。底栏结构、入口、文案、配色及设计 token 沿用原实现。选中态仍由现有路由逻辑决定。订阅加载、旧链接、订阅令牌、后端与数据均未改动。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误，77 条基线 lint 警告 |
| `npm run build` | 通过，Worker 323 个模块，客户端 2392 个模块。Vite 报告主 JS 分块为 721.80 KB |
| `CI=1 npm test` | 66 个测试文件通过，559 项通过，0 失败，4 项按基线配置跳过的性能基准 |
| 390 px 触屏回归 | Chromium 和 Linux WebKit（iPhone 13 设备配置），使用本地 API 桩。每个引擎分别覆盖管理端及用户端的悬浮、内嵌底栏，各点按 16 次。管理端依次点按节点管理、订阅管理、用户管理、概览。路由提交后和 330 ms 后均只有目标项为实色蓝色 pill，其他项透明，tap highlight 透明。订阅加载期间也保持正确选中态。每组另验证了键盘焦点描边 |
| 1024、1440 px 桌面检查 | 两个宽度下底栏均隐藏，桌面侧栏的节点管理项正确选中。Chromium 各宽度的修复前后截图完全一致 |

[截图目录](development/screenshots/sub-bottom-nav-mask/)中的 `390-{before,after}-native-tap.png` 对比松手瞬间的原生遮罩。对照实验拦截导航以固定背景。两组 `390-{before,after}-{chromium,webkit}-subscriptions-loading.png` 对比正常导航进入订阅加载态时的 pill。1024 与 1440 px 各有一组桌面前后截图。

## 风险与回滚

改动范围为移动端底栏链接的触摸绘制和过渡。iPhone 实机 Safari 未验证，使用了 Chromium 触屏仿真和 Linux WebKit。验证环境按锁文件在独立目录安装依赖，本工作区的 `node_modules` 保持为符号链接并指向该目录。生产环境未访问或部署。

回滚可执行 `git revert 45de208` 并重新运行 `npm run build`，以恢复原有触摸高亮和过渡，无需迁移。

SUB_BOTTOM_NAV_MASK_DONE
