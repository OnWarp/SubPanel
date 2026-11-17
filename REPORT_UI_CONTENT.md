# UI 内容页与管理端概览交付

分支：`task/ui-content-admin-codex`
依据：`BRIEF_UI_CONTENT_ADMIN_CODEX.md` 与 `SubPanel_UI方案_v2.md` §四、§五

## 逐页改动

- 节点：通过现有 `/api/account/entitlement` 判断有效权益；无权益、过期、收回、待生效、计划停用时整页只显示 GateEmptyState 与「需要有效权益才能查看节点」。有效权益保留原列表、服务端搜索、订阅/分组筛选和分页；权益请求失败显示错误及重试，不误判为无权益
- 订阅详情：保留选择订阅、平台切换、复制、二维码、分享、兼容诊断、令牌重置的原数据与接口；增加全部可见平台的纵向链接与通栏 CopyButton，页名改为「订阅详情」。重置区域增加一行说明，保留危险按钮及确认弹窗，并给确认按钮增加危险态。增加权益页入口
- 公告：通栏搜索、通栏标题/日期/两行摘要卡片，使用原 Pagination，每页 10 条；全文通过「阅读全文」展开，避免摘要截断后无法阅读正文。搜索或无匹配时重置/限制分页
- 工单：用户列表替换为纵向卡片，保留标题链接、等级、最后回复人和时间；使用 StatusPill 映射待回复/已回复/已关闭。共享详情回复流也改用状态胶囊，原底部回复框、关闭确认及接口保持
- 权益：新增 `/entitlements` 页面，由订阅详情入口进入。当前权益大卡展示计划、到期、配额、限速和设备数；PlanCard 墙展示可从现有用户 API 得到的计划，当前权益高亮并标记「使用中」，不含购买按钮；过期等状态展示最近权益与真实状态
- 管理端概览：文本页头下新增 StatCard 行，总用户采用用户 API 的 `total`；完整拉取用户分页后，通过已有逐用户权益 API 统计有效权益和未来 7 日内到期权益；并发限制为每批 8 个请求。待处理工单采用现有队列 `status=open` 的 `total`（所有未关闭工单，卡片副文案明确口径）。权益或工单 API 不可用时省略对应卡片，不显示伪造的 0

## 数据缺口与省略

- **完整计划目录无法在本次约束内实现**：基线只有管理员 `/api/admin/plans`，用户权益 API 只提供 current/latest 的计划，没有普通用户可调用的计划列表 API。因此计划墙仅展示真实可得的当前/最近计划，未调用管理员接口、未编造其他计划，未新增后端接口。要展示其他全部计划，需要后续后端提供用户可见目录，此项没有声称全部完成
- 公告 API `/api/notices` 不支持服务端搜索参数，因此基于该 API 返回的全部可见公告做前端标题/正文过滤与分页
- 管理端统计无固定省略项；若任意用户权益请求失败，两张权益统计卡一并省略，防止部分样本被当作全量；工单队列失败独立省略工单卡
- 待处理工单按现有队列支持的 open 状态计数，包含已回复但未关闭的工单

## 检查结果

- `XDG_CONFIG_HOME=/tmp/ui3-config npm run check`：通过（Wrangler types、TypeScript、oxlint）
- `XDG_CONFIG_HOME=/tmp/ui3-config npm run build`：通过，Worker 与客户端产物均生成
- `node development/test-entitlements-offline.mjs`：10/10 通过，覆盖权益状态、有效时间边界、授权、计划变更、订阅过滤等现有离线回归
- `XDG_CONFIG_HOME=/tmp/ui3-config npm test`：启动失败，`listen EPERM ... 127.0.0.1`，未执行全量 Worker 测试，无法在本沙箱确认基线 397 条全部通过；未删除或修改原测试
- `node development/test-ui-content.mjs`：新增可复用的构建产物浏览器检查，使用拦截 API，覆盖五种节点门槛、有效列表、公告搜索/分页/全文、工单三态/回复框、权益卡、平台链接/重置确认、跨页用户统计/部分失败/手机溢出；本沙箱 Chromium 启动即因 socket `Operation not permitted` 退出，断言未执行，不计为通过。集成时先 build 再运行，可用 `CHROMIUM_PATH` 指定浏览器
- 尝试无 Worker 的 Vite 服务也因 localhost EPERM 无法启动，未完成真实浏览器视觉检查
- `git diff --check`：通过

初始 check/build/test 还遇到 node_modules 符号链接目标只读导致缓存写入失败；验证时临时使用逐项符号链接并提供本地可写缓存，依赖版本、锁文件未改变，完成后恢复原 node_modules 符号链接。Wrangler 日志路径通过 XDG_CONFIG_HOME 放入 /tmp

## 变更边界与交付

没有修改颜色令牌、后端、迁移、API 口径或线二的页头/侧栏/首页/个人中心结构。样式只在 pages-tickets.css 末尾追加本线类名，沿用现有颜色与圆角令牌

提交包含实现、浏览器回归脚本和本报告；输入 brief 与方案文件保留为原有未跟踪文件。逐个文件 git add，未使用 git add -A

交付 bundle：`/tmp/ui-content-admin.bundle`，包含当前分支历史；不 push/scp。集成时必须复验全量 Worker 测试与浏览器脚本，并解决用户计划目录的数据缺口

## Git 元数据权限限制

当前 worktree 的 `.git` 指向 `/data/workspace/subpanel-codex/.git/worktrees/subpanel-ui3c`，位于沙箱只读范围；逐文件 git add 与 commit 均因 index.lock 的 EROFS 失败。因此在 `/tmp/ui-content-admin-commit` 建立独立可写克隆，在同名 `task/ui-content-admin-codex` 分支提交当前工作树文件并生成 bundle。原 worktree 分支指针无法更新；交付提交保存在该克隆及 bundle 中，集成时从 bundle 导入。此限制没有通过修改受保护 Git 元数据绕过
