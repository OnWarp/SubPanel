# 工单 Dialog 滚动回归修复

基底为 `origin/main` 的 `d2c0762b8`，交付分支为 `task/sub-modal-test-fix`。

## 复现与根因

| 环境 | 修复前 | 修复后 |
| --- | --- | --- |
| loop2 | 简报记录在同一基底上复现，390px 标题的 y 从 `154.3671875` 变为 `44.703125` | 未独立复验。Instabox 远程执行因缺少作用域 API 凭据被拒绝，本机也无法解析 loop2 的主机名 |
| loop5 | 本次在 `d2c0762b8` 上用 Chromium Headless Shell 跑 P0，9/9 通过。该机旧 P0 失败轨迹也记录了完全相同的坐标 | P0 在 Chromium Headless Shell 149.0.7827.55 和系统 Chromium 154.0.8037.57 各通过 9/9 |

loop5 的历史 Playwright 失败轨迹位于 `/data/tmp/modal-p0-final-focused/`。轨迹中，旧测试调用 `setViewportSize` 后立即读取标题位置，到下一步 `hover` 时快照已经显示 `--dialog-viewport-height` 从 `760px` 更新为 `335px`，此时还未发送滚轮事件。移动端以该变量计算弹窗居中位置和面板最大高度，旧断言把视口变更引起的弹窗重新居中计入了滚动位移。同一组失败坐标曾在 loop5 出现，现有证据无法将问题归因于 loop2 或 Headless Shell 特有的滚动行为。

## 修改与断言

沿用共享 Dialog 的 Header、Body、Footer 结构，修改工单浏览器测试。测试在 390px 下等应用处理 VisualViewport 高度变化，确认标题和页脚已完整进入视口，再读取基准位置。接着直接对正文滚动容器执行即时滚动，要求实际滚动距离为正，并逐项精确比较标题和整个页脚的滚动前后边界框，继续检查提交按钮可见。若正文没有独立滚动，或标题、页脚随正文移动，测试仍会失败。原有焦点、键盘和关闭交互检查继续执行。

## 验证

- `npm run check` 通过，0 错误，有现存 lint 警告。
- `npm run build` 通过，有构建产物分块大小提示。
- `CI=1 npm test` 通过，67 个测试文件，576 项通过，4 项按仓库既有条件跳过的基准测试。
- 浏览器回归以本地 Vite 和模拟 API 运行。P0 覆盖 1440px、390px。
- P1 集成验证使用本机 `task/sub-modal-p1` 的 `24c63ec`，在独立副本中应用同一份测试补丁。Chromium Headless Shell 上 P0 + P1 共 18/18 通过，含 P1 在 1440px、1024px、390px 的全部 9 项。
- 截图位于 `development/screenshots/sub-modal-test-fix/`，其中 `ticket-dialog-scrolled-1440.png`、`ticket-dialog-scrolled-390.png` 展示短视口滚动后的工单窗口。
- 双机验收仍缺 loop2 的修复后实测。交付 bundle 放在 `/data/tmp/sub-modal-test-fix.bundle`。

SUB_MODAL_TEST_FIX_DONE
