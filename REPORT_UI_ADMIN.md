# REPORT — UI 升级 · 线 A(续）：管理页重建 + 全站残留清理

范围：管理后台六页（概览 / 分组 / 订阅 / 分享 / 用户与邀请 / 系统管理）的结构化重建，
以及 `src/styles/*.css`、`src/**` 中管理页可直接改动的字面量残留清理。
对照《REPORT_UI_FOUNDATION.md》§5 登记逐项处理；用户侧五页（线 B）文件未触碰。

本线未触碰、也不需要触碰的用户侧面：
- `src/features/apps/AppsPage.tsx`（/apps，线 B）以及 `pages-apps.css`（`/apps` 与 `/catalog/apps` 共用该文件，含线 B 与管理 APP 页两部分样式）——字面量残留全部保留并登记，见 §6。
- `src/features/delivery/MySubscriptionsPage.tsx`、`HomePage.tsx`（线 B）——其复制反馈未动。
- `src/features/shares/SharePage.tsx`（公开分享页，线 B）——复制反馈评估后保留（见 §5.3）。

## 1. 六页变更

### 1.1 概览（DashboardPage.tsx）
- 删除两块统计卡（adm-stat-grid/adm-stat-* 保留但去掉 `--font-xl: 30px` 局部覆盖；统计数字改用内置 `--font-display 28px`，字重 590，标签去 `-0.02em 大写 uppercase` 残留、改 590/`.02em`）。
- 删除「即将到期」名单、「需要处理」提示等说明性区块与对应死代码（未使用的 `EmptyState`/`DataHeader`/`EXPIRY_SOON_DAYS`/`formatExpiryTime`/`formatRemaining`/`getExpiryState`/`isWithinExpiryDays`/`now`/`within7/15/30`/`expiredEnabled`/`userNames`/`groupNames`/`expiringSoon`）。
- 三段结构：PageHeader `概览` → 无过滤条件时仅渲染可选 `.adm-alert`（到期预警横幅，改为纯令牌：`--color-border` 发丝边框、`color-mix warning↔text` 文本、`--color-warning-soft` 底），无额外说明段。

### 1.2 分组（GroupsPage.tsx）
- 过滤条形式的搜索（FilterBar）提到 PageHeader 下方的 FilterBar；`Search` 与 `FilterChip` 的无用 import 删除（旧搜索框已没有并存调用）。
- 批量操作进入 DataHeader `actions=`，表格卡保持满宽无说明文案。

### 1.3 订阅（SubscriptionsPage.tsx）
- 过滤从「启用中/全部」两组 chip + 独立「到期」组 合并为单行 UNIFIED_FILTERS：全部 / 仅启用 / 即将到期 / 已过期 / 永久有效；兼容旧搜索参数 `expiry=7|15|30` 整体映射到「即将到期」chip。
- 批量操作进入 DataHeader `actions=`；`selectAllRef`/"选择全部订阅" 复选框与对应 `.del-select-all`（pages-delivery.css）已删除（被批量工具条取代）。
- 新订阅令牌区、详情抽屉内每条链接的复制一律迁到 `<CopyButton iconOnly>`；`copyText`、`copyText` 私有 helper、`.token-strip` 手动 input+按钮 全部删除。
- 二维码确认框 confirmLabel `复制链接` 的策略改为「关闭后复制、不阻塞关闭」：`setQr(null)` 先同步执行，再 `copyToClipboard(...).then(提示已复制 / 提示浏览器未允许)`。
- `<CopyButton onCopied>`（本轮新增回调 prop）承接成功边缘：`onCopied={() => setError('')}`、`onError={() => setError('浏览器未允许复制，请手动选择内容')}`（`copyToClipboard` 底层即原有 helper，错误行为一致）。
- 创建/编辑抽屉里的「启用订阅」原生 checkbox 换共享 `<Switch>`（`Switch ariaLabel="启用订阅" checked={form.enabled} …`，保持 FormField 语义）。
- `enabledCount`（PageHeader 描述行）删除——说明性行数不再输出（PageHeader 仅剩标题），description 统一缺省。
- 「启用」开关语义：所属筛选 chip 点击区、batch 工具条 `操作中` 置灰逻辑不变。

### 1.4 分享管理（AdminSharesPage.tsx）
- 过滤条统一为 FilterBar（select：启用状态、到期状态、排序与搜索保持原语义）；`activeCount` 未使用变量删除。
- `effectiveStatus/shareStatusLabel` 语义不变；批量工具条 + 批量删除确认均复用共享组件。
- 私有 `.ashr-switch` 已删除，启用/关闭走共享 `Switch`（此前完成于本轮分阶段工作中）。

