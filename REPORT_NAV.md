# 导航与页面归属实施报告

## 基线与交付方式

- 分支：`task/nav-structure-codex`
- 开工 HEAD 与本地 `origin/main`：`833c093340f0e7b139fab053cf00034cdbacdd70`，已包含邀请注册线
- 先读取 `BRIEF_NAV_STRUCTURE.md`，再通读 `SPEC_NAV.md`；按 Roye 最终决定，将用户、邀请、回收站合并为一个用户管理导航入口
- 原 worktree 的 Git 元数据只读；直接 fetch 无法写入 FETCH_HEAD。按 brief 使用 `/tmp/nav-structure-repo` 可写克隆提交，分支同名
- 在可写克隆中尝试从 GitHub 刷新 main，但 `github.com` DNS 解析失败，因此无法证明远端 main 在开工瞬间是否另有更新。实际实现和测试基线为上述已知提交，未擅自声称已集成后续订阅模型线
- Bundle：`/tmp/nav-structure.bundle`，包含 `task/nav-structure-codex` 分支。未 push、未 scp
- 使用逐文件 `git add -- <file>`，未使用 `git add -A`，未提交 node_modules 或构建产物。输入 brief/spec 保持原来的未跟踪状态

## 文档条目落地

| 文档要求 | 实现 |
| --- | --- |
| §1 管理端分组 | 概览单列置顶，其下资源、订阅、用户、运营、系统；订阅管理、分享管理、权益计划归订阅；工单、公告、知识库、客户端下载归运营 |
| §1 用户管理一个入口 | 侧栏只有用户管理；页内用户 `/users`、邀请 `/invites`、回收站 `/users/recycle-bin` 三个链接；复用现有用户编辑、权限调整、状态管理、密码重置、邀请、恢复和永久删除功能；回收站按路由读取 `deleted=only` |
| §1 头像菜单 | 管理员侧栏底部菜单包含账户安全、外观、退出登录；安全保留 `/account`；外观复用原主题组件，桌面与手机使用独立 popover ID；退出失败有提示；手机更多菜单提供全部分组与账号操作 |
| §1 系统设置四子页 | `/system/registration` 注册模式与邮箱域名白名单；`/system/mail` 邮件连接/测试、模板、到期提醒、群发；`/system/distribution` 平台展示与排序、面板域名、订阅域名、分享策略；`/system/status` 健康、定时任务、模块状态与迁移记录 |
| §1 设置刷新与历史 | 使用路由参数和普通 Link；刷新可直达当前子页，点击会创建浏览器历史；`/system` 默认注册；旧 section/tab/hash 定位兼容，保留其他查询参数 |
| §1 公告与下载归运营 | 新增公告主页面 `/operations/notices`；客户端下载继续使用 `/catalog/apps`，同页包含下载总开关和全部下载项编辑；开关组件从系统页抽出为 `catalog/AppDownloadsSection.tsx` |
| §1 域名分开维护 | 复用现有 `DomainSettingsSection`，面板和订阅域名仍为独立列表、独立主域名；不改 API、业务逻辑、迁移或域名门禁；沿用 `sub.warp.dpdns.org` 双主域名与 restriction 默认 false；用户订阅链接仍由现有服务使用主订阅域名生成 |
| §1 分享策略 | 分享管理的策略链接直达 `/system/distribution` |
| §2 用户四入口 | 桌面侧栏和手机底栏共用同一列表，顺序均为首页、订阅、节点、我的；移除手机更多主入口 |
| §2 首页/订阅归属 | 首页保留权益、到期、订阅状态、节点摘要、公告提示；打开订阅直达 `/subscriptions`；移除首页客户端选择/复制/导入/二维码/重置区，复用订阅页的完整操作；订阅页增加下载客户端直达入口 |
| §2 我的/帮助与支持 | 我的包含权益与计划、账户安全、通知偏好和帮助与支持；帮助收纳公告、知识库、工单、客户端下载；移除我的重置操作，统一在订阅页完成；下载开关关闭时隐藏帮助和订阅页下载入口 |
| §2 公告及详情返回 | 首页公告带 notice 参数定位并展开对应公告；知识库和工单详情原来的返回列表链接保留 |
| §3 高亮与权限 | 用户设置/帮助/详情均高亮我的；管理员工单详情、系统子页、邀请和回收站均高亮所属导航；新页面使用与旧页面相同的角色判断，原 API 权限规则未改 |
| 样式范围 | 复用已有页面、主题、控件和颜色；仅补充头像主题按钮尺寸，并将收起侧栏的组标题隐藏限定在侧栏，避免影响手机分组 |

## 旧路由兼容清单

以下现有路由均保留原有角色限制和页面功能：

