# 订阅快捷导入报告

## 改造前审计

基底为本机 `origin/main` 的 `7d5eb68`，分支 `task/sub-quick-import`。仓库提交身份已核对为 Muse / muse@outtw.com。

- 我的订阅 `/subscriptions`（含选中订阅的查询参数）在订阅卡内展示可切换的明文链接、复制、二维码及一个通用导入动作，下方重复展示逐格式明文链接和复制。用户页沿用订阅平台展示开关和排序。
- 交付管理 `/delivery/subscriptions` 的详情抽屉用格式选择器切换明文链接、复制及二维码，选择还驱动格式说明与生效模板预览。
- 公开分享 `/s/:token` 通过 `GET /api/shares/:token/export?type=link` 按次获取原始链接，成功时直接复制，复制失败才显示明文。各格式可复制 `/api/shares/:token/export?client=<client>`，原“打开”按钮使用浏览器会话下载配置文件。原始链接受所有者开关保护，成功导出会计入访问次数。受登录或密码保护的格式导出依赖浏览器会话。分享元数据未声明这些保护状态。
- 兑换页只复制已有主链接并跳转订阅管理。分享管理及分享抽屉复制的是 `/s/:token` 分享页面地址。以上入口未提供格式操作。
- 交付链接由 `worker/delivery/links.ts` 生成。自动识别使用 `/sub/:token`，各格式使用 `/sub/:token/<platform>`。内部通用渲染器 `generic` 未生成展示链接。

| 格式 | 交付 | 分享 | 仓库现有 scheme 与处理 |
| --- | --- | --- | --- |
| 自动识别 | 有 | 原始链接 | 无，保留主链接 |
| Mihomo、Clash、Clash Meta | 各有 | Mihomo（服务端支持别名） | `clash://install-config?url=` |
| Stash | 有 | — | `stash://install-config?url=` |
| Surge | 有 | 有 | `surge:///install-config?url=` |
| Loon | 有 | 有 | `loon://import?sub=` |
| Shadowrocket | 有 | 有 | `shadowrocket://add/sub://` 加 UTF-8 Base64 |
| sing-box、Karing | 各有 | sing-box | 无，保留格式链接复制 |
| Quantumult X、v2rayN、NekoBox | 各有 | 各有 | 无，保留格式链接复制 |
| v2rayNG | — | — | 当前无独立格式或 scheme |

除 Shadowrocket 外，现有 scheme 参数使用 `encodeURIComponent`。唯一现有 scheme 构造器为 `src/features/user/client-import.ts`。

## 实施

- 我的订阅保留原卡片里的明文主链接、复制和二维码，沿用 `pickPrimaryLink` 以及管理员设置的平台可见性。平台区显示导入动作，原格式能力与说明可在兼容诊断中查看。
- 管理详情抽屉的主链接优先使用接口返回的自动识别地址，其次使用默认客户端或首个已有地址。格式二维码、能力说明及生效模板仍可通过折叠区的格式查看器访问。
- 分享保留原始链接授权和访问计数。首次点击复制通过现有接口获取原始链接并展示明文，随后可直接复制已获授权的同一地址。页面初始化仅获取原有元数据，避免预先消耗访问次数。配置导入使用既有分享导出 URL。需要浏览器会话的分享可在「更多导入方式 → 下载配置」下载后交给客户端。
- 复用 AppShell 中的共享 `PageFrame`、公开分享的共享 `AuthLayout`、管理抽屉的 `EditDrawer`，以及共享 `Button`、现有锚点按钮样式、`CopyButton`、`Select`、状态提示和折叠样式。三处复用 `SubscriptionImports` 动作组件。
- 交付及分享 URL 生成、旧链接和令牌、授权判断、到期逻辑、渲染器及转换器沿用现有实现。本次无迁移。

## 设备展示

设备判断只读取浏览器的 UA 和触点数，无服务端指纹或设备存储。按现有平台排序显示当前页有链接且匹配下表的按钮，其余格式折叠到「更多导入方式」。折叠区中的快捷导入提供跨设备复制图标，无 scheme 的格式只显示复制动作。

| 设备 | 优先展示 |
| --- | --- |
| iOS / iPadOS | Stash、Surge、Loon、Shadowrocket |
| Android | Mihomo、Clash、Clash Meta |
| Windows | Mihomo、Clash、Clash Meta |
| macOS | Mihomo、Clash、Clash Meta、Stash、Surge |
| Linux | Mihomo、Clash、Clash Meta |
| 未识别 | Mihomo、Clash、Shadowrocket |

iPhone、iPad、iPod 标识以及带多点触控的 Macintosh UA 归入 iOS，先识别 Android 再识别 Linux。按钮直接打开现有 scheme。点击后若 1.6 秒时页面仍可见且有焦点，显示「未检测到该应用，请先安装」。浏览器的可见性和焦点是近似信号，系统选择器及浏览器拦截行为有差异。真实应用的安装状态和导入结果未在本地浏览器验证。

## 文件与回归

- `src/features/delivery/MySubscriptionsPage.tsx`、`SubscriptionDetailRows.tsx`、`SubscriptionsPage.tsx` 和 `src/features/shares/SharePage.tsx` 接入导入动作和主链接。
- `src/features/delivery/SubscriptionImports.tsx`、`src/features/user/client-import.ts`、`src/styles/app.css` 和 `src/styles/pages-delivery.css` 提供共享动作、设备排序、提示与链接换行。
- `development/tests/worker/client-import.test.ts` 新增 16 项编码和设备规则单测。更新 `development/tests/browser/{admin-frontend,user-subscriptions}.spec.ts`、`development/tests/ui/user-pages-style.test.tsx` 和 `development/test-ui-content.mjs` 中受界面变动影响的断言。
- `npm run check` 通过，0 错误、77 条 lint 警告。预置依赖链接指向旧版本 Wrangler，改用锁文件安装到本机独立目录的依赖。
- `npm run build` 通过。主客户端包 723.49 KB，gzip 206.97 KB，有 Vite 包大小提示。
- `CI=1 npm test` 通过，67 个测试文件，575 通过、4 个按环境变量关闭的现有性能测试跳过，0 失败。补充 UI Vitest 6 项通过。
- `development/test-sub-quick-import.mjs` 使用拦截的本地 API 与虚构数据，在 1440、1024、390 px 比对三处界面，验证 54 次导入点击的 scheme 目标、18 次复制、9 处布局宽度与缺应用提示。分享另验证原始链接拒绝时不会展示明文，配置下载仍可用。截图共 18 张，位于 `development/screenshots/sub-quick-import/`，目录约 928 KB。
- 补充的旧版 `development/test-ui-content.mjs` 在节点页等待「需要有效订阅才能查看节点」超时，尚未进入订阅页。在独立目录从 `7d5eb68` 构建并运行，复现同一超时。此处以专项浏览器回归覆盖订阅动作，未运行全套旧版 Playwright 场景。

## 风险与回滚

原生客户端必须注册相应 scheme。受密码或登录保护的分享在原生客户端中可能无法携带浏览器会话，可使用浏览器下载的配置。发布后如需回滚，在集成分支对本次快捷导入提交执行 `git revert <commit>`，按常规流程重新构建前端。无需恢复数据库或重新生成订阅链接。本次所有运行使用本地测试与构建，未推送、未部署、未访问生产 D1。

SUB_QUICK_IMPORT_DONE