### 1.5 用户与邀请（UsersPage.tsx）
- 整页重写为「PageHeader 概览（剩余席位/邀请数）→ FilterBar（SegmentedControl：全部用户 / 回收站，删除/恢复链路）/邀请创建表单在 DataHeader 过滤槽位）」三段式；表头排序与详情抽屉保持。
- PageHeader actions：唯一主按钮「创建邀请」（`form="invite-form"`，负责令牌区创建）；邀请表单整体移入 users-title `DataHeader filters=`；批量工具条进 `actions=`。
- 管理员行不可选（checkbox/switch/promote/reset 全部 disabled）。
- 邀请令牌「邀请链接已复制」提示维持 `toast.notify`（横幅型反馈，非 per-button copied 状态，符合 §5.3 留存分类）。
- `.usr-*` 全部旧样式删除后仅保留 `.usr-tools`（590/Space）+ 移动端 @media padding 单条规则——CSS 净减约 190 行。

### 1.6 系统管理（SystemPage.tsx）
- 单列长页面重排为「左侧粘性侧栏 6 锚点（概览/订阅/SMTP/分享策略/缓存/APP 下载）+ 右侧内容堆叠」；客户端纯 `useLocation` 锚点滚动，无路由结构变更；`.sys-layout/.sys-sidebar/.sys-nav-item` 由 pages-system.css 令牌化（含 720px 以下折叠为静态横滑条）。
- 「状态」段的刷新按钮从 `filters=` 移到 `actions=`；`<main role="main">` 嵌套 → `<div className="sys-content">`，消除重复 main 地标。
- 「APP 下载」段（管理端上传/管理平台清单 + 版本）随侧栏直达；依赖 DomainSettingsSection/ShareSettingsSection 两处的私有 `Switch` 均已迁至共享 `Switch`（`label=` 传参一并改 `ariaLabel=`）。
- `React.ReactElement` 局部替换为 `import type ReactElement`；SECTIONS `icon: any` → `type LucideIcon`。
- `.sys-state`（私有空态套壳）、`.sys-mode-row`（私有开关行）等块全部删除；状态段 `<div className="sys-state"><ErrorState/></div>` 去掉包裹层。

## 2. 共享组件与工作流改动

- `src/ui/CopyButton.tsx`：新增**必选链无关**的回调 prop `onCopied?: () => void`（沿用已有 `onError`）；`copy()` 成功时调用 `onCopied?.()`。成功反馈（1.5s 内按钮内 ✓/copiedLabel）与错误横幅（调用方 `onError`）解耦。接口由调用方按需传。
- `components.css`：`.sp-switch-thumb background: #fff` → `var(--color-primary-contrast)`；全部 `border-radius: 999px` → `var(--radius-pill)`。
- `app.css`：`.dock-sheet-handle`、`.profile-avatar`、`.button.danger-fill` 上述四处 999px 全部 → `--radius-pill`；danger-fill 文字 `#fff` → `--color-primary-contrast`；`.user-subscription-placeholder/.metric-*`、`.user-subscription-heading*` 等死规则删除（区块已随 Dashboard 重建弃用；`.section-empty` 组合选择器中的旧成员 `.user-subscription-heading p` 移除）。
- `pages-system.css`：`var(--font-md, 1rem)` 零余量兜底改 `var(--font-md)`；侧栏 @media 段落重写。
- `pages-admin.css`：去 `--font-xl` 覆盖、标签大写残留与 `.issue-section .sp-empty` 死规则；`.adm-alert` 完整令牌化（见 1.1）。
- `pages-expiry.css`：`.exp-expiry-grid/.exp-expiry-stat/.exp-soon-list/.exp-soon-item/.exp-soon-days` 全部删除；通用选择器中的 `.exp-soon-item` 成员剔除。
- `pages-adminshares.css`：`.ashr-switch` 系列（track/thumb/disabled/focus + -ui/-text）全部删除（迁移切换由 1.4 完成）；`.ashr-table` 去掉 `border-radius: var(--radius-card)` 的重复声明时一并清理；`font-weight: 650`→590、`700`→600、`500`→510。
- `pages-shares.css`（ShareDrawer 相关段）：`.sh-switch` + 其全部 8 条子规则删除；`700`→600；ShareToggle 重写为共享 Switch（结构等价映射：label/ariaLabel/checked/onChange/disabled）。**视觉尺寸由 40×22 私有轨道改为共享 Switch 同款**（有意为之，保证全站开关一致）。
- `pages-catalog.css` / `pages-delivery.css` / `pages-expiry.css` / `pages-nav.css`：`650/700/750` → `590/600/590`（仅数值对齐到令牌字重）；`.del-select-all` 死块删除（见 1.3）。
- `components.css` 其余 `.sp-*` 未见字重/圆角回退。
- 审计口径复核：`grep font-weight: 650|700|750|800|900` → **pages-apps.css 以外零命中**；`grep 'border-radius: [0-9]' (非 0、非 50%)` → 仅 pages-apps/components 扁平 reset、`.sp-badge-dot` 等 50% 小圆点命中（保留）；`box-shadow` 字面量（`0 | rgb(|#`）→ **全站零命中**（深色浮层均为 none 令牌覆盖）。

