# SubPanel Design System V2 · P3 交付报告

分支 `task/design-v2-p3`，指定基线 `b76b53745e4bdffb80f3d9f6e43b7ce053e4e462`，提交身份 Muse <muse@outtw.com>。交付以简报指定的 SHA 为准

## 实现与差异文件

| 文件 | 差异 |
| --- | --- |
| `src/features/user/HomePage.tsx` | 首页只保留一个标题「首页」和一个主操作「打开订阅」。状态与分组/节点在前；接口给出 `expiresAt` 时显示「有效期剩余 N 天」。已有订阅时提供「导入客户端」。公告与快捷入口后置。无订阅时不渲染导入入口 |
| `src/features/delivery/MySubscriptionsPage.tsx` | 用户订阅页把到期状态、订阅链接、复制与「导入到客户端」放在前面。复制是唯一强调操作，分享改为次要。平台链接、订阅计划、兼容诊断和重置令牌按使用频率后置。关闭重置确认后焦点回到「重置订阅令牌」 |
| `src/features/user/MyNodesPage.tsx` | 节点页只保留标题「我的节点」。搜索与按订阅筛选常显，按分组筛选收进「更多筛选」，筛选生效时提供「重置筛选」。无有效订阅时仍有标题，并给出「去订阅」 |
| `src/features/user/MinePage.tsx` | 个人中心去掉重复的账号说明，保留标题「个人中心」与「管理订阅」。账户信息、通知、显示设置和帮助与支持的顺序不变 |
| `src/app/AppShell.tsx` | 用户账号菜单按现行菜单行呈现：图标、个人中心、我的订阅、安全与通知设置、外观、退出登录。外观使用独立的 `user-account-theme`。布局切换、偏好键和移动顶栏主题入口未改 |
| `src/styles/user-shell.css`、`src/styles/pages-user-d.css` | 用户页标题改用页面标题令牌。数据区改为平面细线。菜单、登录面板和用户侧弹窗使用 12px 容器圆角，控件使用 6px。窄屏触控高度至少 44px。768–1199px 隐藏节点表「所属订阅」列。管理端布局选择器不受这些规则影响 |
| `development/test-design-v2-p3.mjs`、`development/screenshots/design-v2-p3/` | 用户主路由的浏览器回归与 12 张截图 |
| `REPORT_DESIGN_V2_P3.md` | 本报告 |

## 影响路由与范围

- `/home`、`/subscriptions`、`/nodes`、`/me`、`/account` 对齐用户中心契约。`/account` 仍进入个人中心
- 已登录用户的账号菜单覆盖全部用户壳层页面。主导航仍是首页、订阅、节点、我的
- 登录与注册只调整 `.upd-auth` 面板圆角，文案和结构未改
- 非管理布局中的确认框、编辑抽屉、重置框和 `.sp-dialog` 面板使用 12px 圆角。窄屏编辑抽屉保留上圆角、下贴底
- `src/app/api.ts` 与 `public/_headers` 和基线字节一致。业务 API、D1、订阅链接、权限、cron 与到期提醒调度沿用基线

## 验收

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误。Wrangler 类型已是最新，oxlint 334 个文件 0 警告 |
| `npm run build` | 通过，有 Vite 产物超过 500 kB 的提示 |
| `npm test` | 58 个 Worker 测试文件，514 项通过 |
| `vitest-pages-node.config.ts` | 15 个文件，227 项通过 |
| `vitest.controls.config.ts` | 7 个文件，33 项通过 |
| `vitest-subscriptions-node.config.ts` | 3 个文件，14 项通过 |
| `vitest.templates.config.ts` | 5 个文件，93 项通过 |
| `node development/test-mobile-bar-inset.mjs` | 通过 |
| `node development/test-layout-switch-split.mjs` | 通过 |
| Chromium | 320、390、768、1440 验证单一标题、导入顺序、无横向溢出和无控件裁切。另验证复制按钮键盘焦点、重置确认与账号菜单的 Esc 关闭和焦点恢复、节点筛选重置、768px 列隐藏、加载、空、失败和无订阅门禁 |

截图与浏览器交互使用固定演示数据拦截 API 响应，Worker 测试独立运行。复现时启动 `npm run dev -- --host 127.0.0.1 --port 4182`，再运行 `node development/test-design-v2-p3.mjs`。移动底栏与布局切换脚本默认也使用该地址

| 视口 | 主题 | 首页 | 订阅 | 节点 | 我的 |
| --- | --- | --- | --- | --- | --- |
| 1440 × 900 | 浅色 | [首页](development/screenshots/design-v2-p3/home-1440-light.png) | [订阅](development/screenshots/design-v2-p3/subscriptions-1440-light.png) | [节点](development/screenshots/design-v2-p3/nodes-1440-light.png) | [我的](development/screenshots/design-v2-p3/me-1440-light.png) |
| 390 × 844 | 浅色 | [首页](development/screenshots/design-v2-p3/home-390-light.png) | [订阅](development/screenshots/design-v2-p3/subscriptions-390-light.png) | [节点](development/screenshots/design-v2-p3/nodes-390-light.png) | [我的](development/screenshots/design-v2-p3/me-390-light.png) |
| 390 × 844 | 深色 | [首页](development/screenshots/design-v2-p3/home-390-dark.png) | [订阅](development/screenshots/design-v2-p3/subscriptions-390-dark.png) | [节点](development/screenshots/design-v2-p3/nodes-390-dark.png) | [我的](development/screenshots/design-v2-p3/me-390-dark.png) |

## 未做项

- 账户接口提供套餐流量额度 `trafficGb` 和 `expiresAt`，没有已用流量或剩余流量。首页只在存在到期时间时显示剩余有效期
- 公告、知识库、工单和客户端下载仍使用各自页面文件中的原有标题说明与卡片。这些文件不在本线范围内
- 个人中心里的安全表单来自既有账户页，主按钮数量沿用该页
- `src/features/user/SubscriptionReset.tsx` 当前没有引用，保持原样
- `development/tests/browser/user-subscriptions.spec.ts` 仍按更早的订阅页文案断言。它不计入上述 vitest 套件
- 全局 `--radius-card` 与 `--radius-card-lg` 未改，管理端继续使用 16px 与 20px。DataTable、表单与抽屉组件、catalog、admin-resources、system、accounts、tickets、管理端 delivery、布局偏好键均未改

## 交付与回滚

交付文件为 `/data/tmp/design-v2-p3.bundle`，包含 `refs/heads/task/design-v2-p3`，前置提交为 `b76b5374`。回滚时撤销本线提交即可恢复界面，无需数据库或配置迁移

CODEX_DESIGN_V2_P3_DONE
