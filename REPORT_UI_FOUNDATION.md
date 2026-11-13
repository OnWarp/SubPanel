# REPORT — UI 升级·线 A：设计令牌 + 通用组件

基线 3a0fde0，分支 task/ui-foundation-sub。范围：令牌层、共享组件、AppShell；未重写业务页面、未改文案与业务逻辑。

验证：npm run check 0 警告 0 错误；npm test 50 套件 / 374 条全过（含 smoke）；npm run build 全绿。

## 1. 令牌清单（src/styles/tokens.css 整表重写，变量名兼容旧调用）

颜色（双主题同构）：

| 角色 | 浅色（Apple 路线） | 深色（Linear 路线） |
| --- | --- | --- |
| --color-canvas | #f5f5f7 | #08090a |
| --color-surface（表面 1） | #ffffff | #0f1011 |
| --color-surface-subtle | #e9e9ee | #141516 |
| --color-surface-raised（表面 2） | #ffffff | #191a1b |
| --color-text / muted / faint | #1d1d1f / #6e6e73 / #86868b | #f7f8f8 / #8a8f98 / #62666d |
| --color-border（发丝线） | rgb(0 0 0 / 0.08) | rgb(255 255 255 / 0.08) |
| --color-border-strong | rgb(0 0 0 / 0.16) | rgb(255 255 255 / 0.16) |
| --color-primary（主按钮底） | #0071e3 | #5e6ad2 |
| --color-accent（焦点/选中/链接） | 同 primary | #7170ff |
| --color-success / warning / danger | #008a2e / #b26a00 / #d70015 | #4cb782 / #e5a13d / #f2555a |
| --color-info | 并入强调色系 #0071e3 | 并入强调色系 #7170ff |

新增别名：--color-surface-1 / --color-surface-2、--color-accent、--color-accent-text、--shadow-focus（2px 强调色焦点环）、--font-display（28px）、--leading-tight、--weight-regular/medium/semibold/strong（400/510/590/600）、--radius-pill、--size-sidebar-collapsed、--ease-out、--space-7。

- 字体栈换为方案 §3.2（-apple-system 起头，不引第三方字体文件）；--font-title 26 → 20；html 基础字号改走 --font-body（13px）。
- 间距按 4px 阶梯重排：--space-1..7 = 4/8/12/16/24/32/48（旧 space-2..6 数值整体上移一档，页面留白略增，属令牌映射的预期效果）。
- 圆角收敛：--radius-ctl/field 6、--radius-card 8、--radius-card-lg（弹窗/抽屉）12、--radius-dock/sheet 12、pill 999；旧名 --radius-control/--radius-panel 继续映射。
- 尺寸：--size-sidebar 224 → 216、--size-topbar 56 → 48、--size-content-max 1360 → 1080。
- 阴影：浅色 --shadow-float 换 Apple 参数（3px 5px 30px / 0.22）；深色置 none，浮层靠表面亮度差 + 发丝边框区分。
- 动效：--duration-ui 200 → 160ms；--ease-spring 改为 ease-out 曲线（同名兼容，消除过冲弹跳）；删除 workspace-enter 入场动画。

## 2. 组件清单

改（样式/行为，接口不变）：

- 按钮四级（app.css .button）：主按钮 pill + 强调底、高 32、内边距加宽；次按钮改透明底 + 发丝边框；新增 .button.ghost（无底无框、hover 显底）；.button.danger 改为描边 + 危险字（方案 §5.1），实心危险改新类 .button.danger-fill；禁用态统一 opacity .4 + not-allowed；按下 scale .98；字重 650 → 590 令牌。
- 图标按钮 .icon-button：34px 描边方钮 → 24px 无边框幽灵钮（hover 显底），移动端媒体查询仍放大到 44px 触控区；.sp-dialog-close 同步。
- 输入框（:where 兜底组 + .sp-search + Select）：边框改发丝线，聚焦改强调色边 + --shadow-focus 焦点环；搜索框高 40 → 36 与字段对齐、底色改表面色。
- FormField：标签改 12px 次文字 + 590（去全大写与宽字距）；错误文案改纯危险色；字段内出现错误时控件自动红边框（:has 规则）。
- 开关：见下「新」。
- Select：触发器边框改发丝线、字重 590、聚焦环；菜单圆角改 8、阴影走 --shadow-float；选中项改强调色 + 590。
- StatusBadge：36px 大胶囊 → 20px pill / 11px / 590，彩色描边删除，底色走低饱和 soft 令牌（soft 混合比已在令牌层下调）。
- Toast：桌面改右下、移动改底部居中（在 dock 上方）；圆角 12；入场 160ms ease-out 淡入；时长 note 3400 → 2500ms、error 8000 → 5000ms。
- Dialog / ConfirmDialog / EditDrawer：圆角统一 12（--radius-card-lg）；ConfirmDialog 取消按钮改幽灵级、危险确认改 danger-fill（顺序仍为取消在左、主按钮最右，符合 §5.2）。
- EmptyState：虚线强边框改发丝实线；ErrorState 动作钮配色改纯危险色。
- DataTable / 全局 table：行高 42 → 44，表头字重 750 → 590，行 hover 改表面灰（去强调色染）。
- FilterChip：字重 650 → 590。