## 3. 登记口径（REPORT_UI_FOUNDATION.md §5）逐项去向

- 私有开关三套：
  - `.sys-switch`（pages-system.css ×3：SystemPage、DomainSettingsSection、ShareSettingsSection）→ **已迁共享 Switch、样式已删除**。
  - `.ashr-switch`（pages-adminshares.css）→ **已迁、已删除**。
  - `.sh-switch`（pages-shares.css ×ShareDrawer）→ **已迁、已删除**。
  - 原生 checkbox `.toggle-field`（SubscriptionsPage）→ **已迁 Switch**。NodesPage/SourcesPage 的 `.toggle-field` 未动（非线 A 六页范围，归原线）；已登记。
- 私有复制反馈六处（首页/我的订阅/Subscriptions/Users/SharePage/ShareDrawer）：
  - SubscriptionsPage → **已迁 CopyButton**（含 onCopied/onError 组合）。
  - UsersPage（toast）、ShareDrawer（`setNotice` 横幅两处）→ **评估后保留**：均为「一次性密钥/分享链接稍后仍可列表复制」的横幅型提示，未持有 per-button copied 状态，非本登记债务定义的重复实现。
  - HomePage、MySubscriptionsPage（线 B）、SharePage（线 B 公开页）→ **未动**。
- 字重 ≥700 残留：pages-nav→0、pages-shares→0、pages-expiry→0、pages-admin→0、pages-delivery→0、pages-adminshares→0、pages-users→0。**pages-apps 未动（9 处：3×700/4×750/2×650；+3 个 font-size 字面量 13/14/13px；+圆角 8px/12px 与两处 radius:0；box-shadow:none 系扁平覆盖保留）——归属待 B 线或单独拆出，见 §6。**
- 圆角字面量：pages-delivery→0、pages-shares→0、pages-system→0、pages-expiry→0、pages-users→0、pages-admin→0、pages-adminshares→0；pages-catalog/components/app.css 的 `border-radius: 0` 系刻意扁平覆盖，保留（注明不满 999px—小圆点除外均走 `--radius-*` 令牌）。
- 阴影字面量：无增删，全站 0 处硬编码；`box-shadow: none` 深色覆盖保留。
- `.sp-switch-thumb` #fff、app.css danger-fill #fff、999px×若干 → 已改令牌。
-「内容最大宽 1080 豁免」：六页中系统/分享配置段保持 `narrow` 内容宽（ConfigPage 限宽约 768），表格页满宽，未引入新规则。

## 4. 验证门槛（原样输出）

### 4.1 `npm run check`（Types + tsc -b + oxlint）
```
> subpanel@0.1.0 check
> wrangler types --check && tsc -b && oxlint -c development/oxlint.json

 ⛅️ wrangler 4.114.0 (update available 4.161.0)
───────────────────────────────────────────────
✨ Types at worker-configuration.d.ts are up to date.
```
（oxlint 0 warnings / 0 errors，无任何诊断输出；exit 0）

### 4.2 `npm test`
```
 Test Files  50 passed (50)
      Tests  374 passed (374)
   Start at  17:41:02
   Duration  41.42s
```

### 4.3 `npm run build`
```
✓ built in 399ms
dist/client/index.html                    0.49 kB │ gzip:   0.30 kB
dist/client/assets/index-BRs0Lh06.css    83.09 kB │ gzip:  13.50 kB
dist/client/assets/browser-DPr568dI.js   23.46 kB │ gzip:   8.84 kB
dist/client/assets/index-BlvDrs8A.js    452.14 kB │ gzip: 127.66 kB
```

