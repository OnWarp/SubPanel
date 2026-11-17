# 用户端外壳与首页 UI v2 交付报告

## 范围与逐页改动

- 首页：PageHero、公告轮播、权益/订阅/分组节点三张 StatCard、我的订阅大卡、五类 QuickEntryCard；大卡保留平台切换，加入双通栏复制/导入按钮和右侧二维码
- 节点、订阅、公告、工单列表与详情、APP 下载：仅将 PageHeader 换为 PageHero，保留既有正文与操作；工单新建等主操作仍在页头
- 权益：基线没有独立用户权益页面，增加 `/entitlement`，只用 PageHero 包装现有 EntitlementInfo，不改其内容；侧栏账号菜单提供入口
- 个人中心：`/me` 与用户 `/account` 共用双栏布局，左侧账户信息、通知、订阅操作，右侧安全；密码、邮箱绑定/更换、会话及退出全部设备复用 AccountPage；用户页不再使用原 iOS 入口列表与 security-section 样式
- 登录/注册：密码与确认密码分别可见切换，保留自动填充与校验；首字段自动聚焦、自然 DOM 焦点序和表单回车提交；错误在对应字段下显示，登录失败/注册校验失败后聚焦相关字段
- 用户侧栏底部：头像、邮箱（未绑定时用户名）和展开箭头；账号菜单聚合个人中心、权益、安全/通知、退出，退出调用原 logout；支持键盘打开和 Escape 关闭
- 移动端维持首页/节点/订阅/更多四格底栏；新增内容在窄屏堆叠
- 管理端页头与侧栏身份区保留；共享 AccountPage 默认参数保持原管理端结构；配色和圆角令牌无修改，后端/API/迁移无修改

## 数据与行为接线

- `/api/notices`：首页轮播，点击前往公告页；接口失败沿用隐藏公告处理
- `/api/account/entitlement`：计划名、到期、状态、剩余天数/实际起止周期进度；过期卡红色警告，无权益显示未开通
- `/api/account/subscriptions`：真实订阅链接、状态、客户端平台；无订阅/未配域名显示空态，不制造链接
- `/api/user/nodes?page=1&pageSize=1`：用 total 和 groupOptions 统计可用节点/分组，无有效权益强制显示 0；未取第一页节点数冒充总数
- 平台显示沿用 useEnabledPlatforms/orderLinkEntries/pickPrimaryLink；二维码由当前平台链接生成；导入通过客户端协议传入真实链接，支持 Clash/Mihomo/Clash Meta、Stash、Surge、Loon、Shadowrocket；自动识别与未实现协议的平台禁用导入并提示手动添加
- `/api/account/profile`：邮箱、头像、当前会话；密码、邮箱、退出全部会话使用现有实现
- 重置订阅弹窗先加载真实订阅并允许选择，确认后 POST `/api/account/subscriptions/:id/token/reset`；首页重新加载并更新链接与二维码；失败保留弹窗显示错误
- 基线无通知偏好 API，且禁止新增后端：到期提醒采用按用户 ID 隔离的 localStorage 设置，默认关闭；明确文案「仅保存在此浏览器，权益到期前 7 天在首页提醒」；不宣称邮件/系统通知，保存失败显示错误

## 验证

- `npm run check`：通过（wrangler 类型检查、TypeScript、oxlint）
- `npm run build`：通过（Worker 与客户端生产构建）
- `node development/test-entitlements-offline.mjs`：10/10 通过
- `node development/test-ui-user-shell.mjs`：8 项行为断言通过，覆盖带查询参数/Unicode 的导入编码、未知平台和空链接、Shadowrocket UTF-8 往返、存储不可用默认值、账号偏好隔离与关闭
- `git diff --check`：通过
- `npm test`：已尝试；Vitest/Workers 启动时 localhost listen 被沙箱拒绝（EPERM），未进入测试执行，不能声称基线 397 项全量已验证；集成环境需全量复验
- `npm run dev -- --host 127.0.0.1`：已尝试；Cloudflare 插件 uv_interface_addresses 被沙箱拒绝，未能进行浏览器交互、深浅主题与响应式视觉验证
- 真实客户端的协议唤起、浏览器剪贴板权限、真实账号的密码/邮箱/登出与重置流程尚需集成验证

## 沙箱与交付

- 原 node_modules 符号链接指向只读依赖，导致 TypeScript/Vite 无法写构建缓存；本地改为逐项符号链接依赖的忽略目录，仅缓存目录可写，未纳入提交；完成后还原原链接
- Wrangler 日志通过 WRANGLER_LOG_PATH 指向 /tmp，XDG_CONFIG_HOME 指向 /tmp，避免只读用户配置目录
- 原 worktree Git 元数据位于只读 /data/workspace/subpanel-codex/.git/worktrees/subpanel-ui2，git add/commit 创建 index.lock 被拒绝；因此将原仓库完整复制为 /tmp/ui-user-shell.git，以当前工作目录为 work tree，在副本的 task/ui-user-shell-codex 分支逐文件暂存提交并创建 bundle；原 worktree 分支指针仍为基线，集成时从 bundle 获取交付提交
- 未使用 git add -A，不 push/scp
- Bundle：`/tmp/ui-user-shell.bundle`，包含本分支完整历史；以 `git bundle verify` 验证
- 任务输入 BRIEF_UI_USER_SHELL.md 与 SubPanel_UI方案_v2.md 保持原样，不纳入实现提交
