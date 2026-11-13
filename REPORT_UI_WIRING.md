# REPORT — UI 收尾线 D：功能接线审计 + 页面铺满 + 全站自查

基线 403774a，分支 task/ui-wiring-sub。验证：`npm run check` 0 警告 0 错误；全量测试 50 套件 / 374 条全过（含 smoke，无回退）；`npm run build` 全绿。

## 一、铺满修复（逐页清单）

先定位每个 cap 的来源再改：内容区本身是令牌 `--size-content-max: 1080px` 居中（方案 §6 定版，不动），问题都在内容区内部的二次 cap。

| 页面 | cap 来源 | 改动 |
| --- | --- | --- |
| 个人中心 /account | app.css `.security-section { max-width: 680px }` | 删除 cap，三个分区（修改密码 / 邮箱 / 会话与安全）撑满内容区 |
| 个人中心 /account | app.css `.security-form { max-width: 460px }`（含 section 内变体） | 容器放开到边（分隔线、内边距随分区到边）；cap 下移到字段层 `.security-form > .sp-form-field { max-width: 460px }`，输入框保持合理宽度不拉满 |
| 我的 /me | pages-nav.css `.nav-home, .nav-mine { width: min(100%, 720px); margin-inline: auto }` | 删除 720 cap 与居中，分组列表整行铺满 |
| 首页 /home | 同上（与 .nav-mine 共用同一条规则） | 同步铺满，状态卡与链接区到边 |
| 我的节点 /nodes | pages-nav.css `.node-page { width: min(100%, 960px); margin-inline: auto }` | 删除 960 cap，表格页铺满（无设计注释说明，属同病） |
| 移动端全站 | app.css ≤760px `.workspace-content { padding: 14px 12px 96px }` | 内边距统一 16px：`padding: 16px 16px 96px`（底部 96 不变，给 dock 留位），卡片到边 |

其余查过的 cap 均为控件/组件级（搜索框 280–420、抽屉 620/720、弹窗 420、二维码 240、空状态描述 420），不是页面窄列，未动。两处特殊项见「存疑项」1 与 4。

## 二、接线补线（本次修复）

1. **注册邀请码管理补齐（最大断点）**：批次六的邀请码 API（`GET/POST/DELETE /api/admin/invitations`，multi 多次码 + batch 批量单次码、原子消费）上线以来前端零入口——管理员切到邀请注册后根本发不出码。新增 `src/features/system/InviteCodesSection.tsx`，挂在系统管理 → 账户与注册 → 邮箱域名白名单之后：列表（前缀、类型、已用/上限、过期、创建时间、已停用徽章）、生成表单（类型分段、次数/数量、过期时间）、生成后明文只显示一次并逐条 CopyButton + 复制全部、停用带确认弹窗。口径与白名单小节一致（sys-subsection 结构与样式复用，未新造页面）
2. **「我的」页 APP 下载入口对齐总开关**：MinePage 原先无条件显示 APP 下载行，与 AppShell / 首页在 `show_app_downloads` 关闭时隐藏入口的口径不一致；已接 `useDownloadsEnabled`，关时不显示（与侧栏/更多菜单一致）
3. **系统页 ↔ APP 管理互链**：系统管理 → APP 下载分区新增「前往 APP 管理」链接 → /catalog/apps（开关与平台配置原来互不可达）
4. **APP 管理 → 用户端预览**：/catalog/apps 标题行新增「查看用户端」次按钮 → /apps（路由本就允许已登录用户，管理员原来只能手输 URL 预览）

## 三、连带问题修复（A 线登记清单收尾）

- **原生开关三处换共享 Switch**（线 A 登记的「三页原生 checkbox」）：目录节点抽屉「启用节点 / 无来源时保留」、来源抽屉「启用来源」（原 `.toggle-field`）、APP 管理表单「启用」（原 `.app-flag`）。多选框（表格勾选、choice-row 多选列表）是复选语义不是开关，未动
- `.toggle-field` 的 TSX 使用已清零，CSS 规则与 `.check-cell`、`.choice-row` 共用一行，未单独删除

## 四、表 1：路由清单（路由 → 入口 → 状态）

| 路由 | 入口路径 | 状态 |
| --- | --- | --- |
| /dashboard 概览 | 管理侧栏「仪表盘」组 / 移动 dock | 原有 |
| /catalog/nodes 节点 | 管理侧栏 / 移动「更多」 | 原有 |
| /catalog/sources 来源 | 管理侧栏 / 移动「更多」 | 原有 |
| /catalog/groups 分组 | 管理侧栏 / 移动 dock | 原有 |
| /catalog/apps APP 管理 | 管理侧栏「交付与权限」组 / 移动「更多」；系统页 APP 下载分区（本次补） | 原有 + 本次补互链 |
| /delivery/subscriptions 订阅 | 管理侧栏 / 移动「更多」；概览统计卡 | 原有 |
| /delivery/shares 分享管理 | 管理侧栏 / 移动「更多」 | 原有 |
| /users 用户与邀请 | 管理侧栏 / 移动 dock（标签「用户」） | 原有 |
| /system 系统管理 | 管理侧栏「系统管理」组 / 移动「更多」 | 原有 |
| /account 个人中心 | 管理侧栏「账户安全」；普通用户经 /me「账户安全」行 | 原有 |
| /home 首页 | 用户侧栏 / 移动 dock | 原有 |
| /subscriptions 我的订阅 | 用户侧栏 / 移动 dock；/me「我的分享」行（同页分享管理） | 原有 |
| /nodes 我的节点 | 用户侧栏 / 移动 dock；/me 行 | 原有 |
| /apps APP 下载 | 用户侧栏 / 移动「更多」；首页空状态与 /me 行（均受总开关控制）；管理端 /catalog/apps「查看用户端」（本次补） | 原有 + 本次补 |
| /me 我的 | 用户侧栏 / 移动「更多」 | 原有 |
| /s/:token 公开分享 | 分享链接直达（公开页，含去登录衔接） | 原有 |
| /invite/:token 邀请接受 | 邀请链接直达，完成后跳 /login | 原有 |
| /setup、/register、/login | 未初始化/未登录重定向与页内互链（登录↔注册） | 原有 |
| /（根）与 * 兜底 | 按角色重定向到主页，无死路 | 原有 |

导航四处对账：管理侧栏 10 项 = 移动 dock 3 + 更多 7；用户侧栏 5 项 = 移动 dock 3 + 更多 2（APP 项两端同受总开关过滤）；系统页目录 6 分区全部有对应渲染。无单端独有入口。

## 五、表 2：功能入口清单（功能 → 入口 → 状态）

| 功能 | 入口 | 状态 |
| --- | --- | --- |
| 注册邀请码管理（生成/列表/停用） | 系统管理 → 账户与注册 → 注册邀请码 | **本次补**（原无 UI） |
| 邀请链接（按用户名邀请） | /users 创建邀请 | 原有 |
| 用户回收站（恢复/永久删除） | /use
...[truncated 2705 chars]