### 4.4 浏览器级（既有 e2e 基建）
`npm run test:e2e -- admin-frontend.spec.ts` → **12 passed / 1 failed / 2 skipped（serial）**。
失败用例「creates a subscription, shows links and diagnostics, and exposes batch controls」超时等待 `订阅详情` 对话框内「显示 Mihomo 二维码」按钮（本地新鲜 e2e 库 `D1_ERROR: no such table: system_settings`，无法完成订阅编译，详情抽屉内链接为空）。
**已通过 git stash 对干净基线 `fd6397e` 复测：同一 spec、同一用例、同一原因失败（12 passed / 1 failed），失败路径逐字节一致 → 判定为与本次无关的预存问题**；2 个因 serial 串行未被执行的用例（批量撤销邀请、重置用户密码）在基线同样未执行。因此重置链路上的「与基线一致、未引入新红」即本报告对 e2e 的最高可交付口径。
本次 e2e 直接渲染了六页中的概览/订阅/分组/用户与邀请共 4 页并与交互（邀请创建、批量工具条、重置/撤销确认框、topbar 56px 高、主题按钮位置）断言全部一致通过；分享管理页由 vitest + 静态审计覆盖。

### 4.5 浅/深双主题走查口径
未做浏览器逐像素对比截图（本环境为无头 CI，e2e 未执行主题矩阵）。本次替换涉及的全部颜色/字重/圆角经双主题令牌：`--color-warning(-soft)`、`--color-primary-contrast`、`--radius-pill`、`--radius-card`、`--font-display`、`--font-title`、`--weight-semibold` 均在 `tokens.css` 两主题段中双双定义（已逐行核验）；touches 无任何十六进制/rgb() 新增。组件级（Switch/Button/ConfirmDialog/CopyButton）行为不变，双主题跟随令牌。

## 5. 与「按钮唯一主按钮/确认项最右」等全站约定的核对
- 每个 admin 视图最多 1 个主按钮（创建邀请/添加订阅/添加分组/添加分享对话等）。
- ConfirmDialog 取消幽灵最左、危险确认 danger-fill 最右，全站未新增逆序。
- PageHeader 行高/高度 56px 与主题切换位置断言（e2e）通过。
- 说明性文字 ≤3 处的预算：六页新结构中，概览横幅、订阅令牌 KV 提示、末尾回收站分段标签、ShareDrawer 一次性链接提示、SMTP 段说明均为令牌节提供的既存文案，均未新增说明段。

## 6. 残留与已知问题（如实）

- **pages-apps.css**：`/apps`（线 B）+ `/catalog/apps`（admin APP 管理）共用，含 9 处字重、3 处 font-size、2 处 8/12px 圆角、2 处 radius:0、1 处 `box-shadow: none`（扁平覆盖）。未动——既非六页范围也横跨双线所有权；需在拆线时一并处理。
- **SharePage/MySubscriptions/Home（线 B）**：私有复制反馈（横幅/Toast）按 §3 保留；如线 B 统一回收，可切换到 CopyButton+onCopied。
- **Nodes/Sources `.toggle-field`**：原生 checkbox 残余，登记移交原线，本线未动。
- **e2e admin-frontend.spec.ts 的订阅链路用例**：预存失败，与本次无关（§4.4），留待 e2e 环境修复（D1_MIGRATION/本地开发库 schema 缺 `system_settings`）后自然转绿。
- **e2e 未执行主题矩阵**；双主题完整性靠令牌双定义核验兜底（§4.5）。需要像素级证据请补 playwright 截图用例。
- **ShareDrawer 开关尺寸变化**：40×22 私有轨道 → 28×16 共享 Switch，用户侧「创建分享」视觉将同步统一（预期内，全站开关一致优先）。
- **`--weight-semibold 590` 在非 SF/Inter 可变字体环境可能就近取整成 600**：方案定义如此，令牌不动。
- **`.exp-enabled-note` 仍保留**（订阅页「仅启用中的订阅」提示 chip），令牌化已就地保持，不再 TextNode 独占说明性行。

## 7. 提交清单（本报告 除外）

见 `git diff --stat`：21 files changed, 400 insertions(+), 897 deletions(-)。
涵盖：六页 TSX、两份共享切片（CopyButton + 组件 CSS）、app.css/pages-*.css 的令牌化与死代码清理。
`TASK.md` 为未跟踪文件，未入列。