- `/dashboard`
- `/catalog/nodes`、`/catalog/sources`、`/catalog/groups`
- `/delivery/subscriptions`、`/delivery/shares`、`/plans`
- `/users`、`/invites`，现在显示共同用户管理框架中的对应子页
- `/delivery/tickets`、`/delivery/tickets/:id`、`/kb/manage`
- `/catalog/apps`，现在同页维护下载开关和下载项
- `/audit-logs`、`/account`
- `/home`、`/subscriptions`、`/nodes`、`/me`
- `/apps`、`/notices`、`/kb`、`/kb/:id`、`/tickets`、`/tickets/:id`
- `/entitlement`、`/entitlements`
- 登录、注册、初始化、`/invite/:token`、`/s/:token` 等公共路由未改

`/system` 兼容映射（定位可用 `?section=`、`?tab=` 或 hash；同时接受 `/system/<旧定位>`）：

| 定位 | 目标 |
| --- | --- |
| 无定位、registration | `/system/registration` |
| mail、admin-mail | `/system/mail` |
| domain、share、distribution | `/system/distribution` |
| status | `/system/status` |
| app-downloads | `/catalog/apps` |
| notices | `/operations/notices` |

映射仅消费 section/tab 定位，保留其他有效查询参数，例如 `subscription=sub_1`。邀请/用户子页互切也保留查询参数。没有改写现有分享入口的订阅定位逻辑

## 与并行线交叉

- 订阅模型线：本线没有改 worker、API、数据库、迁移、权益或订阅模型。用户首页/我的/订阅页有页面归属调整，后续集成请保留本线入口和新模型字段
- 表单控件线：没有重做表单控件；移动后的组件仍使用基线已有控件，后续统一替换时覆盖新路径 `catalog/AppDownloadsSection.tsx`
- 订阅模板线：系统页只调整组件挂载归属，`DomainSettingsSection`、`ShareSettingsSection`、`AdminMailSection` 保持原实现；订阅分发可在四子页容器的 distribution 分支加入模板组件。下载开关已抽离，不再占用分发区
- 邀请线：保留 `/invites` 与原邀请代码组件、API和权限；只增加共同页面框架，修正其页面标题及测试描述

## 检查结果与限制

- `WRANGLER_LOG_PATH=/tmp/nav-wrangler.log npm run check`：通过（类型生成校验、TypeScript、oxlint）
- `WRANGLER_LOG_PATH=/tmp/nav-build-wrangler.log npm run build`：通过；Vite 仍提示客户端 chunk 超过 500 kB，不影响构建
- `git diff --check`：通过
- 基线 Node 聚焦集：11 文件、97 测试全部通过；本线 Node 聚焦集：12 文件、161 测试全部通过。原 97 测试全部保留，新增 64 项导航/路由/归属/角色回归
- `node development/test-invite-registration-offline.mjs`：6/6 通过
- `node development/test-pages-offline.mjs`：3/3 通过
- `node development/test-entitlements-offline.mjs`：10/10 通过
- `node development/test-admin-email-offline.mjs`：1/1 通过
- `node development/test-stage3-offline.mjs`：7/7 通过
- `node development/test-ui-user-shell.mjs`：8 个行为断言通过
- 基线与本线均尝试 `npm test`：Worker 测试运行器在启动时被 `listen EPERM 127.0.0.1` 阻止，未进入测试执行，无法建立完整 Worker 基线通过总数，也未声称全量回归通过；包括真实域名服务/备用域名下发的 Worker 集成测试仍待可运行环境验证
- `node development/test-ui-content.mjs` 和新增 `node development/test-nav-structure.mjs` 均尝试启动：Chromium 被沙箱 socket/setsockopt 权限策略阻止并 SIGTRAP 退出。未把 SSR 的路由断言冒称真实浏览器验收
- 新增浏览器脚本覆盖用户管理切换/刷新/返回、系统四子页刷新和旧定位映射、运营入口、头像安全/主题/退出、管理员手机分组、用户两端四入口、帮助高亮和角色保护；`node --check development/test-nav-structure.mjs` 通过。真实点击、浏览器历史、视口溢出和主题交互仍需在允许 Chromium 的环境执行该脚本
- SSR 聚焦集已实际验证：旧路由可渲染、新路由守卫、三子页对应选中项、四设置子页对应内容、兼容跳转目标与参数、头像菜单三操作入口、用户桌面/底栏名称顺序及帮助归属
- node_modules 原为指向只读目录的符号链接。为使 tsc/Vite 能写缓存，工作目录内将它替换成被 Git 忽略的局部目录，依赖项逐项链接到原目标，缓存留在本 worktree；未安装/升级依赖或改 lockfile

## 交付核验

提交位置为 `/tmp/nav-structure-repo` 的 `task/nav-structure-codex`，可用 `git -C /tmp/nav-structure-repo log -1` 查看提交号。原工作目录保留完整源码和此报告，原只读 Git 分支指针无法推进，应从 bundle 导入提交

使用 `git bundle create /tmp/nav-structure.bundle task/nav-structure-codex` 生成完整分支 bundle，再使用 `git bundle verify` 与 `git bundle list-heads` 核对，未向任何远端写入