新（src/ui，按现有 sp- 规范，已通过 tsc/oxlint，尚未被业务页引用，B/C 线迁移时使用）：

- Button.tsx：四级 variant + loading（内置 .sp-spinner 转圈、文字不变、aria-busy）。
- CopyButton.tsx：复制 + 原地变「已复制」1.5 秒（§5.3），支持 iconOnly 幽灵图标形态，复用 app/clipboard。
- Switch.tsx：pill 开关（28×16，移动 32×20），DOM 与页面现行 sys-switch 同构（checkbox + role=switch + track/thumb），开 = 强调色；按 §3.3 开关无过渡动画。
- SegmentedControl.tsx：分段控制（灰底胶囊、选中段表面色浮起、aria-pressed，即时切换）。

## 3. AppShell（src/app/AppShell.tsx + app.css 外壳段）

- 侧栏 216（令牌），新增收起态 56 纯图标：顶栏左加收起/展开图标按钮，状态存 localStorage（subpanel:sidebar-collapsed），收起时隐藏分区标签、链接文字与账户文字，导航链接带 title 提示；移动端隐藏该按钮，底部 dock 结构未动（管理 概览/分组/用户/更多、用户 首页/节点/订阅/更多）。
- 顶栏 48（令牌）+ 毛玻璃改 saturate(180%) blur(20px)、底色 canvas 72% 透明。
- 内容区最大宽 1080（令牌），内边距 24 起；导航链接字号 14 → 13、字重改 510/590；品牌与标题字重封顶 600。

## 4. 接口变更点

- 组件 props 接口零变更（Dialog/ConfirmDialog/EditDrawer/Select/StatusBadge/Toast/FormField 等签名未动）。
- 样式类语义变更（调用方代码不用改，视觉按方案变）：.button.danger 由实心红变描边危险字——现有用处 9 个文件（AdminSharesPage、AccountPage、UsersPage、GroupsPage、AppsPage、SourcesPage、DomainSettingsSection、ShareDrawer、MinePage）及 BatchToolbar 动态拼装处，这些都是非确认场景，符合 §5.1；实心危险只剩 ConfirmDialog（已改用 danger-fill）。
- Toast 时长为行为变更（见上），API 不变。
- 令牌数值变更即全站换肤：凡已走变量/共享组件的页面自动生效；--color-info 与 primary 同色后，旧的 info 蓝条样式（link-strip/token-strip/source-preview）已在 app.css 改为中性表面 + 发丝边框（顺带去掉左彩条与整圈彩边框，符合 §3.3 禁左彩条）。

## 5. 私写样式页面登记（给 B/C 线，本线未动 pages-*.css 与业务页）

普查口径：对 src/styles/pages-*.css 与业务页统计字面量与私有实现，颜色字面量几乎为零（hex 0 处、rgb 2 处），债务集中在字重、圆角与私有组件实现：

- 私有开关三套（结构与新 Switch 同构，可直接迁移）：pages-system.css 的 .sys-switch（SystemPage/DomainSettingsSection/ShareSettingsSection）、pages-adminshares.css 的 .ashr-switch、pages-shares.css 的 .sh-switch（ShareDrawer）；另 SubscriptionsPage/NodesPage/SourcesPage 仍用原生 checkbox 的 .toggle-field。
- 私有复制反馈六处（各自维护 copied 状态，可迁 CopyButton）：HomePage、MySubscriptionsPage、SubscriptionsPage、UsersPage、SharePage、ShareDrawer。
- 字重 ≥700 残留（处）：pages-apps 7、pages-nav 7、pages-shares 4、pages-expiry 3、pages-admin 2、pages-delivery 2、pages-adminshares 1、pages-users 1。
- 圆角字面量（处）：pages-apps 4、pages-adminshares 3、pages-nav 3、pages-shares 3、pages-catalog 2、pages-system 2、pages-delivery 1、pages-users 1。
- box-shadow 字面量（处）：pages-apps 1、pages-adminshares 1、pages-catalog 1、pages-nav 1、pages-system 1。
- 内容最大宽 1080 已全站生效；管理页「满宽表格」豁免需要页面级修饰类（如 content-wide），逐页归 B/C 线处理。

## 6. 与方案的偏差

- Toast 错误时长取 5000ms（§4.2 结果提示 2 秒针对成功类；错误信息需读完，note 类已按 2500ms 执行）。
- 字重 510/590 在系统字体栈下由浏览器就近取整（SF/Inter 可变字体环境精确，其余环境约落 500/600），令牌值按方案保留。
- 深色浮层阴影置 none 后，菜单/弹窗靠 raised 表面（#191a1b 对 #0f1011）+ 发丝边框区分，与 Linear 路线一致。
- .sp-badge 保留了状态圆点元素（组件既有视觉标识，方案未明令删除）。
