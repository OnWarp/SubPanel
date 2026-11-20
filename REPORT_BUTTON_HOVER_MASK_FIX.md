# 按钮悬停遮罩修复报告

基线：`59466921`（权益×订阅合并已上线）。分支：`task/button-hover-mask`。

## 复现方式

loop2 上 Playwright 复现（loop5 的排查报告只作候选清单，未复用其结论；
loop5 当时 Vite dev / Chromium 都被沙箱拦住，没有复现证据）。

- 复现用例：`development/tests/browser/button-hover-mask.spec.ts`（随分支提交，
  `node development/test-e2e.mjs button-hover-mask.spec.ts` 运行）
  - 桌面审计：1280×800，登录管理员后逐页访问 13 个管理端路由（概览、节点、
    来源、分组、订阅管理、分享、计划、用户、注册、订阅分发、审计日志、工单、
    知识库），对每个可见 `.button` / `.icon-button` 做 hover，用
    `elementFromPoint` 检查 hover 时是否有别的元素盖在按钮上，并记录
    `::before` / `::after` 的 content 与背景、hover 前后计算背景色，文字按钮
    另存 hover 前／中截图。
  - 触摸残留：390×844 触屏上下文点按底部导航链接；1280×800 触屏上下文点按
    侧栏收起按钮（不跳转，可观察残留）；断言用**计算背景色**而非
    `matches(':hover')`（见下）。
- 最小探针：独立 Chromium 页，只放一条 `.b:hover { background: #e9e9ee }`
  规则，触屏点按后逐时记录 `:hover` / `:active` / `:focus` 匹配与计算背景色。

## 根因

**没有哪条规则在按钮文字上盖了一层元素。** 桌面审计 29 个按钮、13 个路由：
`elementFromPoint` 在 hover 时始终命中按钮本身或其子元素，`::before` /
`::after` 均无内容与背景，hover 前后只有背景色变化——所谓“蒙层”就是
hover 背景本身：透明底色的按钮（ghost / secondary / icon-button）在 hover
时突然变成一块实色圆角底（浅色 `#e9e9ee`、深色 `#141516`），视觉上像一层
灰膜盖在按钮上。

真正的 bug 在触摸端，且探针已钉死：

- 触屏点按后，按钮的 `:hover` 匹配是 false，但**计算背景色一直停留在
  hover 色**（`#e9e9ee`），0 / 100 / 400 / 1500 ms 后都不变；点按页面
  别处后才恢复透明。原因是触屏点按会让元素进入持续的 hover 着色状态
  （同时获得 `:focus`），直到下一次点按。
- 全部 50 处 `:hover` 规则（12 个文件）都没有输入能力判断，所以触屏上
  每次点按都会留下这块 hover 底色——点过的按钮一个个留灰，就是反馈里
  的“触摸点完残留”。

一个坑：`matches(':hover')` 在触屏点按后返回 false，所以按它断言会得到
“无残留”的假阴性——本分支的触摸用例改断言计算背景色，桌面审计的
`covered` 断言不受影响。

## 修法

把全部 45 条含 `:hover` 的规则（50 处出现，分组选择器合并计）包进
`@media (hover: hover) { ... }`，共 12 个文件：

`admin-navigation.css`、`app.css`、`components.css`、`pages-admin.css`、
`pages-admin-ops.css`、`pages-apps.css`、`pages-kb.css`、`pages-nav.css`、
`pages-shares.css`、`pages-tickets.css`、`pages-users.css`、`user-shell.css`

只改样式：规则本身（选择器、声明）一字未动，桌面 hover 反馈保持原样
（仍是轻微变底色）；`:active` 的按压缩放与 `:focus-visible` 描边不受影响，
触屏点按仍有按压反馈。实现用 PostCSS 脚本逐条包裹（含一条已在
`@media (max-width: …)` 内的表格行 hover，改为嵌套媒体查询），脚本已删，
改动见 `git diff`。

桌面与触屏之外的注意点：混合输入设备（触屏笔记本）上 `hover: hover`
为真，hover 仍生效，符合标准行为。

## 验证

loop2 实跑（基线 59466921；后变基到最新 main 见下）：

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错 |
| `npm run build` | 通过（仅既有 chunk 体积警告） |
| Worker 全量 Vitest | 511/511 |
| 页面测试 | 189/189 |
| Playwright `button-hover-mask.spec.ts`（无头） | 3/3 |

- 触摸修复验证：点按后计算背景色保持透明（修复前停留在 `#e9e9ee`），
  点按别处后同样透明；底部导航点按后无残留。
- 桌面 hover 保留验证：**无头 Chromium 的 `(hover: hover)` 恒为 false**
  （无真实指针设备），所以无头跑桌面审计时 hover 不生效、背景不变——
  这是环境假象，不是回归。已在 xvfb 下有头 Chromium 复跑桌面审计：
  29 个按钮、13 个路由，`covered: 0`，25 个按钮 hover 时背景色仍正常变化，
  与修复前一致。
- 截图与审计 JSON：`development/screenshots/button-hover-mask/`
  （`desktop-audit.json`、hover 前／中成对截图、`touch-toggle-tap.json`、
  `mobile-tap.json`）。

## 备注

- 本分支基于 59466921 建，提交前已变基到最新 main（分组线合并提交
  `49d24656`），无冲突；变基后门槛重跑全过。
- loop5 的旧 bundle（`f9bbb33`，仅含排查报告）未复用；loop5 未动；
  loop2 的集成目录未动。
